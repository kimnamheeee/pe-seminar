import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  // Kept during migration so existing development and production data can be copied.
  busStops: defineTable({
    stationId: v.string(), // 서울시 정류소 고유 ID
    name: v.string(), // 정류소 이름
    normalizedName: v.string(), // 검색용 정규화 이름
    lat: v.number(), // 위도
    lng: v.number(), // 경도
  }).index("by_normalizedName", ["normalizedName"]),

  transitStops: defineTable({
    mode: v.union(v.literal("BUS"), v.literal("SUBWAY")),
    sourceId: v.string(), // 원본 데이터의 정류장/역 식별자
    name: v.string(),
    normalizedName: v.string(),
    lat: v.number(),
    lng: v.number(),
    lineName: v.optional(v.string()),
  })
    .index("by_mode_and_normalizedName", ["mode", "normalizedName"])
    .index("by_mode_and_sourceId", ["mode", "sourceId"]),
});
