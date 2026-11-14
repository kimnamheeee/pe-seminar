import { action } from "./_generated/server";
import { v } from "convex/values";

const routeSearchArgs = {
  origin: v.object({ lat: v.number(), lng: v.number() }),
  destination: v.object({ lat: v.number(), lng: v.number() }),
};

// Keep the original array response for already-installed app builds.
export const getRoutes = action({
  args: routeSearchArgs,
  handler: async (_ctx, args): Promise<Route[]> => {
    return (await searchRoutes(args)).routes;
  },
});

// New clients use this endpoint to distinguish an empty route set from routes
// that all exceed the 60-minute limit.
export const getRoutesWithStatus = action({
  args: routeSearchArgs,
  handler: async (_ctx, args): Promise<RouteSearchResult> => searchRoutes(args),
});

async function searchRoutes(args: {
  origin: Coordinate;
  destination: Coordinate;
}): Promise<RouteSearchResult> {
    const apiKey = process.env.KAKAO_REST_API_KEY;
    if (!apiKey) {
      throw new Error("KAKAO_REST_API_KEY 환경변수가 설정되지 않았습니다.");
    }

    const url = new URL("https://dapi.kakao.com/v2/routing/publictraffic");
    url.searchParams.set("start_x", String(args.origin.lng));
    url.searchParams.set("start_y", String(args.origin.lat));
    url.searchParams.set("end_x", String(args.destination.lng));
    url.searchParams.set("end_y", String(args.destination.lat));

    const response = await fetch(url.toString(), {
      headers: { Authorization: `KakaoAK ${apiKey}` },
    });
    if (!response.ok) {
      throw new Error(`Kakao API 오류: ${response.status}`);
    }

    const data: unknown = await response.json();
    if (!isRecord(data) || !Array.isArray(data.routes)) {
      throw new Error("Kakao 경로 검색 응답 형식이 올바르지 않습니다.");
    }
    if (data.routes.length === 0) {
      return { status: "NO_ROUTES", routes: [] };
    }

    const routes = data.routes.flatMap((value: unknown, index: number) => {
      if (!isRecord(value)) {
        throw new Error("Kakao 경로 검색 응답 형식이 올바르지 않습니다.");
      }
      const route = value as KakaoRoute;
      const steps = loadSteps(route);
      const totalTime = route.properties?.totalTime;
      if (typeof totalTime !== "number" || !Number.isFinite(totalTime)) {
        throw new Error("Kakao 경로 검색 응답에 소요 시간이 없습니다.");
      }
      if (totalTime >= 60 * 60) return [];
      const stepsTime = steps.reduce(
        (sum, step) => sum + (step.properties?.time ?? 0),
        0
      );

      return [{
        id: String(index),
        routeType: getRouteType(route, steps),
        summary: {
          duration: Math.round(totalTime / 60),
          busCount: countSteps(steps, "BUS"),
          subwayCount: countSteps(steps, "SUBWAY"),
          walkTime: Math.round(Math.max(0, totalTime - stepsTime) / 60),
          transfers: route.properties?.transfers ?? 0,
        },
        legs: extractLegs(route),
        polyline: extractPolyline(route),
      }];
    });

    if (routes.length === 0) {
      return { status: "ALL_TOO_LONG", routes: [] };
    }

    return { status: "FOUND", routes };
}

function loadSteps(route: KakaoRoute): KakaoStep[] {
  return route.steps ?? route.legs?.flatMap((leg) => leg.steps ?? []) ?? [];
}

function countSteps(steps: KakaoStep[], type: "BUS" | "SUBWAY"): number {
  return steps.filter((step) => step.properties?.type === type).length;
}

function getRouteType(
  route: KakaoRoute,
  steps: KakaoStep[]
): Route["routeType"] {
  const routeType = route.properties?.type;
  if (
    routeType === "BUS" ||
    routeType === "SUBWAY" ||
    routeType === "BUS_AND_SUBWAY"
  ) {
    return routeType;
  }

  const hasBus = steps.some((step) => step.properties?.type === "BUS");
  const hasSubway = steps.some((step) => step.properties?.type === "SUBWAY");
  if (hasBus && hasSubway) return "BUS_AND_SUBWAY";
  if (hasSubway) return "SUBWAY";
  return "BUS";
}

function extractLegs(route: KakaoRoute): Leg[] {
  return loadSteps(route).map((step) => {
    const stepType = step.properties?.type;
    if (stepType !== "WALKING" && stepType !== "BUS" && stepType !== "SUBWAY") {
      throw new Error(
        `지원하지 않는 대중교통 단계 유형입니다: ${stepType || "unknown"}`
      );
    }

    const type = stepType === "WALKING" ? "WALK" : stepType;
    const stops = step.properties?.stops ?? [];
    const polyline = extractStepPolyline(step);
    const leg: Leg = {
      type,
      startName: stops[0]?.name ?? "",
      endName: stops[stops.length - 1]?.name ?? "",
      time: Math.round((step.properties?.time ?? 0) / 60),
      distance: step.properties?.distance ?? 0,
      polyline,
    };

    if (type !== "WALK") {
      const vehicle = step.properties?.vehicles?.[0];
      leg.vehicleInfo = {
        name: vehicle?.name ?? "",
        type: vehicle?.type ?? "",
      };
      // Kakao 정류장 단계는 이름만 제공하므로 좌표는 mode별 DB에서 찾는다.
      leg.stations = stops.map((stop) => ({ name: stop.name ?? "" }));
    }

    return leg;
  });
}

function extractStepPolyline(step: KakaoStep): Coordinate[] {
  const coordinates: Coordinate[] = [];
  for (const point of step.path?.points ?? []) {
    if (point.length < 2) continue;
    const lng = Number(point[0]);
    const lat = Number(point[1]);
    if (Number.isFinite(lat) && Number.isFinite(lng)) {
      coordinates.push({ lat, lng });
    }
  }
  return coordinates;
}

function extractPolyline(route: KakaoRoute): Coordinate[] {
  return loadSteps(route).flatMap(extractStepPolyline);
}

interface Coordinate {
  lat: number;
  lng: number;
}

interface KakaoRoute {
  properties?: {
    totalTime?: number;
    transfers?: number;
    type?: "BUS" | "SUBWAY" | "BUS_AND_SUBWAY";
  };
  steps?: KakaoStep[];
  legs?: Array<{ steps?: KakaoStep[] }>;
}

interface KakaoStep {
  properties?: {
    type?: "WALKING" | "BUS" | "SUBWAY";
    distance?: number;
    time?: number;
    stops?: KakaoStop[];
    vehicles?: Array<{ name?: string; type?: string }>;
  };
  path?: { points?: Array<[number, number]> };
}

interface KakaoStop {
  name?: string;
}

interface Route {
  id: string;
  routeType: "BUS" | "SUBWAY" | "BUS_AND_SUBWAY";
  summary: {
    duration: number;
    busCount: number;
    subwayCount: number;
    walkTime: number;
    transfers: number;
  };
  legs: Leg[];
  polyline: Coordinate[];
}

interface RouteSearchResult {
  status: "FOUND" | "NO_ROUTES" | "ALL_TOO_LONG";
  routes: Route[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

interface Leg {
  type: "WALK" | "BUS" | "SUBWAY";
  startName: string;
  endName: string;
  time: number;
  distance: number;
  polyline: Coordinate[];
  vehicleInfo?: { name: string; type: string };
  stations?: Array<{ name: string }>;
}
