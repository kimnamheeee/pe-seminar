import { api } from "./_generated/api";
import { action } from "./_generated/server";
import { v } from "convex/values";
import { isRouteWithinSeoul } from "./seoulBoundary";

// 식당 목록 조회 (Kakao Local API)
export const getRestaurants = action({
  args: {
    routeCoords: v.array(v.object({ lat: v.number(), lng: v.number() })),
  },
  handler: async (ctx, args): Promise<Restaurant[]> => {
    return searchRestaurantsOnRoute(args.routeCoords);
  },
});

const stopMatchingArgs = {
  restaurants: v.array(v.object({
    id: v.string(), lat: v.number(), lng: v.number(), routeProgress: v.number(),
  })),
  legs: v.array(v.object({
    type: v.union(v.literal("WALK"), v.literal("BUS"), v.literal("SUBWAY")),
    startProgress: v.number(),
    polyline: v.array(v.object({ lat: v.number(), lng: v.number() })),
    stations: v.array(v.object({ name: v.string() })),
  })),
};

type StopMatch = {
  found: boolean;
  stop?: { mode: "BUS" | "SUBWAY"; name: string; lat: number; lng: number; distanceFromRestaurant: number; distanceFromRoute: number };
  stopLegIndex?: number;
};

// New clients receive restaurant candidates and their stop matches together.
// Unmatched restaurants remain visible; a matched restaurant at 400m+ is excluded.
export const getRestaurantsWithStops = action({
  args: {
    routeCoords: v.array(v.object({ lat: v.number(), lng: v.number() })),
    legs: stopMatchingArgs.legs,
  },
  handler: async (ctx, args) => {
    const restaurants = await searchRestaurantsOnRoute(args.routeCoords);
    const isWithinSeoul = isRouteWithinSeoul(args.routeCoords);
    if (!isWithinSeoul) {
      const stops = Object.fromEntries(restaurants.map((restaurant) => [restaurant.id, { found: false }])) as Record<string, StopMatch>;
      return { restaurants, stops, alightingLimitedReason: "OUTSIDE_SEOUL" as const };
    }
    if (restaurants.length === 0) {
      return { restaurants, stops: {} as Record<string, StopMatch>, alightingLimitedReason: null };
    }

    const stops: Record<string, StopMatch> = await ctx.runQuery(
      api.transitStops.getNearestStopsForRestaurants,
      { restaurants: restaurants.map(({ id, lat, lng, routeProgress }) => ({ id, lat, lng, routeProgress })), legs: args.legs }
    );
    const eligible = restaurants.filter((restaurant) => {
      const match = stops[restaurant.id];
      return !match?.found || !match.stop || match.stop.distanceFromRestaurant < 400;
    });
    const eligibleStops: Record<string, StopMatch> = {};
    for (const restaurant of eligible) eligibleStops[restaurant.id] = stops[restaurant.id] ?? { found: false };
    return { restaurants: eligible, stops: eligibleStops, alightingLimitedReason: null };
  },
});

async function searchRestaurantsOnRoute(routeCoords: Array<{ lat: number; lng: number }>): Promise<Restaurant[]> {
    const route = routeCoords;
    const apiKey = process.env.KAKAO_REST_API_KEY;
    if (!apiKey) {
      throw new Error("KAKAO_REST_API_KEY 환경변수가 설정되지 않았습니다.");
    }

    if (route.length === 0) {
      return [];
    }

    // 경로를 따라 500m 간격으로 샘플 포인트 생성
    const samplePoints = sampleAlongRoute(route, 500);

    // 각 샘플 포인트에서 300m 반경 식당 검색
    const allRestaurants: Array<KakaoPlace & { sampleIndex: number }> = [];
    const seenIds = new Set<string>();

    for (let i = 0; i < samplePoints.length; i++) {
      const point = samplePoints[i];
      const places = await searchRestaurantsAt(apiKey, point.lat, point.lng, 300);
      for (const place of places) {
        if (!seenIds.has(place.id)) {
          seenIds.add(place.id);
          allRestaurants.push({ ...place, sampleIndex: i });
        }
      }
    }

    // 경로선에서 200m 이내만 필터링 + 경로상 위치(progress) 계산
    const MAX_DISTANCE = 200;
    const withProgress = allRestaurants
      .map((restaurant) => {
        const coord = { lat: Number(restaurant.y), lng: Number(restaurant.x) };
        const { distance, progress } = getRouteDistanceAndProgress(coord, route);
        return { ...restaurant, distanceFromRoute: distance, routeProgress: progress };
      })
      .filter((r) => r.distanceFromRoute <= MAX_DISTANCE);

    // 샘플 포인트별로 그룹화하여 각 구간에서 가장 가까운 5개씩 선택
    const RESTAURANTS_PER_POINT = 5;
    const bySegment = new Map<number, Array<typeof withProgress[0]>>();
    for (const r of withProgress) {
      const list = bySegment.get(r.sampleIndex) || [];
      list.push(r);
      bySegment.set(r.sampleIndex, list);
    }

    const results: typeof withProgress = [];
    for (const list of bySegment.values()) {
      list.sort((a, b) => a.distanceFromRoute - b.distanceFromRoute);
      results.push(...list.slice(0, RESTAURANTS_PER_POINT));
    }

    // 경로 진행 순서로 정렬
    results.sort((a, b) => a.routeProgress - b.routeProgress);

    // 결과 변환
    return results.map((r) => ({
      id: r.id,
      name: r.place_name,
      category: extractCategory(r.category_name),
      address: r.road_address_name || r.address_name,
      lat: Number(r.y),
      lng: Number(r.x),
      distanceFromRoute: Math.round(r.distanceFromRoute),
      routeProgress: r.routeProgress, // 경로 진행률 (0~1)
    }));
}

