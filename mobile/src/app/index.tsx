import { useState, useCallback, useRef, useMemo, useEffect } from "react";
import { Dimensions } from "react-native";
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  ActivityIndicator,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import MapView, { Marker, Polyline } from "react-native-maps";
import BottomSheet, { BottomSheetFlatList } from "@gorhom/bottom-sheet";
import { useAction, useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import { colors, typography, spacing, radius } from "../lib/theme";
import { Button, Header, RouteCard, RestaurantItem } from "../components";

// 고정된 출발지-도착지 (데모용)
const DEMO_ORIGIN = { lat: 37.5665, lng: 126.978 }; // 서울시청
const DEMO_DESTINATION = { lat: 37.4979, lng: 127.0276 }; // 강남역
const DEMO_ORIGIN_NAME = "서울시청";
const DEMO_DESTINATION_NAME = "강남역";

type Route = {
  id: string;
  summary: {
    duration: number;
    busCount: number;
    walkTime: number;
    transfers: number;
  };
  legs: Array<{
    type: "WALK" | "BUS";
    startName: string;
    endName: string;
    time: number;
    distance: number;
    polyline: Array<{ lat: number; lng: number }>;
    busInfo?: { busNo: string; busType: string };
    stations?: Array<{ name: string; lat: number; lng: number }>;
  }>;
  polyline: Array<{ lat: number; lng: number }>;
};

type Restaurant = {
  id: string;
  name: string;
  category: string;
  address: string;
  lat: number;
  lng: number;
  distanceFromRoute: number;
  routeProgress: number; // 경로 진행률 (0~1)
};

export default function HomeScreen() {
  const [routes, setRoutes] = useState<Route[]>([]);
  const [selectedRoute, setSelectedRoute] = useState<Route | null>(null);
  const [restaurants, setRestaurants] = useState<Restaurant[]>([]);
  const [selectedRestaurant, setSelectedRestaurant] = useState<Restaurant | null>(null);
  const [loading, setLoading] = useState<"routes" | "restaurants" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const bottomSheetRef = useRef<BottomSheet>(null);
  const mapRef = useRef<MapView>(null);
  const flatListRef = useRef<FlatList<Restaurant>>(null);
  const snapPoints = useMemo(() => ["25%", "50%", "90%"], []);

  // 지도에서 선택한 경우 자동 선택을 일시적으로 비활성화
  const isMapSelectionRef = useRef(false);
  const autoSelectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingSelectionRef = useRef<Restaurant | null>(null);

  // 자동 선택을 위한 viewability 설정
  const viewabilityConfig = useRef({
    itemVisiblePercentThreshold: 50,
  }).current;

  const onViewableItemsChanged = useRef(({ viewableItems }: { viewableItems: Array<{ item: Restaurant }> }) => {
    // 지도에서 선택한 경우 자동 선택 무시
    if (isMapSelectionRef.current) return;

    if (viewableItems.length > 0 && viewableItems[0].item) {
      const topItem = viewableItems[0].item;
      pendingSelectionRef.current = topItem;

      // 디바운싱: 스크롤 멈춘 후 200ms 뒤에 선택
      if (autoSelectTimeoutRef.current) {
        clearTimeout(autoSelectTimeoutRef.current);
      }
      autoSelectTimeoutRef.current = setTimeout(() => {
        if (pendingSelectionRef.current) {
          setSelectedRestaurant((prev) => {
            if (!prev || prev.id !== pendingSelectionRef.current?.id) {
              return pendingSelectionRef.current;
            }
            return prev;
          });
        }
      }, 200);
    }
  }).current;

  // 선택된 식당 변경 시 지도 이동
  useEffect(() => {
    if (selectedRestaurant) {
      const latitudeDelta = 0.012;
      const latitudeOffset = latitudeDelta * 0.4;
      mapRef.current?.animateToRegion({
        latitude: selectedRestaurant.lat - latitudeOffset,
        longitude: selectedRestaurant.lng,
        latitudeDelta,
        longitudeDelta: 0.012,
      });
    }
  }, [selectedRestaurant]);

  const getRoutes = useAction(api.routes.getRoutes);
  const getRestaurants = useAction(api.restaurants.getRestaurants);

  // 지도 영역 조정 (바텀시트 50% 높이 고려)
  const screenHeight = Dimensions.get("window").height;
  const bottomSheetHeight = screenHeight * 0.5; // 50% snap point

  // 식당 로드 완료 시 첫 번째 식당 근처로 줌
  useEffect(() => {
    if (restaurants.length > 0 && mapRef.current) {
      const firstRestaurant = restaurants[0];
      setTimeout(() => {
        mapRef.current?.animateToRegion({
          latitude: firstRestaurant.lat - 0.008, // 바텀시트 고려 오프셋
          longitude: firstRestaurant.lng,
          latitudeDelta: 0.02,
          longitudeDelta: 0.02,
        });
      }, 100);
    }
  }, [restaurants]);

  // 각 leg의 경로 진행률 계산
  const legProgressRanges = useMemo(() => {
    if (!selectedRoute) return [];

    let totalLength = 0;
    const legLengths: number[] = [];

    for (const leg of selectedRoute.legs) {
      let legLength = 0;
      for (let i = 1; i < leg.polyline.length; i++) {
        const p1 = leg.polyline[i - 1];
        const p2 = leg.polyline[i];
        legLength += Math.sqrt(
          Math.pow((p2.lat - p1.lat) * 111000, 2) +
          Math.pow((p2.lng - p1.lng) * 88000, 2)
        );
      }
      legLengths.push(legLength);
      totalLength += legLength;
    }

    // 각 leg의 끝 진행률 계산
    const ranges: number[] = [];
    let accumulated = 0;
    for (const len of legLengths) {
      accumulated += len;
      ranges.push(totalLength > 0 ? accumulated / totalLength : 0);
    }
    return ranges;
  }, [selectedRoute]);

  // 모든 식당에 대한 하차 정류장 일괄 조회
  const nearestStopsArgs = useMemo(() => {
    if (!selectedRoute || restaurants.length === 0) return "skip" as const;

    return {
      restaurants: restaurants.map((r) => ({
        id: r.id,
        lat: r.lat,
        lng: r.lng,
        routeProgress: r.routeProgress,
      })),
      legs: selectedRoute.legs.map((leg, index) => ({
        type: leg.type,
        startProgress: index === 0 ? 0 : (legProgressRanges[index - 1] || 0),
        stations: (leg.stations || []).map((s) => ({
          name: s.name,
          lat: s.lat,
          lng: s.lng,
        })),
      })),
    };
  }, [selectedRoute, restaurants, legProgressRanges]);

  const nearestStopsData = useQuery(
    api.busStops.getNearestStopsForRestaurants,
    nearestStopsArgs
  );

  // 특정 식당의 정류장 정보 가져오기
  const getStopInfoForRestaurant = useCallback((restaurantId: string) => {
    if (!nearestStopsData) return null;
    return nearestStopsData[restaurantId] || null;
  }, [nearestStopsData]);

  // 선택된 식당의 정류장 정보 (지도 하이라이팅용)
  const selectedStopInfo = selectedRestaurant ? getStopInfoForRestaurant(selectedRestaurant.id) : null;
  const stopLegIndex = selectedStopInfo?.stopLegIndex ?? -1;

  // 버스가 실제로 필요한지 확인 (승차/하차 정류장이 다른 버스 구간이 있는지)
  const needsBus = useMemo(() => {
    if (!selectedRestaurant || !selectedRoute || !selectedStopInfo?.found) return true;
    if (stopLegIndex < 0) return false;

    for (let i = 0; i <= stopLegIndex; i++) {
      const leg = selectedRoute.legs[i];
      if (leg.type !== "BUS" || !leg.busInfo) continue;

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
      const isGrayed = selectedRestaurant && (!needsBus || (stopLegIndex >= 0 && legIndex > stopLegIndex));

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
  }, [selectedRoute, selectedRestaurant, stopLegIndex, needsBus]);

  // 경로 로드
  const loadRoutes = useCallback(async () => {
    setLoading("routes");
    setError(null);
    try {
      const result = await getRoutes({
        origin: DEMO_ORIGIN,
        destination: DEMO_DESTINATION,
      });
      setRoutes(result);
    } catch (e) {
      setError("경로를 불러오지 못했습니다. 다시 시도해주세요.");
    } finally {
      setLoading(null);
    }
  }, [getRoutes]);

  // 경로 선택
  const [loadingRestaurants, setLoadingRestaurants] = useState(false);

  const handleRouteSelect = useCallback(
    async (route: Route) => {
      setSelectedRoute(route);
      setSelectedRestaurant(null);
      setLoadingRestaurants(true);
      setError(null);

      try {
        const result = await getRestaurants({
          routeCoords: route.polyline,
        });
        setRestaurants(result);
      } catch (e) {
        setError("식당 목록을 불러오지 못했습니다.");
        setRestaurants([]);
      } finally {
        setLoadingRestaurants(false);
      }
    },
    [getRestaurants]
  );

  // 식당 선택
  const handleRestaurantSelect = useCallback((restaurant: Restaurant, fromMap = false) => {
    setSelectedRestaurant(restaurant);

    if (fromMap) {
      // 지도에서 선택한 경우: 자동 선택 일시 비활성화 + 리스트 스크롤
      isMapSelectionRef.current = true;

      const index = restaurants.findIndex((r) => r.id === restaurant.id);
      if (index >= 0 && flatListRef.current) {
        flatListRef.current.scrollToIndex({
          index,
          animated: true,
          viewPosition: 0, // 상단에 위치
        });
      }

      // 스크롤 완료 후 자동 선택 다시 활성화 (500ms 후)
      setTimeout(() => {
        isMapSelectionRef.current = false;
      }, 500);
    }
  }, [restaurants]);

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
  }, []);

  // 초기 로드
  if (routes.length === 0 && !loading && !error) {
    return (
      <View style={styles.container}>
        <Header />
        <View style={styles.introContainer}>
          <View style={styles.routeInfo}>
            <Text style={styles.routeLabel}>출발</Text>
            <Text style={styles.routeValue}>{DEMO_ORIGIN_NAME}</Text>
          </View>
          <View style={styles.routeInfo}>
            <Text style={styles.routeLabel}>도착</Text>
            <Text style={styles.routeValue}>{DEMO_DESTINATION_NAME}</Text>
          </View>
          <Text style={styles.demoNotice}>
            * 데모용 고정 경로입니다
          </Text>
          <Button label="경로 찾기" onPress={loadRoutes} />
          <Text style={styles.devNotice}>
            이 화면은 추후 출발지/도착지 입력 화면으로 대체될 예정입니다.
          </Text>
        </View>
      </View>
    );
  }

  // 경로 선택 화면
  if (!selectedRoute) {
    return (
      <View style={styles.container}>
        <Header onBack={handleBackToIntro} />
        <View style={styles.screenHeader}>
          <Text style={styles.screenTitle}>
            {DEMO_ORIGIN_NAME} → {DEMO_DESTINATION_NAME}
          </Text>
          <Text style={styles.screenSubtitle}>경로를 선택하세요</Text>
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
              순수 버스 경로를 찾지 못했습니다.
            </Text>
          </View>
        ) : (
          <FlatList
            data={routes}
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
                  busNo: leg.busInfo?.busNo,
                  busType: leg.busInfo?.busType,
                  startName: leg.startName,
                }))}
                onPress={() => handleRouteSelect(item)}
              />
            )}
          />
        )}
      </View>
    );
  }

  // 경로 상세 + 식당 목록 + 지도
  return (
    <View style={styles.mapContainer}>
      <Header onBack={handleBackToRoutes} />
      <MapView
        ref={mapRef}
        style={styles.map}
        initialRegion={{
          latitude: DEMO_ORIGIN.lat,
          longitude: DEMO_ORIGIN.lng,
          latitudeDelta: 0.1,
          longitudeDelta: 0.1,
        }}
      >
        {/* 도보 구간: 출발지 → 첫 정류장 */}
        {selectedRoute.legs[0]?.polyline[0] && (
          <Polyline
            coordinates={[
              { latitude: DEMO_ORIGIN.lat, longitude: DEMO_ORIGIN.lng },
              { latitude: selectedRoute.legs[0].polyline[0].lat, longitude: selectedRoute.legs[0].polyline[0].lng },
            ]}
            strokeColor="#888888"
            strokeWidth={5}
            lineDashPattern={[10, 8]}
          />
        )}

        {/* 경로선 - 구간별로 다른 스타일, 식당 선택 시 하차 정류장 이후는 회색 */}
        {selectedRoute.legs.map((leg, index) => {
          // 식당 선택 시: 버스 불필요하면 전체 회색, 아니면 하차 정류장 이후만 회색
          const isGrayed = selectedRestaurant && (!needsBus || (stopLegIndex >= 0 && index > stopLegIndex));
          const grayColor = "#CCCCCC";

          return (
            <Polyline
              key={index}
              coordinates={leg.polyline.map((p) => ({
                latitude: p.lat,
                longitude: p.lng,
              }))}
              strokeColor={
                isGrayed
                  ? grayColor
                  : leg.type === "WALK"
                    ? "#888888"
                    : "#1A3A5C"
              }
              strokeWidth={leg.type === "WALK" ? 5 : 10}
              lineDashPattern={leg.type === "WALK" ? [10, 8] : undefined}
            />
          );
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
                  { latitude: DEMO_DESTINATION.lat, longitude: DEMO_DESTINATION.lng },
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
          // 첫 구간이 아니고 버스 구간인 경우 시작점에 환승 마커 표시
          const prevLeg = selectedRoute.legs[index - 1];
          const isAfterStop = selectedRestaurant && stopLegIndex >= 0 && index > stopLegIndex;
          if (index > 0 && leg.type === "BUS" && prevLeg?.type === "BUS" && leg.polyline.length > 0) {
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
          coordinate={{ latitude: DEMO_ORIGIN.lat, longitude: DEMO_ORIGIN.lng }}
          title="출발"
          pinColor="green"
        />
        <Marker
          coordinate={{ latitude: DEMO_DESTINATION.lat, longitude: DEMO_DESTINATION.lng }}
          title="도착"
          pinColor={selectedRestaurant && stopLegIndex >= 0 ? "gray" : "red"}
        />

        {/* 식당 마커 - 선택된 건 크게/컬러, 나머지는 작게/회색 */}
        {restaurants.map((restaurant) => {
          const isSelected = selectedRestaurant?.id === restaurant.id;
          return (
            <Marker
              key={restaurant.id}
              coordinate={{ latitude: restaurant.lat, longitude: restaurant.lng }}
              anchor={{ x: 0.5, y: 1 }}
              onPress={() => handleRestaurantSelect(restaurant, true)}
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
            pinColor="blue"
          />
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
          snapPoints={snapPoints}
          index={1}
          backgroundStyle={styles.bottomSheetBackground}
          handleIndicatorStyle={styles.bottomSheetIndicator}
          enableContentPanningGesture={false}
          enableHandlePanningGesture={true}
          enableOverDrag={false}
          enableDynamicSizing={false}
          handleComponent={() => (
            <View style={styles.bottomSheetHandle}>
              <View style={styles.bottomSheetHandleBar} />
            </View>
          )}
        >
        {/* 식당 목록 */}
        {restaurants.length === 0 ? (
          <View style={styles.emptyContainer}>
            <Text style={styles.emptyText}>
              경로 주변 1km 이내에 식당이 없습니다.
            </Text>
          </View>
        ) : (
          <BottomSheetFlatList
            ref={flatListRef as any}
            data={restaurants}
            keyExtractor={(item) => item.id}
            ItemSeparatorComponent={() => (
              <View style={{ height: spacing.xl, borderTopWidth: 1, borderTopColor: colors.border, marginTop: spacing.md }} />
            )}
            renderItem={({ item }) => {
              const isSelected = selectedRestaurant?.id === item.id;
              return (
                <View>
                  <RestaurantItem
                    name={item.name}
                    category={item.category}
                    address={item.address}
                    distanceFromRoute={item.distanceFromRoute}
                    selected={isSelected}
                    onPress={() => handleRestaurantSelect(item)}
                  />
                  {/* 모든 식당에 경로 안내 표시 */}
                  {(() => {
                    const itemStopInfo = getStopInfoForRestaurant(item.id);
                    if (!itemStopInfo) return null;

                    const itemStopLegIndex = itemStopInfo.stopLegIndex ?? -1;

                    return (
                      <View style={[styles.routeGuideSection, isSelected && styles.routeGuideSectionSelected]}>
                        <Text style={styles.routeGuideTitle}>가는 방법</Text>

                        <View style={styles.routeStep}>
                          <View style={[styles.routeStepIcon, styles.routeStepIconOrigin]}>
                            <Ionicons name="location" size={16} color="#FFFFFF" />
                          </View>
                          <Text style={styles.routeStepText}>출발: {DEMO_ORIGIN_NAME}</Text>
                        </View>

                        {selectedRoute.legs.map((leg, index) => {
                          if (itemStopLegIndex >= 0 && index > itemStopLegIndex) return null;
                          if (leg.type !== "BUS" || !leg.busInfo) return null;

                          const isStopLeg = index === itemStopLegIndex;
                          const alightStop = isStopLeg && itemStopInfo.found && itemStopInfo.stop
                            ? itemStopInfo.stop.name
                            : leg.endName;

                          if (leg.startName === alightStop) return null;

                          return (
                            <View key={index} style={styles.routeStep}>
                              <View style={styles.routeStepIcon}>
                                <Ionicons name="bus" size={16} color={colors.primary} />
                              </View>
                              <Text style={styles.routeStepText}>
                                <Text style={styles.routeStepBus}>{leg.busInfo.busNo}</Text>
                                {" "}{leg.startName} → {alightStop}
                              </Text>
                            </View>
                          );
                        })}

                        {itemStopInfo.found && itemStopInfo.stop && (
                          <View style={styles.routeStep}>
                            <View style={[styles.routeStepIcon, styles.routeStepIconWalk]}>
                              <Ionicons name="walk" size={16} color={colors.textSecondary} />
                            </View>
                            <Text style={styles.routeStepText}>
                              도보 {itemStopInfo.stop.distanceFromRestaurant}m
                            </Text>
                          </View>
                        )}

                        <View style={styles.routeStep}>
                          <View style={[styles.routeStepIcon, styles.routeStepIconDestination]}>
                            <Ionicons name="restaurant" size={16} color="#FFFFFF" />
                          </View>
                          <Text style={styles.routeStepText}>도착: {item.name}</Text>
                        </View>
                      </View>
                    );
                  })()}
                </View>
              );
            }}
            onViewableItemsChanged={onViewableItemsChanged}
            viewabilityConfig={viewabilityConfig}
            onScrollToIndexFailed={(info) => {
              // 리스트가 아직 렌더링 중일 때의 fallback
              setTimeout(() => {
                flatListRef.current?.scrollToIndex({
                  index: info.index,
                  animated: true,
                  viewPosition: 0,
                });
              }, 100);
            }}
          />
        )}
      </BottomSheet>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },
  introContainer: {
    flex: 1,
    padding: spacing.xl,
    justifyContent: "center",
  },
  routeInfo: {
    flexDirection: "row",
    alignItems: "center",
    marginBottom: spacing.md,
  },
  routeLabel: {
    ...typography.caption,
    color: colors.textSecondary,
    width: 40,
  },
  routeValue: {
    ...typography.subtitle,
    color: colors.textPrimary,
  },
  demoNotice: {
    ...typography.small,
    color: colors.textSecondary,
    marginTop: spacing.lg,
    marginBottom: spacing.xl,
    textAlign: "center",
  },
  devNotice: {
    ...typography.small,
    color: colors.textSecondary,
    marginTop: spacing.xxl,
    textAlign: "center",
    fontStyle: "italic",
  },
  screenHeader: {
    padding: spacing.lg,
    alignItems: "center",
  },
  screenTitle: {
    ...typography.title,
    color: colors.textPrimary,
    textAlign: "center",
  },
  screenSubtitle: {
    ...typography.body,
    color: colors.textSecondary,
    marginTop: spacing.xs,
    textAlign: "center",
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
  routeGuideSection: {
    padding: spacing.lg,
    paddingTop: spacing.sm,
    backgroundColor: colors.surface,
    marginBottom: spacing.xs,
  },
  routeGuideSectionSelected: {
    backgroundColor: colors.primaryLight,
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
  routeStepBus: {
    fontWeight: "600",
    color: colors.primary,
  },
  routeStepIconOrigin: {
    backgroundColor: "green",
  },
  routeStepIconWalk: {
    backgroundColor: colors.border,
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
