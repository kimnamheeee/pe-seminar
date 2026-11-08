import { action } from "./_generated/server";
import { v } from "convex/values";

// 경로 후보 조회 (Kakao 대중교통 API)
export const getRoutes = action({
  args: {
    origin: v.object({ lat: v.number(), lng: v.number() }),
    destination: v.object({ lat: v.number(), lng: v.number() }),
  },
  handler: async (ctx, args): Promise<Route[]> => {
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
      headers: {
        Authorization: `KakaoAK ${apiKey}`,
      },
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Kakao API 오류: ${response.status} - ${body}`);
    }

    const data = await response.json();

    if (!data.routes || data.routes.length === 0) {
      return [];
    }

    // 순수 버스 경로만 필터링 (지하철 포함 경로 제외)
    const busOnlyRoutes = data.routes.filter((route: KakaoRoute) => {
      const steps = loadSteps(route);
      return steps.every(
        (step: KakaoStep) =>
          step.properties?.type === "WALKING" || step.properties?.type === "BUS"
      );
    });

    // 경로 데이터 변환
    return busOnlyRoutes.map((route: KakaoRoute, index: number) => {
      const steps = loadSteps(route);
      const legs = extractLegs(route);
      const totalTime = route.properties?.totalTime || 0;
      const stepsTime = steps.reduce((sum, s) => sum + (s.properties?.time || 0), 0);
      const walkTime = Math.max(0, totalTime - stepsTime); // 암묵적 도보 시간

      return {
        id: String(index),
        summary: {
          duration: Math.round(totalTime / 60), // 초 → 분
          busCount: countBusLegs(route),
          walkTime: Math.round(walkTime / 60), // 도보 시간 (분)
          transfers: route.properties?.transfers || 0,
        },
        legs,
        polyline: extractPolyline(route),
      };
    });
  },
});

// steps 추출 (route.steps 또는 route.legs[].steps)
function loadSteps(route: KakaoRoute): KakaoStep[] {
  return route.steps ?? route.legs?.flatMap((leg) => leg.steps ?? []) ?? [];
}

// 버스 구간 수 계산
function countBusLegs(route: KakaoRoute): number {
  return loadSteps(route).filter(
    (step: KakaoStep) => step.properties?.type === "BUS"
  ).length;
}

// 구간 정보 추출
function extractLegs(route: KakaoRoute): Leg[] {
  return loadSteps(route).map((step: KakaoStep) => {
    const type = step.properties?.type === "WALKING" ? "WALK" : "BUS";
    const stops = step.properties?.stops || [];

    // 이 구간의 폴리라인 추출
    const polyline: Array<{ lat: number; lng: number }> = [];
    const points = step.path?.points || [];
    for (const point of points) {
      if (Array.isArray(point) && point.length >= 2) {
        const x = Number(point[0]);
        const y = Number(point[1]);
        if (Number.isFinite(x) && Number.isFinite(y)) {
          polyline.push({ lat: y, lng: x });
        }
      }
    }

    const leg: Leg = {
      type: type as "WALK" | "BUS",
      startName: stops[0]?.name || "",
      endName: stops[stops.length - 1]?.name || "",
      time: Math.round((step.properties?.time || 0) / 60), // 초 → 분
      distance: step.properties?.distance || 0, // 미터
      polyline,
    };

    if (type === "BUS" && step.properties) {
      // vehicles 배열에서 버스 번호 추출
      const vehicle = step.properties.vehicles?.[0];
      leg.busInfo = {
        busNo: vehicle?.name || "",
        busType: vehicle?.type || "", // 간선, 지선 등
      };
      // 정류장 정보 추출 (Kakao API는 정류장 좌표를 제공하지 않음)
      leg.stations = stops.map((stop: KakaoStop) => ({
        name: stop.name || "",
        lat: 0,
        lng: 0,
      }));
    }

    return leg;
  });
}

// 경로 좌표 추출
function extractPolyline(route: KakaoRoute): Array<{ lat: number; lng: number }> {
  const coords: Array<{ lat: number; lng: number }> = [];

  for (const step of loadSteps(route)) {
    const points = step.path?.points || [];
    for (const point of points) {
      if (Array.isArray(point) && point.length >= 2) {
        const x = Number(point[0]);
        const y = Number(point[1]);
        if (Number.isFinite(x) && Number.isFinite(y)) {
          coords.push({ lat: y, lng: x });
        }
      }
    }
  }

  return coords;
}

// 타입 정의
interface KakaoRoute {
  properties?: {
    totalTime?: number;
    transfers?: number;
    type?: string;
  };
  steps?: KakaoStep[];
  legs?: Array<{ steps?: KakaoStep[] }>;
}

interface KakaoStep {
  properties?: {
    type?: string;
    distance?: number;
    time?: number;
    guidance?: string;
    stops?: KakaoStop[];
    vehicles?: Array<{
      name?: string;
      type?: string;
    }>;
  };
  path?: {
    points?: Array<[number, number]>;
  };
}

interface KakaoStop {
  name?: string;
  x?: number;
  y?: number;
  longitude?: number;
  latitude?: number;
  lng?: number;
  lat?: number;
}

interface Route {
  id: string;
  summary: {
    duration: number; // 총 소요시간 (분)
    busCount: number; // 버스 구간 수
    walkTime: number; // 도보 시간 (분)
    transfers: number; // 환승 횟수
  };
  legs: Leg[];
  polyline: Array<{ lat: number; lng: number }>;
}

interface Leg {
  type: "WALK" | "BUS";
  startName: string;
  endName: string;
  time: number; // 소요시간 (분)
  distance: number; // 거리 (미터)
  polyline: Array<{ lat: number; lng: number }>; // 구간 경로 좌표
  busInfo?: {
    busNo: string;
    busType: string; // 간선, 지선 등
  };
  stations?: Array<{
    name: string;
    lat: number;
    lng: number;
  }>;
}