// Kakao Local API로 음식점 검색
async function searchRestaurantsAt(
  apiKey: string,
  lat: number,
  lng: number,
  radius: number
): Promise<KakaoPlace[]> {
  const url = new URL(
    "https://dapi.kakao.com/v2/local/search/category.json"
  );
  url.searchParams.set("category_group_code", "FD6"); // 음식점
  url.searchParams.set("x", String(lng));
  url.searchParams.set("y", String(lat));
  url.searchParams.set("radius", String(radius));
  url.searchParams.set("size", "15"); // 각 포인트에서 최대 15개

  const response = await fetch(url.toString(), {
    headers: {
      Authorization: `KakaoAK ${apiKey}`,
    },
  });

  if (!response.ok) {
    console.error(`Kakao API 오류: ${response.status}`);
    return [];
  }

  const data = await response.json();
  return data.documents;
}

// 경로를 따라 일정 간격으로 샘플 포인트 생성
function sampleAlongRoute(
  coords: Array<{ lat: number; lng: number }>,
  intervalMeters: number
): Array<{ lat: number; lng: number }> {
  if (coords.length === 0) return [];
  if (coords.length === 1) return [coords[0]];

  const samples: Array<{ lat: number; lng: number }> = [coords[0]];
  let accumulated = 0;

  for (let i = 1; i < coords.length; i++) {
    const segmentLength = haversineDistance(coords[i - 1], coords[i]);
    accumulated += segmentLength;

    // 누적 거리가 interval을 초과할 때마다 샘플 추가
    while (accumulated >= intervalMeters) {
      // 세그먼트 내에서 interpolate
      const overshoot = accumulated - intervalMeters;
      const t = (segmentLength - overshoot) / segmentLength;
      const sample = {
        lat: coords[i - 1].lat + t * (coords[i].lat - coords[i - 1].lat),
        lng: coords[i - 1].lng + t * (coords[i].lng - coords[i - 1].lng),
      };
      samples.push(sample);
      accumulated -= intervalMeters;
    }
  }

  // 마지막 점 추가 (중복 방지)
  const last = coords[coords.length - 1];
  const lastSample = samples[samples.length - 1];
  if (haversineDistance(last, lastSample) > 50) {
    samples.push(last);
  }

  return samples;
}

// 점에서 경로까지의 최소 거리와 경로상 진행률 (0~1)
function getRouteDistanceAndProgress(
  point: { lat: number; lng: number },
  route: Array<{ lat: number; lng: number }>
): { distance: number; progress: number } {
  if (route.length === 0) {
    return { distance: Infinity, progress: 0 };
  }
  if (route.length === 1) {
    return { distance: haversineDistance(point, route[0]), progress: 0 };
  }

  // 전체 경로 길이 계산
  let totalLength = 0;
  const segmentLengths: number[] = [];
  for (let i = 0; i < route.length - 1; i++) {
    const len = haversineDistance(route[i], route[i + 1]);
    segmentLengths.push(len);
    totalLength += len;
  }

  let minDist = Infinity;
  let progressAtMinDist = 0;
  let accumulatedLength = 0;

  for (let i = 0; i < route.length - 1; i++) {
    const { distance, t } = pointToSegmentInfo(point, route[i], route[i + 1]);

    if (distance < minDist) {
      minDist = distance;
      // 현재 세그먼트까지의 누적 길이 + 세그먼트 내 위치
      progressAtMinDist = (accumulatedLength + t * segmentLengths[i]) / totalLength;
    }

    accumulatedLength += segmentLengths[i];
  }

  return { distance: minDist, progress: progressAtMinDist };
}

// 점에서 선분까지의 거리와 선분 내 위치 (0~1)
function pointToSegmentInfo(
  point: { lat: number; lng: number },
  segStart: { lat: number; lng: number },
  segEnd: { lat: number; lng: number }
): { distance: number; t: number } {
  const segLen = haversineDistance(segStart, segEnd);

  if (segLen === 0) {
    return { distance: haversineDistance(point, segStart), t: 0 };
  }

  // 투영점 계산 (t: 0~1)
  const dx = segEnd.lng - segStart.lng;
  const dy = segEnd.lat - segStart.lat;
  const px = point.lng - segStart.lng;
  const py = point.lat - segStart.lat;

  const t = Math.max(0, Math.min(1, (px * dx + py * dy) / (dx * dx + dy * dy)));

  const proj = {
    lat: segStart.lat + t * (segEnd.lat - segStart.lat),
    lng: segStart.lng + t * (segEnd.lng - segStart.lng),
  };

  return { distance: haversineDistance(point, proj), t };
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
  x: string; // 경도 (Kakao API returns string)
  y: string; // 위도 (Kakao API returns string)
}

interface Restaurant {
  id: string;
  name: string;
  category: string;
  address: string;
  lat: number;
  lng: number;
  distanceFromRoute: number;
  routeProgress: number; // 경로 진행률 (0~1)
}
