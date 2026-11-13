import { internal } from "./_generated/api";
import { internalAction, internalMutation, query } from "./_generated/server";
import { v } from "convex/values";

const modeValidator = v.union(v.literal("BUS"), v.literal("SUBWAY"));

// Idempotent batch import for source datasets. Kept internal so clients cannot
// write arbitrary transit-stop data.
export const upsertBatch = internalMutation({
  args: {
    stops: v.array(
      v.object({
        mode: modeValidator,
        sourceId: v.string(),
        name: v.string(),
        normalizedName: v.string(),
        lat: v.number(),
        lng: v.number(),
        lineName: v.optional(v.string()),
      })
    ),
  },
  handler: async (ctx, args) => {
    let inserted = 0;
    let updated = 0;

    for (const stop of args.stops) {
      const existing = await ctx.db
        .query("transitStops")
        .withIndex("by_mode_and_sourceId", (q) =>
          q.eq("mode", stop.mode).eq("sourceId", stop.sourceId)
        )
        .unique();

      if (existing) {
        await ctx.db.patch(existing._id, stop);
        updated++;
      } else {
        await ctx.db.insert("transitStops", stop);
        inserted++;
      }
    }

    return { inserted, updated };
  },
});

// Copy existing busStops rows in bounded batches. The old table stays in the
// schema until this migration has been run against every deployment.
export const copyLegacyBusStopsBatch = internalMutation({
  args: { cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, args) => {
    const page = await ctx.db
      .query("busStops")
      .order("asc")
      .paginate({ numItems: 100, cursor: args.cursor });
    let copied = 0;

    for (const stop of page.page) {
      const existing = await ctx.db
        .query("transitStops")
        .withIndex("by_mode_and_sourceId", (q) =>
          q.eq("mode", "BUS").eq("sourceId", stop.stationId)
        )
        .unique();

      if (!existing) {
        await ctx.db.insert("transitStops", {
          mode: "BUS",
          sourceId: stop.stationId,
          name: stop.name,
          normalizedName: stop.normalizedName,
          lat: stop.lat,
          lng: stop.lng,
        });
        copied++;
      }
    }

    return {
      copied,
      done: page.isDone,
      cursor: page.continueCursor,
    };
  },
});

