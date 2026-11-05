/**
 * Magnetic variation, from the World Magnetic Model.
 *
 * Runway headings, winds and great-circle courses are all true here; the
 * compass is not. The variation between them is what NOAA and the British
 * Geological Survey publish every five years as the WMM, and what charts,
 * GPS units and flight planners use. This is that model, evaluated the way
 * its technical report describes, with the coefficients as published.
 *
 * Checked against every one of NOAA's published test values for WMM2025.
 */

import type { LatLon } from './geo.js';

const rad = (d: number) => (d * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;

/** The model's name and the years it is valid for; outside them it has no answer. */
export const MAGNETIC_MODEL = { name: 'WMM2025', epoch: 2025.0, validUntil: 2030.0 } as const;

/*
 * WMM.COF from the WMM2025 release, as NOAA publishes it, header and
 * trailer left off: degree n, order m, g and h in nT, and their yearly
 * change. sha256 of the source file:
 * dfa8597825af4e0b87ff4198a5b4fb661b3c49f4cd090cd0164e0259b075582f
 */
const COF = `
  1  0  -29351.8       0.0       12.0        0.0
  1  1   -1410.8    4545.4        9.7      -21.5
  2  0   -2556.6       0.0      -11.6        0.0
  2  1    2951.1   -3133.6       -5.2      -27.7
  2  2    1649.3    -815.1       -8.0      -12.1
  3  0    1361.0       0.0       -1.3        0.0
  3  1   -2404.1     -56.6       -4.2        4.0
  3  2    1243.8     237.5        0.4       -0.3
  3  3     453.6    -549.5      -15.6       -4.1
  4  0     895.0       0.0       -1.6        0.0
  4  1     799.5     278.6       -2.4       -1.1
  4  2      55.7    -133.9       -6.0        4.1
  4  3    -281.1     212.0        5.6        1.6
  4  4      12.1    -375.6       -7.0       -4.4
  5  0    -233.2       0.0        0.6        0.0
  5  1     368.9      45.4        1.4       -0.5
  5  2     187.2     220.2        0.0        2.2
  5  3    -138.7    -122.9        0.6        0.4
  5  4    -142.0      43.0        2.2        1.7
  5  5      20.9     106.1        0.9        1.9
  6  0      64.4       0.0       -0.2        0.0
  6  1      63.8     -18.4       -0.4        0.3
  6  2      76.9      16.8        0.9       -1.6
  6  3    -115.7      48.8        1.2       -0.4
  6  4     -40.9     -59.8       -0.9        0.9
  6  5      14.9      10.9        0.3        0.7
  6  6     -60.7      72.7        0.9        0.9
  7  0      79.5       0.0       -0.0        0.0
  7  1     -77.0     -48.9       -0.1        0.6
  7  2      -8.8     -14.4       -0.1        0.5
  7  3      59.3      -1.0        0.5       -0.8
  7  4      15.8      23.4       -0.1        0.0
  7  5       2.5      -7.4       -0.8       -1.0
  7  6     -11.1     -25.1       -0.8        0.6
  7  7      14.2      -2.3        0.8       -0.2
  8  0      23.2       0.0       -0.1        0.0
  8  1      10.8       7.1        0.2       -0.2
  8  2     -17.5     -12.6        0.0        0.5
  8  3       2.0      11.4        0.5       -0.4
  8  4     -21.7      -9.7       -0.1        0.4
  8  5      16.9      12.7        0.3       -0.5
  8  6      15.0       0.7        0.2       -0.6
  8  7     -16.8      -5.2       -0.0        0.3
  8  8       0.9       3.9        0.2        0.2
  9  0       4.6       0.0       -0.0        0.0
  9  1       7.8     -24.8       -0.1       -0.3
  9  2       3.0      12.2        0.1        0.3
  9  3      -0.2       8.3        0.3       -0.3
  9  4      -2.5      -3.3       -0.3        0.3
  9  5     -13.1      -5.2        0.0        0.2
  9  6       2.4       7.2        0.3       -0.1
  9  7       8.6      -0.6       -0.1       -0.2
  9  8      -8.7       0.8        0.1        0.4
  9  9     -12.9      10.0       -0.1        0.1
 10  0      -1.3       0.0        0.1        0.0
 10  1      -6.4       3.3        0.0        0.0
 10  2       0.2       0.0        0.1       -0.0
 10  3       2.0       2.4        0.1       -0.2
 10  4      -1.0       5.3       -0.0        0.1
 10  5      -0.6      -9.1       -0.3       -0.1
 10  6      -0.9       0.4        0.0        0.1
 10  7       1.5      -4.2       -0.1        0.0
 10  8       0.9      -3.8       -0.1       -0.1
 10  9      -2.7       0.9       -0.0        0.2
 10 10      -3.9      -9.1       -0.0       -0.0
 11  0       2.9       0.0        0.0        0.0
 11  1      -1.5       0.0       -0.0       -0.0
 11  2      -2.5       2.9        0.0        0.1
 11  3       2.4      -0.6        0.0       -0.0
 11  4      -0.6       0.2        0.0        0.1
 11  5      -0.1       0.5       -0.1       -0.0
 11  6      -0.6      -0.3        0.0       -0.0
 11  7      -0.1      -1.2       -0.0        0.1
 11  8       1.1      -1.7       -0.1       -0.0
 11  9      -1.0      -2.9       -0.1        0.0
 11 10      -0.2      -1.8       -0.1        0.0
 11 11       2.6      -2.3       -0.1        0.0
 12  0      -2.0       0.0        0.0        0.0
 12  1      -0.2      -1.3        0.0       -0.0
 12  2       0.3       0.7       -0.0        0.0
 12  3       1.2       1.0       -0.0       -0.1
 12  4      -1.3      -1.4       -0.0        0.1
 12  5       0.6      -0.0       -0.0       -0.0
 12  6       0.6       0.6        0.1       -0.0
 12  7       0.5      -0.1       -0.0       -0.0
 12  8      -0.1       0.8        0.0        0.0
 12  9      -0.4       0.1        0.0       -0.0
 12 10      -0.2      -1.0       -0.1       -0.0
 12 11      -1.3       0.1       -0.0        0.0
 12 12      -0.7       0.2       -0.1       -0.1
`;

const MAX_DEGREE = 12;

interface Coefficients {
  readonly g: number[][];
  readonly h: number[][];
  readonly gDot: number[][];
  readonly hDot: number[][];
}

const square = () => Array.from({ length: MAX_DEGREE + 1 }, () => new Array<number>(MAX_DEGREE + 1).fill(0));

function parse(text: string): Coefficients {
  const c = { g: square(), h: square(), gDot: square(), hDot: square() };
  for (const line of text.trim().split('\n')) {
    const [n, m, g, h, gDot, hDot] = line.trim().split(/\s+/).map(Number) as [number, number, number, number, number, number];
    c.g[n]![m] = g;
    c.h[n]![m] = h;
    c.gDot[n]![m] = gDot;
    c.hDot[n]![m] = hDot;
  }
  return c;
}

const COEFFICIENTS = parse(COF);

/*
 * Schmidt semi-normalisation, applied to the coefficients once rather than
 * to the Legendre functions at every call, so the recursion below can run
 * on the plain (Gauss-normalised) functions.
 */
const SCHMIDT = (() => {
  const s = square();
  s[0]![0] = 1;
  for (let n = 1; n <= MAX_DEGREE; n++) {
    s[n]![0] = (s[n - 1]![0]! * (2 * n - 1)) / n;
    for (let m = 1; m <= n; m++) s[n]![m] = s[n]![m - 1]! * Math.sqrt(((n - m + 1) * (m === 1 ? 2 : 1)) / (n + m));
  }
  return s;
})();

/** WGS 84, and the model's own reference radius, in kilometres. */
const WGS84_A = 6378.137;
const WGS84_F = 1 / 298.257223563;
const WGS84_E2 = WGS84_F * (2 - WGS84_F);
const REFERENCE_RADIUS = 6371.2;

/** A calendar date as the decimal year the model is indexed by. */
export function decimalYear(at: Date): number {
  const year = at.getUTCFullYear();
  const start = Date.UTC(year, 0, 1);
  return year + (at.getTime() - start) / (Date.UTC(year + 1, 0, 1) - start);
}

export interface MagneticField {
  /** North, east and down, in nanotesla, in the geodetic frame. */
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** Declination, east positive: the variation a chart prints. */
  readonly declination: number;
}

/**
 * The main field at a position, height above the ellipsoid in kilometres,
 * and decimal year. `null` outside the years the model is valid for, and at
 * the geographic poles, where declination has no meaning.
 */
export function magneticField(position: LatLon, heightKm: number, year: number): MagneticField | null {
  if (!(year >= MAGNETIC_MODEL.epoch && year < MAGNETIC_MODEL.validUntil)) return null;
  if (Math.abs(position.lat) > 89.99) return null;

  // Geodetic to geocentric spherical: the model is a sum over a sphere.
  const φ = rad(position.lat);
  const λ = rad(position.lon);
  const sinφ = Math.sin(φ);
  const rc = WGS84_A / Math.sqrt(1 - WGS84_E2 * sinφ * sinφ);
  const p = (rc + heightKm) * Math.cos(φ);
  const zc = (rc * (1 - WGS84_E2) + heightKm) * sinφ;
  const r = Math.hypot(p, zc);
  const φc = Math.asin(zc / r);

  // Legendre functions of the geocentric colatitude, and their derivatives.
  const x = Math.sin(φc);
  const s = Math.cos(φc);
  const P = square();
  const dP = square();
  P[0]![0] = 1;
  for (let n = 1; n <= MAX_DEGREE; n++) {
    for (let m = 0; m <= n; m++) {
      if (m === n) {
        P[n]![n] = s * P[n - 1]![n - 1]!;
        dP[n]![n] = s * dP[n - 1]![n - 1]! + x * P[n - 1]![n - 1]!;
      } else if (n === 1) {
        P[1]![0] = x;
        dP[1]![0] = -s;
      } else {
        const k = ((n - 1) ** 2 - m ** 2) / ((2 * n - 1) * (2 * n - 3));
        P[n]![m] = x * P[n - 1]![m]! - k * P[n - 2]![m]!;
        dP[n]![m] = x * dP[n - 1]![m]! - s * P[n - 1]![m]! - k * dP[n - 2]![m]!;
      }
    }
  }

  // The field in the spherical frame: radial out, colatitude south, longitude east.
  const dt = year - MAGNETIC_MODEL.epoch;
  let bR = 0;
  let bθ = 0;
  let bλ = 0;
  for (let n = 1; n <= MAX_DEGREE; n++) {
    const ar = (REFERENCE_RADIUS / r) ** (n + 2);
    for (let m = 0; m <= n; m++) {
      const g = (COEFFICIENTS.g[n]![m]! + dt * COEFFICIENTS.gDot[n]![m]!) * SCHMIDT[n]![m]!;
      const h = (COEFFICIENTS.h[n]![m]! + dt * COEFFICIENTS.hDot[n]![m]!) * SCHMIDT[n]![m]!;
      const cos = Math.cos(m * λ);
      const sin = Math.sin(m * λ);
      const along = g * cos + h * sin;
      bR += (n + 1) * ar * along * P[n]![m]!;
      bθ -= ar * along * dP[n]![m]!;
      bλ += m * ar * (g * sin - h * cos) * P[n]![m]!;
    }
  }
  bλ /= s;

  // Back to the geodetic frame, turning through the difference in latitude.
  const ψ = φ - φc;
  const north = -bθ * Math.cos(ψ) - bR * Math.sin(ψ);
  const down = bθ * Math.sin(ψ) - bR * Math.cos(ψ);
  return { x: north, y: bλ, z: down, declination: deg(Math.atan2(bλ, north)) };
}

/**
 * Variation at a place on a date, degrees east positive ("east is least":
 * magnetic = true − variation), at the surface where charts give it. `null`
 * when the model has no answer for that date.
 */
export function magneticVariation(position: LatLon, at: Date): number | null {
  return magneticField(position, 0, decimalYear(at))?.declination ?? null;
}
