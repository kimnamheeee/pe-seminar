import { readFile, writeFile } from "node:fs/promises";

function loadEnv(text) {
  return Object.fromEntries(text.split(/\r?\n/)
    .filter((line) => line.trim() && !line.trim().startsWith("#"))
    .map((line) => {
      const index = line.indexOf("=");
      return index < 0 ? [line.trim(), ""] : [line.slice(0, index).trim(), line.slice(index + 1).trim().replace(/^['\"]|['\"]$/g, "")];
    }));
}

const env = { ...loadEnv(await readFile(new URL("../.env", import.meta.url), "utf8")), ...process.env };
const apiKey = env.KAKAO_REST_API_KEY;
if (!apiKey) throw new Error("KAKAO_REST_API_KEY is required");

const origin = { x: 126.9723, y: 37.5547, label: "서울역" };
const destination = { x: 127.0276, y: 37.4979, label: "강남역" };
const metersPerDegree = 111320;

function loadSteps(route) {
  return route.steps ?? route.legs?.flatMap((leg) => leg.steps ?? []) ?? [];
}

function loadPoints(route) {
  return loadSteps(route).flatMap((step) => step.path?.points ?? [])
    .filter((point) => Array.isArray(point) && point.length >= 2)
    .map(([x, y]) => ({ x: Number(x), y: Number(y) }))
    .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y));
}

function pointToRouteMeters(point, points) {
  const sx = metersPerDegree * Math.cos(point.y * Math.PI / 180);
  const sy = metersPerDegree;
  const px = point.x * sx;
  const py = point.y * sy;
  let min = Infinity;
  for (let i = 1; i < points.length; i += 1) {
    const ax = points[i - 1].x * sx;
    const ay = points[i - 1].y * sy;
    const bx = points[i].x * sx;
    const by = points[i].y * sy;
    const dx = bx - ax;
    const dy = by - ay;
    const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy || 1)));
    min = Math.min(min, Math.hypot(px - ax - t * dx, py - ay - t * dy));
  }
  return min;
}

function rectangleFor(points, paddingMeters = 1000) {
  const latPadding = paddingMeters / metersPerDegree;
  const meanLat = points.reduce((sum, point) => sum + point.y, 0) / points.length;
  const lonPadding = paddingMeters / (metersPerDegree * Math.cos(meanLat * Math.PI / 180));
  return {
    left: Math.min(...points.map((point) => point.x)) - lonPadding,
    bottom: Math.min(...points.map((point) => point.y)) - latPadding,
    right: Math.max(...points.map((point) => point.x)) + lonPadding,
    top: Math.max(...points.map((point) => point.y)) + latPadding,
  };
}

function stopCoordinates(stop) {
  const x = Number(stop.x ?? stop.longitude ?? stop.lng);
  const y = Number(stop.y ?? stop.latitude ?? stop.lat);
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
}

async function kakaoGet(url) {
  const response = await fetch(url, { headers: { Authorization: `KakaoAK ${apiKey}` } });
  const body = await response.json();
  if (!response.ok) throw new Error(`Kakao API returned HTTP ${response.status}: ${body.msg ?? "unknown error"}`);
  return body;
}

const transitUrl = new URL("https://dapi.kakao.com/v2/routing/publictraffic");
transitUrl.search = new URLSearchParams({
  start_x: String(origin.x), start_y: String(origin.y),
  end_x: String(destination.x), end_y: String(destination.y),
});
const transit = await kakaoGet(transitUrl);
const routes = transit.routes ?? [];
const routeSummaries = routes.map((route, index) => ({
  routeIndex: index,
  totalTimeSeconds: route.properties?.totalTime ?? null,
  transfers: route.properties?.transfers ?? null,
  routeType: route.properties?.type ?? null,
}));
const selectedRouteIndex = routes.findIndex((route) => Number(route.properties?.totalTime) < 3600);
const baseSample = {
  date: new Date().toISOString(),
  scenario: { origin, destination, restaurantCategoryGroupCode: "FD6" },
  transit: {
    httpStatus: 200,
    routeCount: routes.length,
    routeSummaries,
    eligibleRouteRule: "totalTime < 3600 seconds",
    selectedRouteIndex: selectedRouteIndex < 0 ? null : selectedRouteIndex,
  },
  restaurantSearch: null,
  selectedRestaurantStopCheck: null,
};