export const migrateLegacyBusStops = internalAction({
  args: {},
  handler: async (ctx) => {
    let cursor: string | null = null;
    let copied = 0;
    let done = false;

    while (!done) {
      const result: { copied: number; done: boolean; cursor: string } =
        await ctx.runMutation(internal.transitStops.copyLegacyBusStopsBatch, {
          cursor,
        });
      copied += result.copied;
      done = result.done;
      cursor = result.cursor;
    }

    return { copied };
  },
});

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
        type: v.union(v.literal("WALK"), v.literal("BUS"), v.literal("SUBWAY")),
        startProgress: v.number(),
        polyline: v.array(v.object({ lat: v.number(), lng: v.number() })),
        stations: v.array(v.object({ name: v.string() })),
      })
    ),
  },
  handler: async (ctx, args) => {
    const namesByMode = new Map<string, Set<string>>();
    for (const leg of args.legs) {
      if (leg.type === "WALK") continue;
      const names = namesByMode.get(leg.type) ?? new Set<string>();
      for (const station of leg.stations) {
        names.add(normalizeName(station.name, leg.type));
      }
      namesByMode.set(leg.type, names);
    }

    const candidatesByModeAndName = new Map<string, Array<{
      name: string;
      lat: number;
      lng: number;
      lineName?: string;
    }>>();

    for (const [mode, names] of namesByMode) {
      for (const normalizedName of names) {
        const candidates = await ctx.db
          .query("transitStops")
          .withIndex("by_mode_and_normalizedName", (q) =>
            q.eq("mode", mode as "BUS" | "SUBWAY").eq("normalizedName", normalizedName)
          )
          .take(100);
        if (candidates.length > 0) {
          candidatesByModeAndName.set(`${mode}:${normalizedName}`, candidates);
        }
      }
    }

    const results: Record<string, {
      found: boolean;
      stop?: {
        mode: "BUS" | "SUBWAY";
        name: string;
        lat: number;
        lng: number;
        distanceFromRestaurant: number;
        distanceFromRoute: number;
      };
      stopLegIndex?: number;
    }> = {};

    for (const restaurant of args.restaurants) {
      const relevantStops: Array<{
        mode: "BUS" | "SUBWAY";
        name: string;
        lat: number;
        lng: number;
        lineName?: string;
        legIndex: number;
        distanceFromRoute: number;
      }> = [];

      for (let i = 0; i < args.legs.length; i++) {
        const leg = args.legs[i];
        if (leg.type === "WALK" || leg.startProgress > restaurant.routeProgress) continue;

        for (const station of leg.stations) {
          const key = `${leg.type}:${normalizeName(station.name, leg.type)}`;
          const candidates = candidatesByModeAndName.get(key) ?? [];
          if (candidates.length === 0) continue;

          let nearestCandidate = candidates[0];
          let nearestDistance = leg.polyline.length >= 2
            ? distanceFromPolyline(nearestCandidate, leg.polyline)
            : haversineDistance(
                { lat: restaurant.lat, lng: restaurant.lng },
                nearestCandidate
              );

          for (const candidate of candidates.slice(1)) {
            const distance = leg.polyline.length >= 2
              ? distanceFromPolyline(candidate, leg.polyline)
              : haversineDistance(
                  { lat: restaurant.lat, lng: restaurant.lng },
                  candidate
                );
            if (distance < nearestDistance) {
              nearestDistance = distance;
              nearestCandidate = candidate;
            }
          }

          relevantStops.push({
            mode: leg.type,
            ...nearestCandidate,
            name: station.name,
            legIndex: i,
            distanceFromRoute: nearestDistance,
          });
        }
      }

      if (relevantStops.length === 0) {
        results[restaurant.id] = { found: false };
        continue;
      }

      let nearestStop = relevantStops[0];
      let nearestDistance = haversineDistance(
        { lat: restaurant.lat, lng: restaurant.lng },
        nearestStop
      );
      for (const stop of relevantStops.slice(1)) {
        const distance = haversineDistance(
          { lat: restaurant.lat, lng: restaurant.lng },
          stop
        );
        if (distance < nearestDistance) {
          nearestDistance = distance;
          nearestStop = stop;
        }
      }

      results[restaurant.id] = {
        found: true,
        stop: {
          mode: nearestStop.mode,
          name: nearestStop.name,
          lat: nearestStop.lat,
          lng: nearestStop.lng,
          distanceFromRestaurant: Math.round(nearestDistance),
          distanceFromRoute: Math.round(nearestStop.distanceFromRoute),
        },
        stopLegIndex: nearestStop.legIndex,
      };
    }

    return results;
  },
});

function normalizeName(name: string, mode?: "BUS" | "SUBWAY"): string {
  const withoutSubwayAlias = mode === "SUBWAY"
    ? name.replace(/\([^)]*\)/g, "")
    : name;
  const normalized = withoutSubwayAlias
    .replace(/\s+/g, "")
    .toLowerCase()
    .replace(/[^\w가-힣]/g, "");
  return mode === "SUBWAY" ? normalized.replace(/역$/, "") : normalized;
}

function haversineDistance(
  p1: { lat: number; lng: number },
  p2: { lat: number; lng: number }
): number {
  const radius = 6_371_000;
  const dLat = ((p2.lat - p1.lat) * Math.PI) / 180;
  const dLng = ((p2.lng - p1.lng) * Math.PI) / 180;
  const lat1 = (p1.lat * Math.PI) / 180;
  const lat2 = (p2.lat * Math.PI) / 180;
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return radius * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

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
    const lengthSquared = segmentX * segmentX + segmentY * segmentY;
    const projection = lengthSquared === 0
      ? 0
      : Math.max(0, Math.min(1,
          -(start.x * segmentX + start.y * segmentY) / lengthSquared));
    const dx = start.x + projection * segmentX;
    const dy = start.y + projection * segmentY;
    minDistance = Math.min(minDistance, Math.sqrt(dx * dx + dy * dy));
  }

  return minDistance;
}
