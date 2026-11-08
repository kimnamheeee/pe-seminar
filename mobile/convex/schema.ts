import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  busStops: defineTable({
    stationId: v.string(), // 서울시 정류소 고유 ID
    name: v.string(), // 정류소 이름
    normalizedName: v.string(), // 검색용 정규화 이름
    lat: v.number(), // 위도
    lng: v.number(), // 경도
  }).index("by_normalizedName", ["normalizedName"]),
});
