import { action } from "./_generated/server";
import { v } from "convex/values";

const KAKAO_KEYWORD_SEARCH_URL =
  "https://dapi.kakao.com/v2/local/search/keyword.json";
const RESULTS_PER_PAGE = 15;

export const searchPlaces = action({
  args: {
    query: v.string(),
  },
  handler: async (_ctx, args): Promise<PlaceSearchResult[]> => {
    const query = args.query.trim();
    if (!query) return [];

    const apiKey = process.env.KAKAO_REST_API_KEY;
    if (!apiKey) {
      throw new Error("KAKAO_REST_API_KEY 환경변수가 설정되지 않았습니다.");
    }

    const url = new URL(KAKAO_KEYWORD_SEARCH_URL);
    url.searchParams.set("query", query);
    url.searchParams.set("page", "1");
    url.searchParams.set("size", String(RESULTS_PER_PAGE));
    url.searchParams.set("sort", "accuracy");

    const response = await fetch(url.toString(), {
      headers: {
        Authorization: `KakaoAK ${apiKey}`,
      },
    });

    if (!response.ok) {
      throw new Error(`Kakao 장소 검색 오류: ${response.status}`);
    }

    const payload: unknown = await response.json();
    if (!isRecord(payload) || !Array.isArray(payload.documents)) {
      throw new Error("Kakao 장소 검색 응답 형식이 올바르지 않습니다.");
    }

    return payload.documents.flatMap((document): PlaceSearchResult[] => {
      if (!isRecord(document)) return [];

      const id = readString(document.id);
      const name = readString(document.place_name);
      const addressName = readString(document.address_name);
      const roadAddressName = readString(document.road_address_name);
      const address = roadAddressName || addressName;
      const lng = Number(document.x);
      const lat = Number(document.y);
      const addressFields = [addressName, roadAddressName].filter(Boolean);

      if (
        !id ||
        !name ||
        !address ||
        !addressFields.some(isSeoulAddress) ||
        !Number.isFinite(lat) ||
        !Number.isFinite(lng)
      ) {
        return [];
      }

      return [{ id, name, address, lat, lng }];
    });
  },
});

type PlaceSearchResult = {
  id: string;
  name: string;
  address: string;
  lat: number;
  lng: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function isSeoulAddress(address: string): boolean {
  return /^(서울특별시|서울시|서울)(?:\s|$)/.test(address.trim());
}
