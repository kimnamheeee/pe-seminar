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

    const url = new URL(
      "https://apis-navi.kakaomobility.com/v1/directions/public-transit"
    );
    url.searchParams.set("origin", `${args.origin.lng},${args.origin.lat}`);
    url.searchParams.set(
      "destination",
      `${args.destination.lng},${args.destination.lat}`
    );

    const response = await fetch(url.toString(), {
      headers: {
        Authorization: `KakaoAK ${apiKey}`,
      },
    });

    if (!response.ok) {
      throw new Error(`Kakao API 오류: ${response.status}`);
    }

    const data = await response.json();

    if (!data.routes || data.routes.length === 0) {
      return [];
    }

    // 순수 버스 경로만 필터링 (지하철 포함 경로 제외)
    const busOnlyRoutes = data.routes.filter((route: KakaoRoute) => {
      const sections = route.sections || [];
      return sections.every(
        (section: KakaoSection) =>
          section.type === "WALK" || section.type === "BUS"
      );
    });

    // 경로 데이터 변환
    return busOnlyRoutes.map((route: KakaoRoute, index: number) => ({
      id: String(index),
      summary: {
        duration: Math.round(route.summary.duration / 60), // 초 → 분
        busCount: countBusLegs(route),
        walkDistance: calculateWalkDistance(route),
      },
      legs: extractLegs(route),
      polyline: extractPolyline(route),
    }));
  },
});

// 버스 구간 수 계산
function countBusLegs(route: KakaoRoute): number {
  return (route.sections || []).filter(
    (section: KakaoSection) => section.type === "BUS"
  ).length;
}

// 총 도보 거리 계산
function calculateWalkDistance(route: KakaoRoute): number {
  return (route.sections || [])
    .filter((section: KakaoSection) => section.type === "WALK")
    .reduce((sum: number, section: KakaoSection) => sum + (section.distance || 0), 0);
}

// 구간 정보 추출
function extractLegs(route: KakaoRoute): Leg[] {
  return (route.sections || []).map((section: KakaoSection) => {
    const leg: Leg = {
      type: section.type as "WALK" | "BUS",
      startName: section.start?.name || "",
      endName: section.end?.name || "",
    };

    if (section.type === "BUS" && section.route) {
      leg.busInfo = {
        busNo: section.route.name || "",
        busType: section.route.type || "",
      };
      leg.stations = (section.stations || []).map((station: KakaoStation) => ({
        name: station.name,
        lat: station.y,
        lng: station.x,
      }));
    }

    return leg;
  });
}

// 경로 좌표 추출
function extractPolyline(route: KakaoRoute): Array<{ lat: number; lng: number }> {
  const coords: Array<{ lat: number; lng: number }> = [];

  for (const section of route.sections || []) {
    if (section.polyline) {
      // Kakao는 "lng,lat lng,lat" 형식의 문자열을 반환
      const points = section.polyline.split(" ");
      for (const point of points) {
        const [lng, lat] = point.split(",").map(Number);
        if (!isNaN(lat) && !isNaN(lng)) {
          coords.push({ lat, lng });
        }
      }
    }
  }

  return coords;
}

// 타입 정의
interface KakaoRoute {
  summary: {
    duration: number;
  };
  sections?: KakaoSection[];
}

interface KakaoSection {
  type: string;
  distance?: number;
  polyline?: string;
  start?: { name: string };
  end?: { name: string };
  route?: {
    name: string;
    type: string;
  };
  stations?: KakaoStation[];
}

interface KakaoStation {
  name: string;
  x: number;
  y: number;
}

interface Route {
  id: string;
  summary: {
    duration: number;
    busCount: number;
    walkDistance: number;
  };
  legs: Leg[];
  polyline: Array<{ lat: number; lng: number }>;
}

interface Leg {
  type: "WALK" | "BUS";
  startName: string;
  endName: string;
  busInfo?: {
    busNo: string;
    busType: string;
  };
  stations?: Array<{
    name: string;
    lat: number;
    lng: number;
  }>;
}
