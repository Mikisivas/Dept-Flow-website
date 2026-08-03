/**
 * Distance on the ground, for the geo-fence.
 *
 * Venue radii are 30–50 m and the earth is locally flat at that scale, but the
 * haversine formula costs nothing and removes the question. The result is only
 * ever compared against a radius or stored as `distance_m` — a coordinate never
 * leaves the server, and no screen in this product renders one.
 */

const EARTH_RADIUS_M = 6_371_008.8;

export function distanceMetres(
  a: { latitude: number; longitude: number },
  b: { latitude: number; longitude: number },
): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;

  const dLat = toRad(b.latitude - a.latitude);
  const dLng = toRad(b.longitude - a.longitude);
  const lat1 = toRad(a.latitude);
  const lat2 = toRad(b.latitude);

  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;

  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h));
}

/**
 * A phone that reports ±60 m accuracy inside a 40 m fence cannot prove it is
 * outside, so its own error budget is allowed against the radius. Without this
 * a student sitting in the third row is rejected by nothing worse than a cloudy
 * day, and the rejection is indistinguishable from cheating in the audit trail.
 *
 * The allowance is capped: a reading accurate to ±500 m carries no information
 * about which building you are in, and letting it pass would make the fence
 * decorative.
 */
export const MAX_ACCURACY_ALLOWANCE_M = 35;

export function withinFence(
  distance: number,
  radiusM: number,
  accuracyM: number | null | undefined,
): boolean {
  const allowance = Math.min(Math.max(accuracyM ?? 0, 0), MAX_ACCURACY_ALLOWANCE_M);
  return distance <= radiusM + allowance;
}
