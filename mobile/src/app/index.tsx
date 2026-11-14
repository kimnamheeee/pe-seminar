import { Fragment, useState, useCallback, useRef, useMemo, useEffect, type ComponentRef } from "react";
import { Dimensions, Modal } from "react-native";
import {
  View,
  StyleSheet,
  FlatList,
  ScrollView,
  ActivityIndicator,
  Pressable,
  TextInput,
  Keyboard,
  type TextInputInstance,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import * as Location from "expo-location";
import MapView, { Marker, Polyline } from "react-native-maps";
import BottomSheet, { BottomSheetFlatList } from "@gorhom/bottom-sheet";
import { WebView } from "react-native-webview";
import Animated, {
  FadeInDown,
  useAnimatedStyle,
  useSharedValue,
} from "react-native-reanimated";
import { useAction } from "convex/react";
import { api } from "../../convex/_generated/api";
import { appFontFamily, colors, typography, spacing, radius } from "../lib/theme";
import { Button, Header, RouteCard, RestaurantItem, RouteTypeTabs, Text } from "../components";
import type { RouteTypeTabKey } from "../components/RouteTypeTabs";

type Route = {
  id: string;
  routeType: "BUS" | "SUBWAY" | "BUS_AND_SUBWAY";
  summary: {
    duration: number;
    busCount: number;
    subwayCount: number;
    walkTime: number;
    transfers: number;
  };
  legs: Array<{
    type: "WALK" | "BUS" | "SUBWAY";
    startName: string;
    endName: string;
    time: number;
    distance: number;
    polyline: Array<{ lat: number; lng: number }>;
    vehicleInfo?: { name: string; type: string };
    stations?: Array<{ name: string }>;
  }>;
  polyline: Array<{ lat: number; lng: number }>;
};

type Restaurant = {
  id: string;
  name: string;
  category: string;
  address: string;
  placeUrl: string;
  lat: number;
  lng: number;
  distanceFromRoute: number;
  routeProgress: number; // 경로 진행률 (0~1)
};

type RestaurantStopInfo = {
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
};

type RoutePoint = { lat: number; lng: number };

function splitPolylineAtPoint(polyline: RoutePoint[], point: RoutePoint) {
  if (polyline.length < 2) return { before: polyline, after: [] as RoutePoint[] };

  const metersPerDegreeLng = 111_320 * Math.cos((point.lat * Math.PI) / 180);
  let closestDistance = Infinity;
  let splitIndex = 1;
  let closestPoint = polyline[0];

  for (let i = 1; i < polyline.length; i++) {
    const start = polyline[i - 1];
    const end = polyline[i];
    const startX = (start.lng - point.lng) * metersPerDegreeLng;
    const startY = (start.lat - point.lat) * 111_320;
    const endX = (end.lng - point.lng) * metersPerDegreeLng;
    const endY = (end.lat - point.lat) * 111_320;
    const deltaX = endX - startX;
    const deltaY = endY - startY;
    const lengthSquared = deltaX * deltaX + deltaY * deltaY;
    const t = lengthSquared === 0
      ? 0
      : Math.max(0, Math.min(1, -(startX * deltaX + startY * deltaY) / lengthSquared));
    const distanceX = startX + t * deltaX;
    const distanceY = startY + t * deltaY;
    const distance = distanceX * distanceX + distanceY * distanceY;

    if (distance < closestDistance) {
      closestDistance = distance;
      splitIndex = i;
      closestPoint = {
        lat: start.lat + (end.lat - start.lat) * t,
        lng: start.lng + (end.lng - start.lng) * t,
      };
    }
  }

  return {
    before: [...polyline.slice(0, splitIndex), closestPoint],
    after: [closestPoint, ...polyline.slice(splitIndex)],
  };
}

function getLegEndProgress(route: Route): number[] {
  let totalLength = 0;
  const legLengths = route.legs.map((leg) => {
    let length = 0;
    for (let i = 1; i < leg.polyline.length; i++) {
      const p1 = leg.polyline[i - 1];
      const p2 = leg.polyline[i];
      length += Math.sqrt(Math.pow((p2.lat - p1.lat) * 111000, 2) + Math.pow((p2.lng - p1.lng) * 88000, 2));
    }
    totalLength += length;
    return length;
  });
  let accumulated = 0;
  return legLengths.map((length) => {
    accumulated += length;
    return totalLength > 0 ? accumulated / totalLength : 0;
  });
}

function buildStopMatchingLegs(route: Route) {
  const endProgress = getLegEndProgress(route);
  return route.legs.map((leg, index) => ({
    type: leg.type,
    startProgress: index === 0 ? 0 : (endProgress[index - 1] || 0),
    polyline: leg.polyline,
    stations: (leg.stations || []).map((station) => ({ name: station.name })),
  }));
}

type PlaceSearchResult = {
  id: string;
  name: string;
  address: string;
  lat: number;
  lng: number;
};

type RouteSearchStatus = "NO_ROUTES" | "ALL_TOO_LONG" | null;

export default function HomeScreen() {
  const [originPlace, setOriginPlace] = useState<PlaceSearchResult | null>(null);
  const [destinationPlace, setDestinationPlace] = useState<PlaceSearchResult | null>(null);
  const [placeSearchTarget, setPlaceSearchTarget] = useState<"origin" | "destination" | null>(null);
  const [placeQuery, setPlaceQuery] = useState("");
  const [placeResults, setPlaceResults] = useState<PlaceSearchResult[]>([]);
  const [placeSearchLoading, setPlaceSearchLoading] = useState(false);
  const [placeSearchError, setPlaceSearchError] = useState(false);
  const [placeSearchRetry, setPlaceSearchRetry] = useState(0);
  const [isShowingRoutes, setIsShowingRoutes] = useState(false);
  const [isGettingCurrentLocation, setIsGettingCurrentLocation] = useState(false);
  const [currentLocationError, setCurrentLocationError] = useState<string | null>(null);
  const placeSearchInputRef = useRef<TextInputInstance>(null);
  const [routes, setRoutes] = useState<Route[]>([]);
  const [routeSearchStatus, setRouteSearchStatus] = useState<RouteSearchStatus>(null);
  const [selectedRouteType, setSelectedRouteType] = useState<RouteTypeTabKey>("ALL");
  const [selectedRoute, setSelectedRoute] = useState<Route | null>(null);
  const [restaurants, setRestaurants] = useState<Restaurant[]>([]);
  const [selectedRestaurantCategories, setSelectedRestaurantCategories] = useState<string[]>([]);
  const [restaurantStops, setRestaurantStops] = useState<Record<string, RestaurantStopInfo>>({});
  const [alightingLimitedReason, setAlightingLimitedReason] = useState<"OUTSIDE_SEOUL" | null>(null);
  const [selectedRestaurant, setSelectedRestaurant] = useState<Restaurant | null>(null);
  const [expandedRestaurantId, setExpandedRestaurantId] = useState<string | null>(null);
  const [kakaoPlaceModal, setKakaoPlaceModal] = useState<{ name: string; url: string } | null>(null);
  const [kakaoPlaceLoading, setKakaoPlaceLoading] = useState(false);
  const [listViewportHeight, setListViewportHeight] = useState(0);
  const [lastRestaurantTriggerHeight, setLastRestaurantTriggerHeight] = useState(72);
  const [loading, setLoading] = useState<"routes" | "restaurants" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const bottomSheetRef = useRef<BottomSheet>(null);
  const bottomSheetAnimatedPosition = useSharedValue(0);
  const [mapContainerHeight, setMapContainerHeight] = useState(0);
  const [bottomSheetHandleHeight, setBottomSheetHandleHeight] = useState(0);
  const bottomSheetCenterAnchorStyle = useAnimatedStyle(() => ({
    top: Math.max(
      0,
      (mapContainerHeight - bottomSheetAnimatedPosition.value) / 2 - bottomSheetHandleHeight + 12
    ),
  }));
  const mapRef = useRef<MapView>(null);
  const flatListRef = useRef<FlatList<Restaurant>>(null);
  const centerAnchorRef = useRef<ComponentRef<typeof View> | null>(null);
  const restaurantCellRefs = useRef(new Map<string, ComponentRef<typeof View>>());
  const restaurantTriggerRefs = useRef(new Map<string, ComponentRef<typeof View>>());
  const listScrollOffsetRef = useRef(0);
  const listLastScrolledAtRef = useRef(0);
  const autoExpandOnScrollRef = useRef(false);
  const autoExpandLastCheckAtRef = useRef(0);
  const autoExpandRequestIdRef = useRef(0);
  const autoExpandTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const autoExpandEndTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const autoExpandSuppressedUntilRef = useRef(0);
  const listIsDraggingRef = useRef(false);
  const pendingRestaurantCenterRef = useRef<string | null>(null);
  const pendingRestaurantSelectedAtRef = useRef(0);
  const snapPoints = useMemo(() => ["25%", "50%", "90%"], []);

  const visibleRestaurantsRef = useRef<Restaurant[]>([]);

  const getRoutes = useAction(api.routes.getRoutesWithStatus);
  const getRestaurantsWithStops = useAction(api.restaurants.getRestaurantsWithStops);
  const searchPlaces = useAction(api.places.searchPlaces);

  useEffect(() => {
    if (!placeSearchTarget) return;

    const query = placeQuery.trim();
    if (!query) {
      setPlaceResults([]);
      setPlaceSearchLoading(false);
      setPlaceSearchError(false);
      return;
    }

    let cancelled = false;
    setPlaceResults([]);
    setPlaceSearchLoading(true);
    setPlaceSearchError(false);

    const timeout = setTimeout(() => {
      searchPlaces({ query })
        .then((results) => {
          if (!cancelled) setPlaceResults(results);
        })
        .catch(() => {
          if (!cancelled) {
            setPlaceResults([]);
            setPlaceSearchError(true);
          }
        })
        .finally(() => {
          if (!cancelled) setPlaceSearchLoading(false);
        });
    }, 300);

    return () => {
      cancelled = true;
      clearTimeout(timeout);
    };
  }, [placeSearchTarget, placeQuery, placeSearchRetry, searchPlaces]);

  useEffect(() => {
    if (!placeSearchTarget) return;

    const focusTimeout = setTimeout(() => {
      placeSearchInputRef.current?.focus();
    }, 120);

    return () => clearTimeout(focusTimeout);
  }, [placeSearchTarget]);

  const routeCounts = useMemo<Record<RouteTypeTabKey, number>>(() => {
    const counts: Record<RouteTypeTabKey, number> = {
      ALL: routes.length,
      BUS: 0,
      SUBWAY: 0,
      BUS_AND_SUBWAY: 0,
    };

    for (const route of routes) {
      counts[route.routeType] += 1;
    }

    return counts;
  }, [routes]);

  const visibleRoutes = useMemo(
    () => selectedRouteType === "ALL"
      ? routes
      : routes.filter((route) => route.routeType === selectedRouteType),
    [routes, selectedRouteType]
  );

  const restaurantCategories = useMemo(
    () => Array.from(new Set(restaurants.map((restaurant) => restaurant.category).filter(Boolean))),
    [restaurants]
  );
  const visibleRestaurants = useMemo(
    () => selectedRestaurantCategories.length === 0
      ? restaurants
      : restaurants.filter((restaurant) => selectedRestaurantCategories.includes(restaurant.category)),
    [restaurants, selectedRestaurantCategories]
  );
  const lastVisibleRestaurantId = visibleRestaurants[visibleRestaurants.length - 1]?.id ?? null;
  const lastRestaurantStopInfo = lastVisibleRestaurantId ? restaurantStops[lastVisibleRestaurantId] : undefined;
  let lastRestaurantGuideStepCount = 0;
  if (lastRestaurantStopInfo) {
    lastRestaurantGuideStepCount = 2; // 출발지와 도착 식당
    if (alightingLimitedReason === "OUTSIDE_SEOUL") {
      lastRestaurantGuideStepCount += 1;
    } else if (selectedRoute) {
      const stopLegIndex = lastRestaurantStopInfo.stopLegIndex ?? -1;
      for (let index = 0; index < selectedRoute.legs.length; index++) {
        const leg = selectedRoute.legs[index];
        if (stopLegIndex >= 0 && index > stopLegIndex) continue;
        if (leg.type === "WALK" || !leg.vehicleInfo) continue;
        const isStopLeg = index === stopLegIndex;
        const alightStop = isStopLeg && lastRestaurantStopInfo.found && lastRestaurantStopInfo.stop
          ? lastRestaurantStopInfo.stop.name
          : leg.endName;
        if (leg.startName !== alightStop) lastRestaurantGuideStepCount += 1;
      }
      if (lastRestaurantStopInfo.found && lastRestaurantStopInfo.stop) {
        lastRestaurantGuideStepCount += 1;
      }
    }
  }
  const estimatedExpandedLastCellHeight = lastRestaurantTriggerHeight + (
    lastRestaurantGuideStepCount > 0
      ? spacing.sm + spacing.lg + spacing.xs + lastRestaurantGuideStepCount * (typography.body.lineHeight * 2 + spacing.sm)
      : 0
  );
  const centerGuideOffsetInList = Math.min(
    listViewportHeight,
    Math.max(0, listViewportHeight / 2 + bottomSheetHandleHeight / 2 - 12)
  );
  const bottomSpaceForLastCell = listViewportHeight - centerGuideOffsetInList - estimatedExpandedLastCellHeight / 2;
  const bottomSpaceForLastTrigger = listViewportHeight - centerGuideOffsetInList - lastRestaurantTriggerHeight / 2;
  visibleRestaurantsRef.current = visibleRestaurants;
  const selectedRestaurantRef = useRef<Restaurant | null>(selectedRestaurant);
  selectedRestaurantRef.current = selectedRestaurant;

  const centerRestaurantBlockOnGuide = useCallback((restaurantId: string) => {
    const restaurantCell = restaurantCellRefs.current.get(restaurantId);
    const centerAnchor = centerAnchorRef.current;
    if (!restaurantCell || !centerAnchor) return;

    restaurantCell.measureInWindow((_cellX, cellY, _cellWidth, cellHeight) => {
      centerAnchor.measureInWindow((_anchorX, lineY, _anchorWidth, lineHeight) => {
        const difference = cellY + cellHeight / 2 - (lineY + lineHeight / 2);
        flatListRef.current?.scrollToOffset({
          offset: Math.max(0, listScrollOffsetRef.current + difference),
          animated: true,
        });
      });
    });
  }, []);

  const scheduleRestaurantCenterWhenIdle = useCallback((restaurantId: string) => {
    const waitForIdle = () => {
      if (pendingRestaurantCenterRef.current !== restaurantId) return;

      const now = Date.now();
      const selectionHasSettled = now - pendingRestaurantSelectedAtRef.current >= 220;
      const listHasSettled = now - listLastScrolledAtRef.current >= 160;
      if (!selectionHasSettled || !listHasSettled) {
        setTimeout(waitForIdle, 60);
        return;
      }

      pendingRestaurantCenterRef.current = null;
      requestAnimationFrame(() => centerRestaurantBlockOnGuide(restaurantId));
    };

    setTimeout(waitForIdle, 220);
  }, [centerRestaurantBlockOnGuide]);

  const autoExpandRestaurantAtCenter = useCallback(async () => {
    if (!autoExpandOnScrollRef.current || Date.now() < autoExpandSuppressedUntilRef.current) return null;

    const requestId = ++autoExpandRequestIdRef.current;
    const anchor = centerAnchorRef.current;
    if (!anchor) return null;

    const visibleIds = new Set(visibleRestaurantsRef.current.map((restaurant) => restaurant.id));
    const candidates = Array.from(restaurantTriggerRefs.current.entries())
      .filter(([id]) => visibleIds.has(id));
    if (candidates.length === 0) return null;

    const measureCenterY = (view: ComponentRef<typeof View>) => new Promise<number>((resolve) => {
      view.measureInWindow((_x, y, _width, height) => resolve(y + height / 2));
    });

    const anchorY = await measureCenterY(anchor);
    const measured = await Promise.all(candidates.map(async ([id, view]) => ({
      id,
      centerY: await measureCenterY(view),
    })));

    if (requestId !== autoExpandRequestIdRef.current || !autoExpandOnScrollRef.current) return null;
    if (Date.now() < autoExpandSuppressedUntilRef.current) return null;

    const distanceFromCenter = (centerY: number) => Math.abs(centerY - anchorY);
    const currentId = selectedRestaurantRef.current?.id;
    const current = measured.find((candidate) => candidate.id === currentId);
    const nearest = measured.reduce((best, candidate) =>
      distanceFromCenter(candidate.centerY) < distanceFromCenter(best.centerY) ? candidate : best
    );

    // Keep the current item while it is near the guide; switch after another row clearly takes its place.
    const keepCurrent = current && distanceFromCenter(current.centerY) <= 120 &&
      (nearest.id === current.id || distanceFromCenter(nearest.centerY) + 28 >= distanceFromCenter(current.centerY));
    const reachedListStart = listScrollOffsetRef.current <= 2;
    const firstRestaurantId = visibleRestaurantsRef.current[0]?.id;
    const chosenId = reachedListStart && firstRestaurantId
      ? firstRestaurantId
      : keepCurrent
        ? current.id
        : distanceFromCenter(nearest.centerY) <= 96
          ? nearest.id
          : null;
    const chosen = chosenId ? visibleRestaurantsRef.current.find((restaurant) => restaurant.id === chosenId) ?? null : null;

    setSelectedRestaurant((currentSelection) => currentSelection?.id === chosen?.id ? currentSelection : chosen);
    return chosen?.id ?? null;
  }, []);

  const scheduleAutoExpandDuringScroll = useCallback(() => {
    if (!autoExpandOnScrollRef.current || Date.now() < autoExpandSuppressedUntilRef.current) return;

    if (autoExpandEndTimerRef.current) clearTimeout(autoExpandEndTimerRef.current);
    autoExpandEndTimerRef.current = setTimeout(() => {
      autoExpandEndTimerRef.current = null;
      void (async () => {
        const restaurantId = await autoExpandRestaurantAtCenter();
        if (Date.now() - listLastScrolledAtRef.current < 100) return;
        autoExpandOnScrollRef.current = false;
        if (restaurantId) {
          setExpandedRestaurantId(restaurantId);
          if (restaurantId === visibleRestaurantsRef.current[0]?.id && listScrollOffsetRef.current <= 2) {
            requestAnimationFrame(() => {
              requestAnimationFrame(() => flatListRef.current?.scrollToOffset({ offset: 0, animated: false }));
            });
          }
        }
      })();
    }, 100);

    const elapsed = Date.now() - autoExpandLastCheckAtRef.current;
    if (elapsed >= 90) {
      autoExpandLastCheckAtRef.current = Date.now();
      void autoExpandRestaurantAtCenter();
      return;
    }

    if (autoExpandTimerRef.current) return;
    autoExpandTimerRef.current = setTimeout(() => {
      autoExpandTimerRef.current = null;
      autoExpandLastCheckAtRef.current = Date.now();
      void autoExpandRestaurantAtCenter();
    }, 90 - elapsed);
  }, [autoExpandRestaurantAtCenter]);

  // 지도 영역 조정 (바텀시트 50% 높이 고려)
  const screenHeight = Dimensions.get("window").height;
  const bottomSheetHeight = screenHeight * 0.5; // 50% snap point

  // 식당 로드 완료 시 첫 번째 식당 근처로 줌
  useEffect(() => {
    if (visibleRestaurants.length > 0 && mapRef.current) {
      const firstRestaurant = visibleRestaurants[0];
      setTimeout(() => {
        mapRef.current?.animateToRegion({
          latitude: firstRestaurant.lat - 0.008, // 바텀시트 고려 오프셋
          longitude: firstRestaurant.lng,
          latitudeDelta: 0.02,
          longitudeDelta: 0.02,
        });
      }, 100);
    }
  }, [visibleRestaurants]);

  useEffect(() => {
    if (selectedRestaurant && !visibleRestaurants.some((restaurant) => restaurant.id === selectedRestaurant.id)) {
      setSelectedRestaurant(null);
    }
    if (expandedRestaurantId && !visibleRestaurants.some((restaurant) => restaurant.id === expandedRestaurantId)) {
      setExpandedRestaurantId(null);
    }
  }, [selectedRestaurant, expandedRestaurantId, visibleRestaurants]);

  useEffect(() => {
    if (!selectedRestaurant || !mapRef.current) return;

    const latitudeDelta = 0.012;
    mapRef.current.animateToRegion({
      latitude: selectedRestaurant.lat - latitudeDelta * 0.4,
      longitude: selectedRestaurant.lng,
      latitudeDelta,
      longitudeDelta: 0.012,
    }, 250);
  }, [selectedRestaurant]);

  useEffect(() => {
    setLastRestaurantTriggerHeight(72);
  }, [lastVisibleRestaurantId]);

  const getStopInfoForRestaurant = useCallback((restaurantId: string) => {
    return restaurantStops[restaurantId] || null;
  }, [restaurantStops]);

  // 선택된 식당의 정류장 정보 (지도 하이라이팅용)
  const selectedStopInfo = selectedRestaurant ? getStopInfoForRestaurant(selectedRestaurant.id) : null;
  const stopLegIndex = selectedStopInfo?.stopLegIndex ?? -1;

  // 선택한 하차 지점까지 실제로 이용해야 하는 대중교통 구간이 있는지 확인
  const needsTransit = useMemo(() => {
    if (!selectedRestaurant || !selectedRoute || !selectedStopInfo?.found) return true;
    if (stopLegIndex < 0) return false;

    for (let i = 0; i <= stopLegIndex; i++) {
      const leg = selectedRoute.legs[i];
      if (leg.type === "WALK" || !leg.vehicleInfo) continue;

      const isStopLeg = i === stopLegIndex;
      const alightStop = isStopLeg ? selectedStopInfo.stop?.name : leg.endName;

      if (leg.startName !== alightStop) {
        return true;
      }
    }
    return false;
  }, [selectedRestaurant, selectedRoute, selectedStopInfo, stopLegIndex]);

  // 경로 방향 화살표 계산 (최대 10개로 제한)
  const directionArrows = useMemo(() => {
    if (!selectedRoute) return [];

    // 전체 경로 길이 계산
    let totalLength = 0;
    for (const leg of selectedRoute.legs) {
      for (let i = 1; i < leg.polyline.length; i++) {
        const p1 = leg.polyline[i - 1];
        const p2 = leg.polyline[i];
        totalLength += Math.sqrt(
          Math.pow((p2.lat - p1.lat) * 111000, 2) +
          Math.pow((p2.lng - p1.lng) * 88000, 2)
        );
      }
    }

    // 최대 10개 화살표, 최소 간격 500m
    const MAX_ARROWS = 10;
    const MIN_INTERVAL = 500;
    const interval = Math.max(MIN_INTERVAL, totalLength / MAX_ARROWS);

    const arrows: Array<{ lat: number; lng: number; angle: number; isGrayed: boolean }> = [];
    let accumulated = interval / 2; // 시작점에서 약간 떨어진 위치부터

    for (let legIndex = 0; legIndex < selectedRoute.legs.length; legIndex++) {
      const leg = selectedRoute.legs[legIndex];
      if (leg.polyline.length < 2) continue;

      // 버스 불필요하면 전체 회색, 아니면 하차 정류장 이후만 회색
      const isGrayed = selectedRestaurant && (!needsTransit || (stopLegIndex >= 0 && legIndex > stopLegIndex));

      for (let i = 1; i < leg.polyline.length; i++) {
        const p1 = leg.polyline[i - 1];
        const p2 = leg.polyline[i];

        const dist = Math.sqrt(
          Math.pow((p2.lat - p1.lat) * 111000, 2) +
          Math.pow((p2.lng - p1.lng) * 88000, 2)
        );
        accumulated += dist;

        if (accumulated >= interval) {
          const angleRad = Math.atan2(p2.lng - p1.lng, p2.lat - p1.lat);
          const angleDeg = angleRad * (180 / Math.PI) - 90;
          arrows.push({
            lat: (p1.lat + p2.lat) / 2,
            lng: (p1.lng + p2.lng) / 2,
            angle: angleDeg,
            isGrayed: !!isGrayed,
          });
          accumulated = 0;
        }
      }
    }

    return arrows;
  }, [selectedRoute, selectedRestaurant, stopLegIndex, needsTransit]);

  // 선택한 장소 사이의 경로 로드
  const searchRoutesBetween = useCallback(async (
    origin: PlaceSearchResult,
    destination: PlaceSearchResult
  ) => {
    setIsShowingRoutes(true);
    setLoading("routes");
    setError(null);
    setRouteSearchStatus(null);
    setSelectedRouteType("ALL");
    setRoutes([]);
    try {
      const result = await getRoutes({
        origin: { lat: origin.lat, lng: origin.lng },
        destination: { lat: destination.lat, lng: destination.lng },
      });
      setRoutes(result.routes);
      setRouteSearchStatus(result.status === "FOUND" ? null : result.status);
    } catch (e) {
      setError("경로를 불러오지 못했습니다. 다시 시도해주세요.");
    } finally {
      setLoading(null);
    }
  }, [getRoutes]);

  const loadRoutes = useCallback(() => {
    if (!originPlace || !destinationPlace) return;
    void searchRoutesBetween(originPlace, destinationPlace);
  }, [originPlace, destinationPlace, searchRoutesBetween]);

  const handleSwapRouteEndpoints = useCallback(() => {
    if (!originPlace || !destinationPlace || loading === "routes") return;

    const nextOrigin = destinationPlace;
    const nextDestination = originPlace;
    setOriginPlace(nextOrigin);
    setDestinationPlace(nextDestination);
    void searchRoutesBetween(nextOrigin, nextDestination);
  }, [destinationPlace, loading, originPlace, searchRoutesBetween]);

  // 경로 선택
  const [loadingRestaurants, setLoadingRestaurants] = useState(false);

  const handleRouteSelect = useCallback(
    async (route: Route) => {
      setSelectedRoute(route);
      setSelectedRestaurant(null);
      setExpandedRestaurantId(null);
      setRestaurants([]);
      setSelectedRestaurantCategories([]);
      setRestaurantStops({});
      setAlightingLimitedReason(null);
      setLoadingRestaurants(true);
      setError(null);

      try {
        const result = await getRestaurantsWithStops({
          routeCoords: route.polyline,
          legs: buildStopMatchingLegs(route),
        });
        setRestaurants(result.restaurants);
        const firstRestaurant = result.restaurants[0] ?? null;
        setSelectedRestaurant(firstRestaurant);
        setExpandedRestaurantId(firstRestaurant?.id ?? null);
        setRestaurantStops(result.stops);
        setAlightingLimitedReason(result.alightingLimitedReason);
      } catch (e) {
        setError("식당 목록을 불러오지 못했습니다.");
        setRestaurants([]);
        setRestaurantStops({});
        setAlightingLimitedReason(null);
      } finally {
        setLoadingRestaurants(false);
      }
    },
    [getRestaurantsWithStops]
  );

  // 식당 선택
  const handleRestaurantSelect = useCallback((restaurant: Restaurant) => {
    autoExpandOnScrollRef.current = false;
    autoExpandRequestIdRef.current += 1;
    if (autoExpandTimerRef.current) {
      clearTimeout(autoExpandTimerRef.current);
      autoExpandTimerRef.current = null;
    }
    if (autoExpandEndTimerRef.current) {
      clearTimeout(autoExpandEndTimerRef.current);
      autoExpandEndTimerRef.current = null;
    }
    if (visibleRestaurants.some((r) => r.id === restaurant.id)) {
      pendingRestaurantCenterRef.current = restaurant.id;
      pendingRestaurantSelectedAtRef.current = Date.now();
      const index = visibleRestaurants.findIndex((r) => r.id === restaurant.id);
      if (!restaurantCellRefs.current.has(restaurant.id)) {
        flatListRef.current?.scrollToIndex({ index, animated: true, viewPosition: 0.5 });
      }
      scheduleRestaurantCenterWhenIdle(restaurant.id);
    }
    setSelectedRestaurant(restaurant);
    setExpandedRestaurantId(restaurant.id);
  }, [scheduleRestaurantCenterWhenIdle, visibleRestaurants]);

  const toggleRestaurantCategory = useCallback((category: string) => {
    setSelectedRestaurantCategories((current) => current.includes(category)
      ? current.filter((selected) => selected !== category)
      : [...current, category]
    );
    flatListRef.current?.scrollToOffset({ offset: 0, animated: false });
  }, []);

  // 뒤로가기 (경로 선택 화면으로)
  // 지도 → 경로 선택
  const handleBackToRoutes = useCallback(() => {
    setSelectedRoute(null);
    setRestaurants([]);
    setSelectedRestaurant(null);
  }, []);

  // 경로 선택 → 초기 화면
  const handleBackToIntro = useCallback(() => {
    setRoutes([]);
    setSelectedRoute(null);
    setError(null);
    setIsShowingRoutes(false);
  }, []);

  const handleUseCurrentLocation = useCallback(async () => {
    setCurrentLocationError(null);
    setIsGettingCurrentLocation(true);

    try {
      const permission = await Location.requestForegroundPermissionsAsync();
      if (permission.status !== "granted") {
        setCurrentLocationError(
          permission.canAskAgain
            ? "위치 권한을 허용하면 현재 위치를 출발지로 사용할 수 있어요."
            : "기기 설정에서 위치 권한을 허용해 주세요. 장소를 직접 검색해도 돼요."
        );
        return;
      }

      const position = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.High,
      });
      const { latitude, longitude } = position.coords;
      setOriginPlace({
        id: "current-location",
        name: "현재 위치",
        address: "",
        lat: latitude,
        lng: longitude,
      });
    } catch {
      setCurrentLocationError(
        "현재 위치를 확인하지 못했어요. 위치 서비스를 확인하거나 장소를 직접 검색해 주세요."
      );
    } finally {
      setIsGettingCurrentLocation(false);
    }
  }, []);

  const openPlaceSearch = useCallback((target: "origin" | "destination") => {
    const selectedPlace = target === "origin" ? originPlace : destinationPlace;
    setPlaceSearchTarget(target);
    setPlaceQuery(selectedPlace?.id === "current-location" ? "" : selectedPlace?.name ?? "");
    setPlaceResults([]);
    setPlaceSearchError(false);
    if (target === "origin") setCurrentLocationError(null);
  }, [originPlace, destinationPlace]);

  const selectPlace = useCallback((place: PlaceSearchResult) => {
    const nextOrigin = placeSearchTarget === "origin" ? place : originPlace;
    const nextDestination = placeSearchTarget === "destination" ? place : destinationPlace;

    if (placeSearchTarget === "origin") setOriginPlace(place);
    if (placeSearchTarget === "destination") setDestinationPlace(place);

    Keyboard.dismiss();
    setPlaceSearchTarget(null);
    setPlaceQuery("");
    setPlaceResults([]);

    if (isShowingRoutes && nextOrigin && nextDestination) {
      void searchRoutesBetween(nextOrigin, nextDestination);
    }
  }, [destinationPlace, isShowingRoutes, originPlace, placeSearchTarget, searchRoutesBetween]);

  const handleSwapLocations = useCallback(() => {
    if (!originPlace && !destinationPlace) return;
    setOriginPlace(destinationPlace);
    setDestinationPlace(originPlace);
    setCurrentLocationError(null);
  }, [originPlace, destinationPlace]);

  if (placeSearchTarget) {
    const targetLabel = placeSearchTarget === "origin" ? "출발지" : "도착지";

    return (
      <SafeAreaView style={styles.container} edges={["top", "bottom"]}>
        <View style={styles.placeSearchHeader}>
          <Pressable
            onPress={() => {
              Keyboard.dismiss();
              setPlaceSearchTarget(null);
            }}
            style={styles.placeSearchBack}
            accessibilityRole="button"
            accessibilityLabel="장소 검색 닫기"
          >
            <Ionicons name="arrow-back" size={22} color={colors.textPrimary} />
          </Pressable>
          <Text style={styles.placeSearchTitle}>{targetLabel} 검색</Text>
        </View>

        <View style={styles.placeSearchInput}>
          <Ionicons name="search-outline" size={20} color={colors.textSecondary} />
          <TextInput
            ref={placeSearchInputRef}
            value={placeQuery}
            onChangeText={setPlaceQuery}
            placeholder="장소명을 입력하세요"
            placeholderTextColor={colors.textSecondary}
            style={styles.placeSearchTextInput}
            autoCapitalize="none"
            returnKeyType="search"
            accessibilityLabel={`${targetLabel} 검색어`}
          />
          {placeSearchLoading && <ActivityIndicator size="small" color={colors.primary} />}
          {placeQuery.length > 0 && (
            <Pressable
              onPress={() => {
                setPlaceQuery("");
                placeSearchInputRef.current?.focus();
              }}
              style={styles.placeSearchClearButton}
              accessibilityRole="button"
              accessibilityLabel="검색어 지우기"
              hitSlop={8}
            >
              <Ionicons name="close-circle" size={20} color={colors.textSecondary} />
            </Pressable>
          )}
        </View>

        {placeSearchError ? (
          <View style={styles.placeSearchMessage}>
            <Text style={styles.placeSearchMessageText}>장소를 검색하지 못했어요. 다시 시도해 주세요.</Text>
            <Pressable
              onPress={() => setPlaceSearchRetry((value) => value + 1)}
              style={styles.placeSearchRetry}
              accessibilityRole="button"
            >
              <Text style={styles.placeSearchRetryText}>다시 검색</Text>
            </Pressable>
          </View>
        ) : placeQuery.trim().length === 0 ? null : !placeSearchLoading && placeResults.length === 0 ? (
          <Text style={styles.placeSearchHint}>검색 결과가 없어요. 다른 장소명을 입력해 보세요.</Text>
        ) : (
          <FlatList
            data={placeResults}
            keyExtractor={(item) => item.id}
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={styles.placeSearchResults}
            ItemSeparatorComponent={() => <View style={styles.placeSearchSeparator} />}
            renderItem={({ item }) => (
              <Pressable
                onPress={() => selectPlace(item)}
                style={styles.placeSearchResult}
                accessibilityRole="button"
                accessibilityLabel={`${item.name}, ${item.address}`}
              >
                <Ionicons name="location-outline" size={20} color={colors.textSecondary} />
                <View style={styles.placeSearchResultText}>
                  <Text style={styles.placeSearchResultName}>{item.name}</Text>
                  <Text style={styles.placeSearchResultAddress}>{item.address}</Text>
                </View>
              </Pressable>
            )}
          />
        )}
      </SafeAreaView>
    );
  }

  if (!isShowingRoutes && !selectedRoute) {
    return (
      <SafeAreaView style={styles.container} edges={["bottom"]}>
        <Header />
        <View style={styles.homeContent}>
          <View style={styles.homeHeading}>
            <Text style={styles.homeTitle}>가는 길에 맛있는 한 끼 어때요?</Text>
            <Text style={styles.homeDescription}>
              서울에서 버스나 지하철 타고 가는 길에 들를 식당을 찾아봐요.
            </Text>
          </View>

          <View style={styles.locationForm}>
            <View style={styles.locationGroup}>
              <Text style={styles.locationLabel}>출발지</Text>
              <Pressable
                style={styles.locationField}
                onPress={() => openPlaceSearch("origin")}
                accessibilityRole="button"
                accessibilityLabel="출발지 장소 검색"
              >
                <Ionicons name="search-outline" size={20} color={colors.textSecondary} />
                <View style={styles.locationValue}>
                  <Text
                    numberOfLines={1}
                    style={originPlace ? styles.locationSelectedName : styles.locationPlaceholder}
                  >
                    {originPlace?.name ?? "장소를 검색하세요"}
                  </Text>
                  {originPlace?.address ? (
                    <Text numberOfLines={1} style={styles.locationSelectedAddress}>{originPlace.address}</Text>
                  ) : null}
                </View>
              </Pressable>
              <View style={styles.locationActionsRow}>
                <Pressable
                  style={styles.currentLocationAction}
                  onPress={handleUseCurrentLocation}
                  disabled={isGettingCurrentLocation}
                  accessibilityRole="button"
                  accessibilityState={{ disabled: isGettingCurrentLocation, busy: isGettingCurrentLocation }}
                >
                  {isGettingCurrentLocation ? (
                    <ActivityIndicator size="small" color={colors.primary} />
                  ) : (
                    <Ionicons name="locate-outline" size={18} color={colors.primary} />
                  )}
                  <Text style={styles.currentLocationText}>
                    {isGettingCurrentLocation ? "현재 위치 확인 중..." : "현재 위치 사용"}
                  </Text>
                </Pressable>
                <Pressable
                  style={[
                    styles.locationSwapButton,
                    ((!originPlace && !destinationPlace) || isGettingCurrentLocation) && styles.locationSwapButtonDisabled,
                  ]}
                  onPress={handleSwapLocations}
                  disabled={(!originPlace && !destinationPlace) || isGettingCurrentLocation}
                  accessibilityRole="button"
                  accessibilityLabel="출발지와 도착지 바꾸기"
                  accessibilityState={{ disabled: (!originPlace && !destinationPlace) || isGettingCurrentLocation }}
                >
                  <Ionicons name="swap-vertical-outline" size={18} color={colors.primary} />
                  <Text style={styles.locationSwapButtonText}>출발지·도착지 바꾸기</Text>
                </Pressable>
              </View>
              {currentLocationError && (
                <Text style={styles.currentLocationError}>{currentLocationError}</Text>
              )}
            </View>

            <View style={styles.locationGroup}>
              <Text style={styles.locationLabel}>도착지</Text>
              <Pressable
                style={styles.locationField}
                onPress={() => openPlaceSearch("destination")}
                accessibilityRole="button"
                accessibilityLabel="도착지 장소 검색"
              >
                <Ionicons name="search-outline" size={20} color={colors.textSecondary} />
                <View style={styles.locationValue}>
                  <Text
                    numberOfLines={1}
                    style={destinationPlace ? styles.locationSelectedName : styles.locationPlaceholder}
                  >
                    {destinationPlace?.name ?? "장소를 검색하세요"}
                  </Text>
                  {destinationPlace?.address ? (
                    <Text numberOfLines={1} style={styles.locationSelectedAddress}>{destinationPlace.address}</Text>
                  ) : null}
                </View>
              </Pressable>
            </View>
          </View>

          <View style={styles.homeFooter}>
            <Pressable
              style={[styles.homeSearchButton, (!originPlace || !destinationPlace) && styles.homeSearchButtonDisabled]}
              onPress={loadRoutes}
              disabled={!originPlace || !destinationPlace}
              accessibilityRole="button"
              accessibilityState={{ disabled: !originPlace || !destinationPlace }}
            >
              <Text style={styles.homeSearchButtonText}>경로 찾기</Text>
            </Pressable>
          </View>
        </View>
      </SafeAreaView>
    );
  }

  // 경로 선택 화면
  if (!selectedRoute) {
    return (
      <View style={styles.container}>
        <Header onBack={handleBackToIntro} />
        <View style={styles.screenHeader}>
          <View style={styles.routeHeader}>
            <View style={styles.routeEndpoints}>
              <Pressable
                style={({ pressed }) => [styles.routeEndpoint, pressed && styles.routeEndpointPressed]}
                onPress={() => openPlaceSearch("origin")}
                disabled={loading === "routes"}
                accessibilityRole="button"
                accessibilityLabel={`출발지 변경, 현재 ${originPlace?.name ?? "미선택"}`}
                accessibilityHint="새 장소를 선택하면 경로를 다시 검색합니다."
                accessibilityState={{ disabled: loading === "routes" }}
              >
                <Ionicons name="ellipse-outline" size={19} color={colors.primary} />
                <View style={styles.routeEndpointValue}>
                  <Text numberOfLines={1} style={styles.routeEndpointName}>
                    {originPlace?.name ?? "출발지"}
                  </Text>
                </View>
              </Pressable>

              <View style={styles.routeEndpointConnector} />

              <Pressable
                style={({ pressed }) => [styles.routeEndpoint, pressed && styles.routeEndpointPressed]}
                onPress={() => openPlaceSearch("destination")}
                disabled={loading === "routes"}
                accessibilityRole="button"
                accessibilityLabel={`도착지 변경, 현재 ${destinationPlace?.name ?? "미선택"}`}
                accessibilityHint="새 장소를 선택하면 경로를 다시 검색합니다."
                accessibilityState={{ disabled: loading === "routes" }}
              >
                <Ionicons name="location-outline" size={20} color={colors.primary} />
                <View style={styles.routeEndpointValue}>
                  <Text numberOfLines={1} style={styles.routeEndpointName}>
                    {destinationPlace?.name ?? "도착지"}
                  </Text>
                </View>
              </Pressable>
            </View>

            <Pressable
              style={[
                styles.routeSwapButton,
                loading === "routes" && styles.routeSwapButtonDisabled,
              ]}
              onPress={handleSwapRouteEndpoints}
              disabled={loading === "routes"}
              accessibilityRole="button"
              accessibilityLabel="출발지와 도착지를 바꾸고 경로 다시 찾기"
              accessibilityState={{ disabled: loading === "routes", busy: loading === "routes" }}
            >
              <Ionicons name="swap-vertical-outline" size={20} color={colors.primary} />
            </Pressable>
          </View>
        </View>

        {loading === "routes" ? (
          <View style={styles.loadingContainer}>
            <ActivityIndicator size="large" color={colors.primary} />
            <Text style={styles.loadingText}>경로를 찾고 있습니다...</Text>
          </View>
        ) : error ? (
          <View style={styles.errorContainer}>
            <Text style={styles.errorText}>{error}</Text>
            <Button label="다시 시도" onPress={loadRoutes} variant="secondary" />
          </View>
        ) : routes.length === 0 ? (
          <View style={styles.emptyContainer}>
            <Text style={styles.emptyText}>
              {routeSearchStatus === "ALL_TOO_LONG"
                ? "60분 미만 대중교통 경로를 찾지 못했습니다."
                : "두 장소 사이에 대중교통 경로가 없습니다."}
            </Text>
          </View>
        ) : (
          <View style={styles.routeResults}>
            <RouteTypeTabs
              counts={routeCounts}
              selected={selectedRouteType}
              onSelect={setSelectedRouteType}
            />
            <FlatList
              data={visibleRoutes}
              keyExtractor={(item) => item.id}
              contentContainerStyle={styles.routeList}
              ItemSeparatorComponent={() => <View style={{ height: spacing.lg }} />}
              renderItem={({ item }) => (
                <RouteCard
                  duration={item.summary.duration}
                  walkTime={item.summary.walkTime}
                  transfers={item.summary.transfers}
                  legs={item.legs.map((leg) => ({
                    type: leg.type,
                    time: leg.time,
                    vehicleName: leg.vehicleInfo?.name,
                    vehicleType: leg.vehicleInfo?.type,
                    startName: leg.startName,
                  }))}
                  onPress={() => handleRouteSelect(item)}
                />
              )}
            />
          </View>
        )}
      </View>
    );
  }

  const origin = originPlace!;
  const destination = destinationPlace!;

  // 경로 상세 + 식당 목록 + 지도
  return (
    <View
      style={styles.mapContainer}
      onLayout={(event) => setMapContainerHeight(event.nativeEvent.layout.height)}
    >
      <Header onBack={handleBackToRoutes} />
      {alightingLimitedReason === "OUTSIDE_SEOUL" && (
        <View style={styles.alightingLimitBanner}>
          <Ionicons name="information-circle-outline" size={20} color={colors.primary} />
          <Text style={styles.alightingLimitText}>
            이 경로는 서울 경계를 벗어나 하차 안내를 제공하지 않아요. 경로와 식당은 계속 볼 수 있어요.
          </Text>
        </View>
      )}
      <MapView
        ref={mapRef}
        style={styles.map}
        initialRegion={{
          latitude: origin.lat,
          longitude: origin.lng,
          latitudeDelta: 0.1,
          longitudeDelta: 0.1,
        }}
      >
        {/* 도보 구간: 출발지 → 첫 정류장 */}
        {selectedRoute.legs[0]?.polyline[0] && (
          <Polyline
            coordinates={[
              { latitude: origin.lat, longitude: origin.lng },
              { latitude: selectedRoute.legs[0].polyline[0].lat, longitude: selectedRoute.legs[0].polyline[0].lng },
            ]}
            strokeColor="#888888"
            strokeWidth={5}
            lineDashPattern={[10, 8]}
          />
        )}

        {/* 경로선 - 선택 식당의 하차 지점을 기준으로 이후 구간은 회색 */}
        {selectedRoute.legs.map((leg, index) => {
          // 식당 선택 시: 버스 불필요하면 전체 회색, 아니면 하차 정류장 이후만 회색
          const isGrayed = selectedRestaurant && (!needsTransit || (stopLegIndex >= 0 && index > stopLegIndex));
          const grayColor = "#CCCCCC";
          const stopOnThisLeg = selectedRestaurant && needsTransit && index === stopLegIndex
            ? selectedStopInfo?.stop
            : null;
          const splitLine = stopOnThisLeg
            ? splitPolylineAtPoint(leg.polyline, stopOnThisLeg)
            : null;
          const renderLine = (points: RoutePoint[], suffix: string, grayed: boolean) => points.length >= 2 ? (
            <Polyline
              key={`${index}-${suffix}`}
              coordinates={points.map((p) => ({ latitude: p.lat, longitude: p.lng }))}
              strokeColor={grayed ? grayColor : leg.type === "WALK" ? "#888888" : "#1A3A5C"}
              strokeWidth={leg.type === "WALK" ? 5 : 10}
              lineDashPattern={leg.type === "WALK" ? [10, 8] : undefined}
            />
          ) : null;

          if (splitLine) {
            return (
              <Fragment key={index}>
                {renderLine(splitLine.before, "before-stop", false)}
                {renderLine(splitLine.after, "after-stop", true)}
              </Fragment>
            );
          }

          return renderLine(leg.polyline, "full", !!isGrayed);
        })}

        {/* 도보 구간: 마지막 정류장 → 도착지 (식당 선택 시 회색) */}
        {(() => {
          const lastLeg = selectedRoute.legs[selectedRoute.legs.length - 1];
          const lastPoint = lastLeg?.polyline[lastLeg.polyline.length - 1];
          const isGrayed = selectedRestaurant && stopLegIndex >= 0;
          if (lastPoint) {
            return (
              <Polyline
                coordinates={[
                  { latitude: lastPoint.lat, longitude: lastPoint.lng },
                  { latitude: destination.lat, longitude: destination.lng },
                ]}
                strokeColor={isGrayed ? "#CCCCCC" : "#888888"}
                strokeWidth={5}
                lineDashPattern={[10, 8]}
              />
            );
          }
          return null;
        })()}

        {/* 하차 정류장 → 식당 도보 경로 */}
        {selectedRestaurant && selectedStopInfo?.found && selectedStopInfo.stop && (
          <Polyline
            coordinates={[
              { latitude: selectedStopInfo.stop.lat, longitude: selectedStopInfo.stop.lng },
              { latitude: selectedRestaurant.lat, longitude: selectedRestaurant.lng },
            ]}
            strokeColor={colors.restaurantMarker}
            strokeWidth={5}
            lineDashPattern={[10, 8]}
          />
        )}

        {/* 방향 화살표 */}
        {directionArrows.map((arrow, index) => (
          <Marker
            key={`arrow-${index}`}
            coordinate={{ latitude: arrow.lat, longitude: arrow.lng }}
            anchor={{ x: 0.5, y: 0.5 }}
            flat
          >
            <View
              style={[
                styles.directionArrow,
                { transform: [{ rotate: `${arrow.angle}deg` }] },
              ]}
            >
              <Ionicons
                name="caret-forward"
                size={20}
                color={arrow.isGrayed ? "#CCCCCC" : "#FFFFFF"}
              />
            </View>
          </Marker>
        ))}

        {/* 환승 지점 마커 */}
        {selectedRoute.legs.map((leg, index) => {
          // 중간 도보 구간이 있어도 이전 대중교통 단계 뒤에는 환승 표시
          const previousTransitLeg = selectedRoute.legs
            .slice(0, index)
            .reverse()
            .find((previousLeg) => previousLeg.type !== "WALK");
          const isAfterStop = selectedRestaurant && stopLegIndex >= 0 && index > stopLegIndex;
          if (
            leg.type !== "WALK" &&
            previousTransitLeg &&
            leg.polyline.length > 0
          ) {
            const startPoint = leg.polyline[0];
            return (
              <Marker
                key={`transfer-${index}`}
                coordinate={{ latitude: startPoint.lat, longitude: startPoint.lng }}
                anchor={{ x: 0.5, y: 0.5 }}
              >
                <View style={[styles.transferMarker, isAfterStop && styles.transferMarkerGrayed]}>
                  <Text style={styles.transferMarkerText}>환승</Text>
                </View>
              </Marker>
            );
          }
          return null;
        })}

        {/* 출발/도착 마커 */}
        <Marker
          coordinate={{ latitude: origin.lat, longitude: origin.lng }}
          title="출발"
          pinColor="green"
        />
        <Marker
          coordinate={{ latitude: destination.lat, longitude: destination.lng }}
          title="도착"
          pinColor={selectedRestaurant && stopLegIndex >= 0 ? "gray" : "red"}
        />

        {/* 식당 마커 - 선택된 건 크게/컬러, 나머지는 작게/회색 */}
        {visibleRestaurants.map((restaurant) => {
          const isSelected = selectedRestaurant?.id === restaurant.id;
          return (
            <Marker
              key={restaurant.id}
              coordinate={{ latitude: restaurant.lat, longitude: restaurant.lng }}
              anchor={{ x: 0.5, y: 1 }}
              onPress={() => handleRestaurantSelect(restaurant)}
            >
              <View style={isSelected ? styles.restaurantMarkerSelected : styles.restaurantMarkerDefault}>
                <Ionicons
                  name="restaurant"
                  size={isSelected ? 20 : 12}
                  color={isSelected ? "#FFFFFF" : "#888888"}
                />
              </View>
            </Marker>
          );
        })}

        {/* 하차 정류장 마커 */}
        {selectedStopInfo?.found && selectedStopInfo.stop && (
          <Marker
            coordinate={{
              latitude: selectedStopInfo.stop.lat,
              longitude: selectedStopInfo.stop.lng,
            }}
            title={`하차: ${selectedStopInfo.stop.name}`}
            anchor={{ x: 0.5, y: 1 }}
          >
            <View style={styles.alightStopMarker}>
              <Ionicons name="bus" size={14} color="#FFFFFF" />
              <Text style={styles.alightStopMarkerText}>하차</Text>
            </View>
          </Marker>
        )}
      </MapView>

      {/* 로딩 오버레이 */}
      {loadingRestaurants && (
        <View style={styles.loadingOverlay}>
          <ActivityIndicator size="large" color="#FFFFFF" />
          <Text style={styles.loadingOverlayText}>주변 식당을 찾고 있습니다...</Text>
        </View>
      )}

      {/* 바텀시트 */}
      {!loadingRestaurants && (
        <BottomSheet
          ref={bottomSheetRef}
          animatedPosition={bottomSheetAnimatedPosition}
          snapPoints={snapPoints}
          index={1}
          backgroundStyle={styles.bottomSheetBackground}
          handleIndicatorStyle={styles.bottomSheetIndicator}
          enableContentPanningGesture={false}
          enableHandlePanningGesture={true}
          enableOverDrag={false}
          enableDynamicSizing={false}
          handleComponent={() => (
            <View
              style={styles.bottomSheetHandle}
              onLayout={(event) => setBottomSheetHandleHeight(event.nativeEvent.layout.height)}
            >
              <View style={styles.bottomSheetHandleBar} />
            </View>
          )}
        >
        {restaurants.length === 0 ? (
          <View style={styles.emptyContainer}>
            <Text style={styles.emptyText}>경로 주변에 식당 후보가 없어요.</Text>
          </View>
        ) : visibleRestaurants.length === 0 ? (
          <View style={styles.emptyContainer}>
            <Text style={styles.emptyText}>선택한 카테고리의 식당이 없어요.</Text>
          </View>
        ) : (
          <BottomSheetFlatList
            ref={flatListRef as any}
            data={visibleRestaurants}
            keyExtractor={(item: Restaurant) => item.id}
            contentContainerStyle={{
              paddingBottom: Math.max(0, bottomSpaceForLastCell, bottomSpaceForLastTrigger) + spacing.xxl * 5,
            }}
            stickyHeaderIndices={restaurantCategories.length > 0 ? [0] : undefined}
            ListHeaderComponent={restaurantCategories.length > 0 ? (
              <View
                style={styles.categoryFilterRow}
              >
                <ScrollView
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  contentContainerStyle={styles.categoryFilterList}
                >
                  {restaurantCategories.map((category) => {
                    const isSelected = selectedRestaurantCategories.includes(category);
                    return (
                      <Pressable
                        key={category}
                        accessibilityRole="button"
                        accessibilityLabel={`${category} 카테고리 필터`}
                        accessibilityState={{ selected: isSelected }}
                        onPress={() => toggleRestaurantCategory(category)}
                        style={({ pressed }) => [
                          styles.categoryChip,
                          isSelected && styles.categoryChipSelected,
                          pressed && styles.categoryChipPressed,
                        ]}
                      >
                        <Text style={[styles.categoryChipText, isSelected && styles.categoryChipTextSelected]}>
                          {category}
                        </Text>
                      </Pressable>
                    );
                  })}
                </ScrollView>
              </View>
            ) : undefined}
            ItemSeparatorComponent={() => (
              <View style={{ height: spacing.xl, borderTopWidth: 1, borderTopColor: colors.border, marginTop: spacing.xl }} />
            )}
            renderItem={({ item }: { item: Restaurant }) => {
              const isSelected = selectedRestaurant?.id === item.id;
              const isExpanded = expandedRestaurantId === item.id;
              return (
                <Animated.View
                  style={[
                    isSelected && styles.restaurantCellSelected,
                  ]}
                  ref={(node: ComponentRef<typeof View> | null) => {
                    if (node) restaurantCellRefs.current.set(item.id, node);
                    else restaurantCellRefs.current.delete(item.id);
                  }}
                >
                  <View
                    ref={(node) => {
                      if (node) restaurantTriggerRefs.current.set(item.id, node);
                      else restaurantTriggerRefs.current.delete(item.id);
                    }}
                    onLayout={(event) => {
                      if (item.id === lastVisibleRestaurantId) {
                        setLastRestaurantTriggerHeight(event.nativeEvent.layout.height);
                      }
                    }}
                  >
                    <RestaurantItem
                      name={item.name}
                      category={item.category}
                      address={item.address}
                      distanceFromRoute={item.distanceFromRoute}
                      selected={isSelected}
                      onPress={() => handleRestaurantSelect(item)}
                    />
                  </View>
                  {/* 스크롤 선택은 강조만 바꾸고, 직접 선택한 식당에만 상세 안내를 펼친다. */}
                  {(() => {
                    const itemStopInfo = getStopInfoForRestaurant(item.id);
                    if (!itemStopInfo) return null;

                    const itemStopLegIndex = itemStopInfo.stopLegIndex ?? -1;

                    return (
                      <>
                        {!isExpanded && (
                          <View style={styles.stopSummary}>
                            <Ionicons
                              name={itemStopInfo.stop?.mode === "SUBWAY" ? "train-outline" : "bus-outline"}
                              size={16}
                              color={colors.primary}
                            />
                            {itemStopInfo.found && itemStopInfo.stop ? (
                              <Text style={styles.stopSummaryText} numberOfLines={1}>
                                <Text style={styles.stopSummaryEmphasis}>
                                  {itemStopInfo.stop.mode === "BUS" ? "하차 정류장 " : "하차 역 "}
                                </Text>
                                {itemStopInfo.stop.name}
                              </Text>
                            ) : (
                              <Text style={styles.stopSummaryText}>
                                {alightingLimitedReason === "OUTSIDE_SEOUL"
                                  ? "서울 경계 밖 경로라 하차 안내를 제공하지 않아요"
                                  : "하차 정보를 찾지 못했어요"}
                              </Text>
                            )}
                            {itemStopInfo.found && itemStopInfo.stop && (
                              <Text style={styles.stopSummaryDistance}>
                                직선 {itemStopInfo.stop.distanceFromRestaurant}m
                              </Text>
                            )}
                          </View>
                        )}

                        {isExpanded && (
                          <Animated.View
                            style={styles.routeGuideSection}
                            entering={FadeInDown.duration(170)}
                          >
                            <View style={styles.routeStep}>
                              <View style={[styles.routeStepIcon, styles.routeStepIconOrigin]}>
                                <Ionicons name="location" size={16} color="#FFFFFF" />
                              </View>
                              <Text style={styles.routeStepText}>출발: {origin.name}</Text>
                            </View>

                            {alightingLimitedReason === "OUTSIDE_SEOUL" ? (
                              <View style={styles.routeStep}>
                                <View style={[styles.routeStepIcon, styles.routeStepIconWalk]}>
                                <Ionicons name="information-circle-outline" size={16} color={colors.primary} />
                                </View>
                                <Text style={styles.routeStepText}>
                                  서울 경계 밖 경로라 하차 안내를 제공하지 않아요.
                                </Text>
                              </View>
                            ) : selectedRoute.legs.map((leg, index) => {
                              if (itemStopLegIndex >= 0 && index > itemStopLegIndex) return null;
                              if (leg.type === "WALK" || !leg.vehicleInfo) return null;

                              const isStopLeg = index === itemStopLegIndex;
                              const alightStop = isStopLeg && itemStopInfo.found && itemStopInfo.stop
                                ? itemStopInfo.stop.name
                                : leg.endName;

                              if (leg.startName === alightStop) return null;

                              return (
                                <View key={index} style={styles.routeStep}>
                                  <View style={styles.routeStepIcon}>
                                  <Ionicons name={leg.type === "BUS" ? "bus" : "train"} size={16} color={colors.primary} />
                                  </View>
                                  <Text style={styles.routeStepText}>
                                    <Text style={styles.routeStepBus}>
                                      {leg.type === "BUS" ? "버스 " : "지하철 "}{leg.vehicleInfo.name}
                                    </Text>
                                    {" "}{leg.startName} → {alightStop}
                                  </Text>
                                </View>
                              );
                            })}

                            {itemStopInfo.found && itemStopInfo.stop && (
                              <View style={styles.routeStep}>
                                <View style={[styles.routeStepIcon, styles.routeStepIconWalk]}>
                                <Ionicons name="navigate-outline" size={16} color={colors.primary} />
                                </View>
                                <Text style={styles.routeStepText}>
                                  식당까지 직선거리 {itemStopInfo.stop.distanceFromRestaurant}m
                                </Text>
                              </View>
                            )}

                            <View style={[styles.routeStep]}>
                              <View style={[styles.routeStepIcon, styles.routeStepIconDestination]}>
                                <Ionicons name="restaurant" size={16} color="#FFFFFF" />
                              </View>
                              <Text style={styles.routeStepText}>도착: {item.name}</Text>
                              <Pressable
                                accessibilityRole="link"
                                accessibilityLabel={`${item.name} 상세 보기`}
                                onPress={() => {
                                  setKakaoPlaceLoading(true);
                                  const secureUrl = item.placeUrl.replace(/^http:\/\//i, "https://");
                                  setKakaoPlaceModal({ name: item.name, url: secureUrl });
                                }}
                                style={({ pressed }) => [styles.kakaoMapLink, pressed && styles.kakaoMapLinkPressed]}
                                hitSlop={6}
                              >
                                <Ionicons name="open-outline" size={14} color={colors.primary} />
                                <Text style={styles.kakaoMapLinkText}>상세 보기</Text>
                              </Pressable>
                            </View>
                          </Animated.View>
                        )}
                      </>
                    );
                  })()}
                </Animated.View>
              );
            }}
            onScrollToIndexFailed={(info) => {
              flatListRef.current?.scrollToOffset({
                offset: Math.max(0, info.averageItemLength * info.index),
                animated: false,
              });
              setTimeout(() => {
                flatListRef.current?.scrollToIndex({
                  index: info.index,
                  animated: true,
                  viewPosition: 0.5,
                });
              }, 100);
            }}
            {...({
              onScroll: (event: NativeSyntheticEvent<NativeScrollEvent>) => {
                listScrollOffsetRef.current = event.nativeEvent.contentOffset.y;
                listLastScrolledAtRef.current = Date.now();
                if (listIsDraggingRef.current) autoExpandOnScrollRef.current = true;
                scheduleAutoExpandDuringScroll();
              },
              onScrollBeginDrag: () => {
                listIsDraggingRef.current = true;
                autoExpandOnScrollRef.current = true;
                autoExpandSuppressedUntilRef.current = 0;
                listLastScrolledAtRef.current = Date.now();
                setExpandedRestaurantId(null);
              },
              onScrollEndDrag: () => {
                listIsDraggingRef.current = false;
              },
            } as any)}
            onLayout={(event) => setListViewportHeight(event.nativeEvent.layout.height)}
          />
        )}
        <Animated.View
          ref={centerAnchorRef}
          pointerEvents="none"
          style={[styles.bottomSheetCenterAnchor, bottomSheetCenterAnchorStyle]}
        />
      </BottomSheet>
      )}
      <Modal
        visible={kakaoPlaceModal !== null}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setKakaoPlaceModal(null)}
        onDismiss={() => setKakaoPlaceLoading(false)}
      >
        <SafeAreaView style={styles.kakaoPlaceModal} edges={["top", "bottom"]}>
          <View style={styles.kakaoPlaceModalHeader}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="카카오맵 상세 닫기"
              onPress={() => setKakaoPlaceModal(null)}
              style={styles.kakaoPlaceCloseButton}
            >
              <Ionicons name="close" size={24} color={colors.textPrimary} />
            </Pressable>
            <Text numberOfLines={1} style={styles.kakaoPlaceModalTitle}>
              {kakaoPlaceModal?.name ?? "장소 상세"}
            </Text>
            <View style={styles.kakaoPlaceHeaderSpacer} />
          </View>
          {kakaoPlaceModal && (
            <View style={styles.kakaoPlaceWebViewContainer}>
              <WebView
                key={kakaoPlaceModal.url}
                source={{ uri: kakaoPlaceModal.url }}
                style={styles.kakaoPlaceWebView}
                onLoadStart={() => setKakaoPlaceLoading(true)}
                onLoadEnd={() => setKakaoPlaceLoading(false)}
                startInLoadingState
                javaScriptEnabled
                domStorageEnabled
              />
              {kakaoPlaceLoading && (
                <View style={styles.kakaoPlaceLoading}>
                  <ActivityIndicator size="large" color={colors.primary} />
                  <Text style={styles.kakaoPlaceLoadingText}>카카오맵을 불러오는 중...</Text>
                </View>
              )}
            </View>
          )}
        </SafeAreaView>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },
  kakaoPlaceModal: {
    flex: 1,
    backgroundColor: colors.surface,
  },
  kakaoPlaceModalHeader: {
    minHeight: 52,
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  kakaoPlaceCloseButton: {
    width: 44,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
  },
  kakaoPlaceModalTitle: {
    ...typography.subtitle,
    color: colors.textPrimary,
    flex: 1,
    textAlign: "center",
  },
  kakaoPlaceHeaderSpacer: {
    width: 44,
  },
  kakaoPlaceWebViewContainer: {
    flex: 1,
  },
  kakaoPlaceWebView: {
    flex: 1,
    backgroundColor: colors.surface,
  },
  kakaoPlaceLoading: {
    ...StyleSheet.absoluteFill,
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.md,
    backgroundColor: colors.surface,
  },
  kakaoPlaceLoadingText: {
    ...typography.caption,
    color: colors.textSecondary,
  },
  homeContent: {
    flex: 1,
    padding: spacing.xl,
    paddingTop: spacing.xxl,
  },
  homeHeading: {
    marginBottom: spacing.xxl,
  },
  homeTitle: {
    ...typography.title,
    color: colors.textPrimary,
  },
  homeDescription: {
    ...typography.caption,
    color: colors.textSecondary,
    marginTop: spacing.sm,
  },
  locationForm: {
    gap: spacing.xl,
  },
  locationGroup: {
    gap: spacing.sm,
  },
  locationLabel: {
    fontSize: 16,
    lineHeight: 22,
    color: colors.textPrimary,
    fontWeight: "700",
  },
  locationField: {
    height: 64,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
  },
  locationValue: {
    flex: 1,
    justifyContent: "center",
  },
  locationPlaceholder: {
    ...typography.body,
    color: colors.textSecondary,
  },
  locationSelectedName: {
    ...typography.body,
    color: colors.textPrimary,
    fontWeight: "600",
  },
  locationSelectedAddress: {
    ...typography.small,
    color: colors.textSecondary,
    marginTop: spacing.xs,
  },
  currentLocationAction: {
    minHeight: 44,
    alignSelf: "flex-start",
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
    paddingHorizontal: spacing.xs,
  },
  currentLocationText: {
    ...typography.caption,
    color: colors.primary,
    fontWeight: "600",
  },
  currentLocationError: {
    ...typography.small,
    color: colors.error,
  },
  locationActionsRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  locationSwapButton: {
    minHeight: 40,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.xs,
    paddingHorizontal: spacing.sm,
    borderRadius: radius.sm,
  },
  locationSwapButtonDisabled: {
    opacity: 0.4,
  },
  locationSwapButtonText: {
    ...typography.small,
    color: colors.primary,
    fontWeight: "600",
  },
  homeFooter: {
    flex: 1,
    justifyContent: "flex-end",
    paddingBottom: spacing.lg,
  },
  homeSearchButton: {
    minHeight: 52,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.md,
    backgroundColor: colors.primary,
  },
  homeSearchButtonDisabled: {
    opacity: 0.45,
  },
  homeSearchButtonText: {
    ...typography.body,
    color: colors.surface,
    fontWeight: "700",
  },
  placeSearchHeader: {
    minHeight: 56,
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: spacing.md,
  },
  placeSearchBack: {
    width: 44,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
  },
  placeSearchTitle: {
    ...typography.subtitle,
    color: colors.textPrimary,
    marginLeft: spacing.sm,
  },
  placeSearchInput: {
    height: 56,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    marginHorizontal: spacing.lg,
    marginTop: spacing.md,
    paddingHorizontal: spacing.lg,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.primary,
  },
  placeSearchTextInput: {
    flex: 1,
    height: "100%",
    fontFamily: appFontFamily,
    fontSize: typography.body.fontSize,
    fontWeight: "400",
    paddingVertical: 0,
    color: colors.textPrimary,
  },
  placeSearchClearButton: {
    width: 32,
    height: 40,
    alignItems: "center",
    justifyContent: "center",
  },
  placeSearchHint: {
    ...typography.caption,
    color: colors.textSecondary,
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.lg,
  },
  placeSearchMessage: {
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.lg,
    gap: spacing.md,
  },
  placeSearchMessageText: {
    ...typography.caption,
    color: colors.error,
  },
  placeSearchRetry: {
    alignSelf: "flex-start",
    paddingVertical: spacing.sm,
  },
  placeSearchRetryText: {
    ...typography.caption,
    color: colors.primary,
    fontWeight: "600",
  },
  placeSearchResults: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    paddingBottom: spacing.xl,
  },
  placeSearchSeparator: {
    height: 1,
    backgroundColor: colors.border,
    marginLeft: 36,
  },
  placeSearchResult: {
    minHeight: 68,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    paddingVertical: spacing.md,
  },
  placeSearchResultText: {
    flex: 1,
    gap: spacing.xs,
  },
  placeSearchResultName: {
    ...typography.body,
    color: colors.textPrimary,
    fontWeight: "600",
  },
  placeSearchResultAddress: {
    ...typography.small,
    color: colors.textSecondary,
  },
  screenHeader: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  routeHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
  },
  alightingLimitBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    backgroundColor: colors.primaryLight,
  },
  alightingLimitText: {
    ...typography.small,
    color: colors.textPrimary,
    flex: 1,
  },
  routeEndpoints: {
    flexDirection: "column",
    flex: 1,
    minWidth: 0,
  },
  routeEndpoint: {
    minHeight: 48,
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
    gap: spacing.md,
  },
  routeEndpointPressed: {
    opacity: 0.72,
  },
  routeEndpointValue: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    flex: 1,
  },
  routeEndpointName: {
    ...typography.body,
    color: colors.textPrimary,
    fontWeight: "600",
    flex: 1,
  },
  routeEndpointConnector: {
    height: spacing.sm,
    width: 1,
    marginLeft: spacing.xl,
    backgroundColor: colors.border,
  },
  routeSwapButton: {
    width: 44,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  routeSwapButtonDisabled: {
    opacity: 0.5,
  },
  routeResults: {
    flex: 1,
  },
  routeList: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.lg,
  },
  loadingContainer: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    padding: spacing.xl,
  },
  loadingText: {
    ...typography.body,
    color: colors.textSecondary,
    marginTop: spacing.md,
  },
  errorContainer: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    padding: spacing.xl,
  },
  errorText: {
    ...typography.body,
    color: colors.error,
    marginBottom: spacing.lg,
    textAlign: "center",
  },
  emptyContainer: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    padding: spacing.xl,
  },
  emptyText: {
    ...typography.body,
    color: colors.textSecondary,
    textAlign: "center",
  },
  mapContainer: {
    flex: 1,
  },
  map: {
    flex: 1,
  },
  loadingOverlay: {
    ...StyleSheet.absoluteFill,
    backgroundColor: "rgba(0, 0, 0, 0.5)",
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.md,
  },
  loadingOverlayText: {
    ...typography.body,
    color: "#FFFFFF",
  },
  transferMarker: {
    backgroundColor: "#1A3A5C",
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 2,
    borderColor: "#FFFFFF",
  },
  transferMarkerText: {
    color: "#FFFFFF",
    fontSize: 12,
    fontWeight: "700",
  },
  transferMarkerGrayed: {
    backgroundColor: "#CCCCCC",
  },
  restaurantMarkerSelected: {
    backgroundColor: colors.primary,
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 3,
    borderColor: "#FFFFFF",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.3,
    shadowRadius: 3,
    elevation: 5,
  },
  restaurantMarkerDefault: {
    backgroundColor: "#E0E0E0",
    width: 24,
    height: 24,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 2,
    borderColor: "#FFFFFF",
  },
  bottomSheetHandle: {
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
    alignItems: "center",
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  bottomSheetHandleBar: {
    width: 40,
    height: 4,
    backgroundColor: colors.border,
    borderRadius: 2,
    marginBottom: spacing.sm,
  },
  categoryFilterRow: {
    justifyContent: "center",
    paddingVertical: spacing.md,
    backgroundColor: colors.surface,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  bottomSheetCenterAnchor: {
    position: "absolute",
    left: 0,
    width: 1,
    height: 1,
    opacity: 0,
  },
  categoryFilterList: {
    alignItems: "center",
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
  },
  categoryChip: {
    minHeight: 34,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: spacing.xs,
    paddingHorizontal: spacing.md,
    borderRadius: 17,
    borderWidth: 1,
    borderColor: "transparent",
    backgroundColor: colors.background,
  },
  categoryChipSelected: {
    borderColor: colors.primary,
    backgroundColor: colors.primaryLight,
  },
  categoryChipPressed: {
    opacity: 0.72,
  },
  categoryChipText: {
    ...typography.small,
    color: colors.textSecondary,
    fontWeight: "500",
  },
  categoryChipTextSelected: {
    color: colors.primary,
    fontWeight: "700",
  },
  bottomSheetHandleText: {
    ...typography.subtitle,
    color: colors.textPrimary,
  },
  bottomSheetBackground: {
    backgroundColor: colors.surface,
  },
  bottomSheetIndicator: {
    backgroundColor: colors.border,
    width: 40,
  },
  restaurantCellSelected: {
    backgroundColor: colors.primaryLight,
  },
  routeGuideSection: {
    padding: spacing.lg,
    paddingTop: spacing.sm,
    paddingBottom: spacing.lg,
    marginBottom: spacing.xs,
  },
  routeGuideSectionSelected: {
    backgroundColor: colors.primaryLight,
  },
  stopSummary: {
    minHeight: 40,
    marginHorizontal: spacing.lg,
    marginBottom: spacing.md,
    paddingHorizontal: spacing.md,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    borderRadius: radius.sm,
    backgroundColor: colors.background,
  },
  stopSummaryText: {
    ...typography.small,
    color: colors.textPrimary,
    flex: 1,
  },
  stopSummaryEmphasis: {
    color: colors.primary,
    fontWeight: "700",
  },
  stopSummaryDistance: {
    ...typography.small,
    color: colors.textSecondary,
  },
  alightStopMarker: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 9,
    paddingVertical: 6,
    borderRadius: 16,
    borderWidth: 2,
    borderColor: colors.surface,
    backgroundColor: colors.primary,
    elevation: 4,
  },
  alightStopMarkerText: {
    ...typography.small,
    color: colors.surface,
    fontWeight: "700",
  },
  routeGuideTitle: {
    ...typography.caption,
    color: colors.textSecondary,
    marginBottom: spacing.md,
  },
  routeStep: {
    flexDirection: "row",
    alignItems: "center",
    marginBottom: spacing.sm,
  },
  routeStepIcon: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: colors.primaryLight,
    alignItems: "center",
    justifyContent: "center",
    marginRight: spacing.md,
  },
  routeStepText: {
    ...typography.body,
    color: colors.textPrimary,
    flex: 1,
  },
  kakaoMapLink: {
    minHeight: 32,
    flexDirection: "row",
    alignItems: "center",
    gap: 3,
    marginLeft: spacing.sm,
    paddingHorizontal: spacing.xs,
    borderRadius: 8,
  },
  kakaoMapLinkPressed: {
    backgroundColor: colors.background,
  },
  kakaoMapLinkText: {
    ...typography.small,
    color: colors.primary,
    fontWeight: "600",
  },
  routeStepBus: {
    fontWeight: "600",
    color: colors.primary,
  },
  routeStepIconOrigin: {
    backgroundColor: "green",
  },
  routeStepIconWalk: {
    backgroundColor: "#D7E8E5",
  },
  routeStepIconDestination: {
    backgroundColor: colors.restaurantMarker,
  },
  directionArrow: {
    backgroundColor: "transparent",
  },
  listHeader: {
    padding: spacing.lg,
    paddingBottom: spacing.sm,
  },
  listHeaderText: {
    ...typography.caption,
    color: colors.textSecondary,
  },
});
