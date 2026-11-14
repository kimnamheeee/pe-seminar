/**
 * 가는김에 디자인 토큰
 * DESIGN.md 기반
 */

export const colors = {
  // 브랜드
  primary: "#176B62",
  primaryLight: "#E8F3F1",

  // 배경
  background: "#F6F8F7",
  surface: "#FFFFFF",

  // 텍스트
  textPrimary: "#172321",
  textSecondary: "#63716E",

  // 구분
  border: "#E3E9E7",

  // 상태
  restaurantMarker: "#D96845",
  error: "#B93838",
  warning: "#94600C",
} as const;

export const appFontFamily = "Pretendard";

export const typography = {
  // 화면 제목
  title: {
    fontSize: 26,
    fontWeight: "700" as const,
    lineHeight: 36,
  },
  // 섹션 제목, 식당명
  subtitle: {
    fontSize: 18,
    fontWeight: "600" as const,
    lineHeight: 26,
  },
  // 본문
  body: {
    fontSize: 16,
    fontWeight: "400" as const,
    lineHeight: 24,
  },
  // 보조 정보
  caption: {
    fontSize: 14,
    fontWeight: "400" as const,
    lineHeight: 20,
  },
  // 작은 정보
  small: {
    fontSize: 13,
    fontWeight: "400" as const,
    lineHeight: 18,
  },
} as const;

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
} as const;

export const radius = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
} as const;