if (selectedRouteIndex < 0) {
  baseSample.outcome = "No transit route under 60 minutes; no restaurant search was made.";
} else {
  const route = routes[selectedRouteIndex];
  const points = loadPoints(route);
  if (points.length < 2) throw new Error("Selected route has no usable geometry");
  const rect = rectangleFor(points);
  const placesUrl = new URL("https://dapi.kakao.com/v2/local/search/category.json");
  placesUrl.search = new URLSearchParams({
    category_group_code: "FD6",
    rect: [rect.left, rect.bottom, rect.right, rect.top].join(","),
    size: "15",
    page: "1",
    sort: "accuracy",
  });
  const placeBody = await kakaoGet(placesUrl);
  const candidates = (placeBody.documents ?? []).map((place) => {
    const point = { x: Number(place.x), y: Number(place.y) };
    return {
      id: place.id,
      name: place.place_name,
      address: place.road_address_name || place.address_name,
      x: point.x,
      y: point.y,
      distanceToRouteMeters: Math.round(pointToRouteMeters(point, points)),
    };
  }).sort((a, b) => a.distanceToRouteMeters - b.distanceToRouteMeters);
  baseSample.restaurantSearch = {
    httpStatus: 200,
    requestCount: 1,
    categoryGroupCode: "FD6",
    rect,
    totalCount: placeBody.meta?.total_count ?? null,
    pageableCount: placeBody.meta?.pageable_count ?? null,
    returnedCount: candidates.length,
    candidates,
  };

  const stopObjects = loadSteps(route)
    .filter((step) => step.properties?.type !== "WALKING")
    .flatMap((step) => step.properties?.stops ?? []);
  const stopsWithCoordinates = stopObjects
    .map((stop) => ({ ...stop, coordinates: stopCoordinates(stop) }))
    .filter((stop) => stop.coordinates);
  const selectedRestaurant = candidates[0] ?? null;
  baseSample.selectedRestaurantStopCheck = {
    selectedRestaurant,
    routeStopCount: stopObjects.length,
    routeStopObjectFields: [...new Set(stopObjects.flatMap((stop) => Object.keys(stop)))],
    routeStopsWithCoordinates: stopsWithCoordinates.length,
    nearestStop: null,
    walkingRoute: null,
    status: !selectedRestaurant
      ? "No restaurant candidates in this single search result."
      : stopsWithCoordinates.length
        ? "Stop coordinates are present; nearest-stop walking check is pending implementation review."
        : "Cannot calculate nearest route stop: transit response has no stop coordinates.",
  };
  baseSample.outcome = !selectedRestaurant
    ? "A route under 60 minutes was available, but this one restaurant search returned no candidates."
    : stopsWithCoordinates.length
      ? "Route and restaurant candidates found; stop coordinates need nearest-walk calculation."
      : "Route and restaurant candidates found; nearest-stop feature is unsupported by returned stop data.";
}

const output = new URL("../docs/samples/current-core-validation.json", import.meta.url);
await writeFile(output, `${JSON.stringify(baseSample, null, 2)}\n`);
console.log(JSON.stringify({
  transitRouteCount: baseSample.transit.routeCount,
  under60MinuteRouteCount: routeSummaries.filter((route) => route.totalTimeSeconds < 3600).length,
  selectedRouteIndex: baseSample.transit.selectedRouteIndex,
  restaurantSearchRequests: baseSample.restaurantSearch?.requestCount ?? 0,
  restaurantsReturned: baseSample.restaurantSearch?.returnedCount ?? 0,
  stopCheck: baseSample.selectedRestaurantStopCheck?.status ?? "not run",
  sample: output.pathname,
}, null, 2));
