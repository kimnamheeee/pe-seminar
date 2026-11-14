# Convex functions

- `routes.ts` calls Kakao's public transit route API and preserves BUS, SUBWAY, and combined route/leg types.
- `places.ts` searches Kakao Local for Seoul place candidates; the UI is not connected yet.
- `restaurants.ts` searches Kakao Local around a selected route.
- `transitStops.ts` matches BUS and SUBWAY route legs to same-mode coordinates in `transitStops`.
- Kakao credentials stay in Convex environment variables; never put them in an `EXPO_PUBLIC_` variable.

`transitStops.upsertBatch` and `transitStops.migrateLegacyBusStops` are internal functions used by the seed script. Run `node scripts/seed-transit-stops.mjs` from the repository root to migrate legacy bus rows and seed `data/subway.csv` into the configured development deployment. The operation is idempotent by mode and source ID.
