import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

// 정류소 일괄 삽입 (적재 스크립트용)
export const insertBatch = mutation({
  args: {
    stops: v.array(
      v.object({
        stationId: v.string(),
        name: v.string(),
        normalizedName: v.string(),
        lat: v.number(),
        lng: v.number(),
      })
    ),
  },
  handler: async (ctx, args) => {
    for (const stop of args.stops) {
      await ctx.db.insert("busStops", stop);
    }
    return args.stops.length;
  },
});

// 정류소 이름으로 검색
export const findByName = query({
  args: { normalizedName: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("busStops")
      .withIndex("by_normalizedName", (q) =>
        q.eq("normalizedName", args.normalizedName)
      )
      .collect();
  },
});

// 전체 개수 확인
export const count = query({
  args: {},
  handler: async (ctx) => {
    const stops = await ctx.db.query("busStops").collect();
    return stops.length;
  },
});

// 하차 정류장 찾기
export const getNearestStop = query({
  args: {
    restaurantCoord: v.object({ lat: v.number(), lng: v.number() }),
    routeStations: v.array(
      v.object({
        name: v.string(),
        lat: v.number(),
        lng: v.number(),
      })
    ),
  },
  handler: async (ctx, args) => {
    if (args.routeStations.length === 0) {
      return { found: false as const, reason: "NO_ROUTE_STATIONS" as const };
    }

    // 각 경로 정류장에 대해 DB에서 매칭되는 정류소 찾기
    const matchedStops: Array<{
      stationId: string;
      name: string;
      lat: number;
      lng: number;
      distanceFromRestaurant: number;
    }> = [];

    for (const station of args.routeStations) {
      const normalizedName = normalizeName(station.name);

      // DB에서 같은 이름의 정류소 검색
      const candidates = await ctx.db
        .query("busStops")
        .withIndex("by_normalizedName", (q) =>
          q.eq("normalizedName", normalizedName)
        )
        .collect();

      if (candidates.length === 0) {
        continue;
      }

      // 이름이 중복되면 경로 좌표와 가장 가까운 후보 선택
      let bestCandidate = candidates[0];
      let bestDistance = haversineDistance(
        { lat: station.lat, lng: station.lng },
        { lat: candidates[0].lat, lng: candidates[0].lng }
      );

      for (const candidate of candidates.slice(1)) {
        const dist = haversineDistance(
          { lat: station.lat, lng: station.lng },
          { lat: candidate.lat, lng: candidate.lng }
        );
        if (dist < bestDistance) {
          bestDistance = dist;
          bestCandidate = candidate;
        }
      }

      matchedStops.push({
        stationId: bestCandidate.stationId,
        name: bestCandidate.name,
        lat: bestCandidate.lat,
        lng: bestCandidate.lng,
        distanceFromRestaurant: haversineDistance(
          args.restaurantCoord,
          { lat: bestCandidate.lat, lng: bestCandidate.lng }
        ),
      });
    }

    if (matchedStops.length === 0) {
      return { found: false as const, reason: "NO_MATCHING_STOPS" as const };
    }

    // 식당에서 가장 가까운 정류장 반환
    matchedStops.sort((a, b) => a.distanceFromRestaurant - b.distanceFromRestaurant);

    return {
      found: true as const,
      stop: {
        stationId: matchedStops[0].stationId,
        name: matchedStops[0].name,
        lat: matchedStops[0].lat,
        lng: matchedStops[0].lng,
        distanceFromRestaurant: Math.round(matchedStops[0].distanceFromRestaurant),
      },
    };
  },
});

// 이름 정규화
function normalizeName(name: string): string {
  return name
    .replace(/\s+/g, "")
    .toLowerCase()
    .replace(/[^\w가-힣]/g, "");
}

// Haversine 거리 계산 (미터)
function haversineDistance(
  p1: { lat: number; lng: number },
  p2: { lat: number; lng: number }
): number {
  const R = 6371000;
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
