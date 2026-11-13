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

// 여러 식당에 대한 하차 정류장 일괄 조회
export const getNearestStopsForRestaurants = query({
  args: {
    restaurants: v.array(
      v.object({
        id: v.string(),
        lat: v.number(),
        lng: v.number(),
        routeProgress: v.number(),
      })
    ),
    legs: v.array(
      v.object({
        type: v.string(),
        startProgress: v.number(),
        polyline: v.array(v.object({ lat: v.number(), lng: v.number() })),
        stations: v.array(
          v.object({
            name: v.string(),
            lat: v.number(),
            lng: v.number(),
          })
        ),
      })
    ),
  },
  handler: async (ctx, args) => {
    // 모든 정류장 이름에 대해 DB에서 좌표 조회 (캐싱)
    const stationNameSet = new Set<string>();
    for (const leg of args.legs) {
      for (const station of leg.stations) {
        stationNameSet.add(normalizeName(station.name));
      }
    }

    const stationCoords = new Map<string, Array<{ lat: number; lng: number }>>();
    for (const normalizedName of stationNameSet) {
      const candidates = await ctx.db
        .query("busStops")
        .withIndex("by_normalizedName", (q) => q.eq("normalizedName", normalizedName))
        .collect();
      if (candidates.length > 0) {
        stationCoords.set(
          normalizedName,
          candidates.map(({ lat, lng }) => ({ lat, lng }))
        );
      }
    }

    // 각 식당에 대해 가장 가까운 정류장 계산
    const results: Record<string, {
      found: boolean;
      stop?: { name: string; lat: number; lng: number; distanceFromRestaurant: number; distanceFromRoute: number };
      stopLegIndex?: number;
    }> = {};

    for (const restaurant of args.restaurants) {
      // 이 식당 이전에 시작하는 버스 구간의 정류장만 고려
      const relevantStations: Array<{
        name: string;
        lat: number;
        lng: number;
        legIndex: number;
        distanceFromRoute: number;
      }> = [];

      for (let i = 0; i < args.legs.length; i++) {
        const leg = args.legs[i];
        if (leg.type === "BUS" && leg.startProgress <= restaurant.routeProgress) {
          if (leg.polyline.length >= 2) {
            for (const station of leg.stations) {
              const candidates = stationCoords.get(normalizeName(station.name));
              if (candidates) {
                let nearestCandidate: { lat: number; lng: number } | null = null;
                let nearestDistance = Infinity;
                for (const candidate of candidates) {
                  const distance = distanceFromPolyline(candidate, leg.polyline);
                  if (distance < nearestDistance) {
                    nearestDistance = distance;
                    nearestCandidate = candidate;
                  }
                }
                if (nearestCandidate) {
                  relevantStations.push({
                    name: station.name,
                    ...nearestCandidate,
                    legIndex: i,
                    distanceFromRoute: nearestDistance,
                  });
                }
              }
            }
          }
        }
      }

      if (relevantStations.length === 0) {
        results[restaurant.id] = { found: false };
        continue;
      }

      // 식당에서 가장 가까운 정류장 찾기
      let nearestStation = relevantStations[0];
      let minDistance = haversineDistance(
        { lat: restaurant.lat, lng: restaurant.lng },
        { lat: relevantStations[0].lat, lng: relevantStations[0].lng }
      );

      for (const station of relevantStations.slice(1)) {
        const dist = haversineDistance(
          { lat: restaurant.lat, lng: restaurant.lng },
          { lat: station.lat, lng: station.lng }
        );
        if (dist < minDistance) {
          minDistance = dist;
          nearestStation = station;
        }
      }

      results[restaurant.id] = {
        found: true,
        stop: {
          name: nearestStation.name,
          lat: nearestStation.lat,
          lng: nearestStation.lng,
          distanceFromRestaurant: Math.round(minDistance),
          distanceFromRoute: Math.round(nearestStation.distanceFromRoute),
        },
        stopLegIndex: nearestStation.legIndex,
      };
    }

    return results;
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

// 정류소 후보 점에서 경로 폴리라인의 가장 가까운 선분까지의 거리 (미터)
function distanceFromPolyline(
  point: { lat: number; lng: number },
  polyline: Array<{ lat: number; lng: number }>
): number {
  const metersPerDegreeLat = 111_320;
  const metersPerDegreeLng = 111_320 * Math.cos((point.lat * Math.PI) / 180);
  let minDistance = Infinity;

  for (let i = 1; i < polyline.length; i++) {
    const start = {
      x: (polyline[i - 1].lng - point.lng) * metersPerDegreeLng,
      y: (polyline[i - 1].lat - point.lat) * metersPerDegreeLat,
    };
    const end = {
      x: (polyline[i].lng - point.lng) * metersPerDegreeLng,
      y: (polyline[i].lat - point.lat) * metersPerDegreeLat,
    };
    const segmentX = end.x - start.x;
    const segmentY = end.y - start.y;
    const segmentLengthSquared = segmentX * segmentX + segmentY * segmentY;
    const projection = segmentLengthSquared === 0
      ? 0
      : Math.max(
          0,
          Math.min(1, -(start.x * segmentX + start.y * segmentY) / segmentLengthSquared)
        );
    const dx = start.x + projection * segmentX;
    const dy = start.y + projection * segmentY;
    minDistance = Math.min(minDistance, Math.sqrt(dx * dx + dy * dy));
  }

  return minDistance;
}
