import boundary from "./data/seoul-districts-2017.json";

type Position = [number, number];
type Polygon = Position[][];
type District = { geometry: { type: "Polygon"; coordinates: Polygon } };

const districts = (boundary as unknown as { features: District[] }).features.map(({ geometry }) => {
  const outerRing = geometry.coordinates[0];
  return {
    rings: geometry.coordinates,
    minLng: Math.min(...outerRing.map(([lng]) => lng)),
    maxLng: Math.max(...outerRing.map(([lng]) => lng)),
    minLat: Math.min(...outerRing.map(([, lat]) => lat)),
    maxLat: Math.max(...outerRing.map(([, lat]) => lat)),
  };
});

function pointInRing(lng: number, lat: number, ring: Position[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const cross = (lng - xi) * (yj - yi) - (lat - yi) * (xj - xi);
    if (
      Math.abs(cross) < 1e-10 &&
      lng >= Math.min(xi, xj) && lng <= Math.max(xi, xj) &&
      lat >= Math.min(yi, yj) && lat <= Math.max(yi, yj)
    ) return true;
    const crosses = (yi > lat) !== (yj > lat) &&
      lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
    if (crosses) inside = !inside;
  }
  return inside;
}

function pointInSeoul(lng: number, lat: number): boolean {
  for (const district of districts) {
    if (
      lng < district.minLng || lng > district.maxLng ||
      lat < district.minLat || lat > district.maxLat ||
      !pointInRing(lng, lat, district.rings[0])
    ) continue;

    const inHole = district.rings.slice(1).some((ring) => pointInRing(lng, lat, ring));
    if (!inHole) return true;
  }
  return false;
}

function distanceMeters(a: Position, b: Position): number {
  const lat1 = a[1] * Math.PI / 180;
  const lat2 = b[1] * Math.PI / 180;
  const dLat = lat2 - lat1;
  const dLng = (b[0] - a[0]) * Math.PI / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

/** Check the complete route shape, sampling long polyline segments every 100m. */
export function isRouteWithinSeoul(route: Array<{ lat: number; lng: number }>): boolean {
  if (route.length === 0) return false;

  for (let i = 0; i < route.length; i++) {
    const current: Position = [route[i].lng, route[i].lat];
    if (!pointInSeoul(current[0], current[1])) return false;

    if (i === 0) continue;
    const previous: Position = [route[i - 1].lng, route[i - 1].lat];
    const distance = distanceMeters(previous, current);
    const steps = Math.ceil(distance / 100);
    for (let step = 1; step < steps; step++) {
      const ratio = step / steps;
      const lng = previous[0] + (current[0] - previous[0]) * ratio;
      const lat = previous[1] + (current[1] - previous[1]) * ratio;
      if (!pointInSeoul(lng, lat)) return false;
    }
  }

  return true;
}
