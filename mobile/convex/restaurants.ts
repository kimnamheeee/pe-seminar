import { action } from "./_generated/server";
import { v } from "convex/values";

// 식당 목록 조회 (Kakao Local API)
export const getRestaurants = action({
  args: {
    routeCoords: v.array(v.object({ lat: v.number(), lng: v.number() })),
  },
  handler: async (ctx, args): Promise<Restaurant[]> => {
    const apiKey = process.env.KAKAO_REST_API_KEY;
    if (!apiKey) {
      throw new Error("KAKAO_REST_API_KEY 환경변수가 설정되지 않았습니다.");
    }

    if (args.routeCoords.length === 0) {
      return [];
    }

    // 5km 격자 중심점 계산
    const gridCenters = calculateGridCenters(args.routeCoords, 5000);

    // 각 격자에서 Kakao Local API 호출
    const allRestaurants: KakaoPlace[] = [];
    const seenIds = new Set<string>();

    for (const center of gridCenters) {
      const places = await searchRestaurantsAt(apiKey, center.lat, center.lng);
      for (const place of places) {
        if (!seenIds.has(place.id)) {
          seenIds.add(place.id);
          allRestaurants.push(place);
        }
      }
    }

    // 경로선에서 1km 이내 필터링
    const filtered = allRestaurants.filter((restaurant) => {
      const dist = minDistanceToRoute(
        { lat: restaurant.y, lng: restaurant.x },
        args.routeCoords
      );
      return dist <= 1000;
    });

    // 거리순 정렬
    const withDistance = filtered.map((restaurant) => ({
      ...restaurant,
      distanceFromRoute: minDistanceToRoute(
        { lat: restaurant.y, lng: restaurant.x },
        args.routeCoords
      ),
    }));

    withDistance.sort((a, b) => a.distanceFromRoute - b.distanceFromRoute);

    // 결과 변환
    return withDistance.map((r) => ({
      id: r.id,
      name: r.place_name,
      category: extractCategory(r.category_name),
      address: r.road_address_name || r.address_name,
      lat: r.y,
      lng: r.x,
      distanceFromRoute: Math.round(r.distanceFromRoute),
    }));
  },
});

// Kakao Local API로 음식점 검색
async function searchRestaurantsAt(
  apiKey: string,
  lat: number,
  lng: number
): Promise<KakaoPlace[]> {
  const results: KakaoPlace[] = [];

  // 최대 3페이지까지 조회 (페이지당 15개, 최대 45개)
  for (let page = 1; page <= 3; page++) {
    const url = new URL(
      "https://dapi.kakao.com/v2/local/search/category.json"
    );
    url.searchParams.set("category_group_code", "FD6"); // 음식점
    url.searchParams.set("x", String(lng));
    url.searchParams.set("y", String(lat));
    url.searchParams.set("radius", "2500"); // 2.5km (5km 격자의 절반)
    url.searchParams.set("page", String(page));
    url.searchParams.set("size", "15");

    const response = await fetch(url.toString(), {
      headers: {
        Authorization: `KakaoAK ${apiKey}`,
      },
    });

    if (!response.ok) {
      console.error(`Kakao API 오류: ${response.status}`);
      break;
    }

    const data = await response.json();
    results.push(...data.documents);

    if (data.meta.is_end) {
      break;
    }
  }

  return results;
}

// 5km 격자 중심점 계산
function calculateGridCenters(
  coords: Array<{ lat: number; lng: number }>,
  gridSize: number
): Array<{ lat: number; lng: number }> {
  if (coords.length === 0) return [];

  // 경로의 바운딩 박스 계산
  let minLat = coords[0].lat;
  let maxLat = coords[0].lat;
  let minLng = coords[0].lng;
  let maxLng = coords[0].lng;

  for (const coord of coords) {
    minLat = Math.min(minLat, coord.lat);
    maxLat = Math.max(maxLat, coord.lat);
    minLng = Math.min(minLng, coord.lng);
    maxLng = Math.max(maxLng, coord.lng);
  }

  // 위도/경도를 미터로 변환 (대략적인 값)
  const latDegPerMeter = 1 / 111000;
  const lngDegPerMeter = 1 / (111000 * Math.cos((minLat * Math.PI) / 180));

  const gridLatSize = gridSize * latDegPerMeter;
  const gridLngSize = gridSize * lngDegPerMeter;

  const centers: Array<{ lat: number; lng: number }> = [];

  for (let lat = minLat; lat <= maxLat + gridLatSize; lat += gridLatSize) {
    for (let lng = minLng; lng <= maxLng + gridLngSize; lng += gridLngSize) {
      centers.push({ lat, lng });
    }
  }

  return centers;
}

// 점에서 경로까지의 최소 거리 (미터)
function minDistanceToRoute(
  point: { lat: number; lng: number },
  route: Array<{ lat: number; lng: number }>
): number {
  let minDist = Infinity;

  for (let i = 0; i < route.length - 1; i++) {
    const dist = pointToSegmentDistance(point, route[i], route[i + 1]);
    minDist = Math.min(minDist, dist);
  }

  // 경로가 1개 점인 경우
  if (route.length === 1) {
    return haversineDistance(point, route[0]);
  }

  return minDist;
}

// 점에서 선분까지의 거리
function pointToSegmentDistance(
  point: { lat: number; lng: number },
  segStart: { lat: number; lng: number },
  segEnd: { lat: number; lng: number }
): number {
  const d1 = haversineDistance(point, segStart);
  const d2 = haversineDistance(point, segEnd);
  const segLen = haversineDistance(segStart, segEnd);

  if (segLen === 0) return d1;

  // 투영점 계산 (간소화된 버전)
  const t = Math.max(
    0,
    Math.min(
      1,
      ((point.lat - segStart.lat) * (segEnd.lat - segStart.lat) +
        (point.lng - segStart.lng) * (segEnd.lng - segStart.lng)) /
        (segLen * segLen / 111000 / 111000)
    )
  );

  const proj = {
    lat: segStart.lat + t * (segEnd.lat - segStart.lat),
    lng: segStart.lng + t * (segEnd.lng - segStart.lng),
  };

  return haversineDistance(point, proj);
}

// Haversine 거리 계산 (미터)
function haversineDistance(
  p1: { lat: number; lng: number },
  p2: { lat: number; lng: number }
): number {
  const R = 6371000; // 지구 반경 (미터)
  const dLat = ((p2.lat - p1.lat) * Math.PI) / 180;
  const dLng = ((p2.lng - p1.lng) * Math.PI) / 180;
  const lat1 = (p1.lat * Math.PI) / 180;
  const lat2 = (p2.lat * Math.PI) / 180;

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return R * c;
}

// 카테고리에서 음식 종류만 추출
function extractCategory(categoryName: string): string {
  // "음식점 > 한식 > 백반" → "한식"
  const parts = categoryName.split(" > ");
  return parts[1] || parts[0] || "";
}

// 타입 정의
interface KakaoPlace {
  id: string;
  place_name: string;
  category_name: string;
  address_name: string;
  road_address_name: string;
  x: number; // 경도
  y: number; // 위도
}

interface Restaurant {
  id: string;
  name: string;
  category: string;
  address: string;
  lat: number;
  lng: number;
  distanceFromRoute: number;
}
