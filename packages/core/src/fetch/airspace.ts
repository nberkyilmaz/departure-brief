/**
 * The airspace a line goes through, from the FAA's published layers: Class
 * B, C and D in one and the special use areas in the other, with no key.
 *
 * They send CORS headers, so a page calls them directly and not through the
 * relay, for the same reason as the elevation service: every route asks a
 * different question, and there would be nothing to keep.
 *
 * The shapes are asked for generalised to about 55 metres. As the FAA draws
 * them Boston to Philadelphia comes to 1.2 MB; like this it is 34 KB, and
 * nothing a map or a side view can show has moved.
 *
 * The service is ArcGIS, which answers 200 when it refuses, including when
 * the FAA's allowance for the minute has run out, so what came back has to
 * be looked at.
 */
import type { LatLon } from '../domain/geo.js';
import { expectOk, type HttpClient } from './response.js';

export const FAA_AIRSPACE_URL = 'https://services6.arcgis.com/ssFJjBXIUyZDrSYZ/arcgis/rest/services';

/** About 55 metres at any latitude the FAA draws. */
const GENERALISE_DEGREES = 0.0005;
/** To about ten metres, finer than the generalising. */
const DECIMALS = 4;

const LIMITS = 'LOWER_DESC,LOWER_VAL,LOWER_UOM,LOWER_CODE,UPPER_DESC,UPPER_VAL,UPPER_UOM,UPPER_CODE';
/** The FAA also carries its neighbours' terminal areas, with no state against them, and those are not its to speak for. */
const CLASSES = { path: 'Class_Airspace/FeatureServer/0', where: "CLASS IN ('B','C','D') AND STATE IS NOT NULL", fields: `NAME,CLASS,WKHR_CODE,WKHR_RMK,${LIMITS}` };
const SPECIAL_USE = { path: 'Special_Use_Airspace/FeatureServer/0', where: "COUNTRY = 'UNITED STATES'", fields: `NAME,TYPE_CODE,TIMESOFUSE,REMARKS,${LIMITS}` };

export class AirspaceError extends Error {
  constructor(
    message: string,
    readonly url: string,
  ) {
    super(message);
    this.name = 'AirspaceError';
  }
}

/** One shape as the FAA published it: its outline first, then any holes in it. */
export interface AirspaceRecord {
  readonly properties: Readonly<Record<string, unknown>>;
  readonly rings: readonly (readonly LatLon[])[];
}

type Ring = readonly (readonly [number, number])[];

function ringsOf(geometry: { type?: unknown; coordinates?: unknown } | null): (readonly Ring[])[] {
  if (geometry?.type === 'Polygon') return [geometry.coordinates as Ring[]];
  if (geometry?.type === 'MultiPolygon') return geometry.coordinates as Ring[][];
  return [];
}

export class AirspaceClient {
  constructor(
    private readonly http: HttpClient,
    private readonly url: string = FAA_AIRSPACE_URL,
  ) {}

  async along(line: readonly LatLon[]): Promise<{ classes: AirspaceRecord[]; specialUse: AirspaceRecord[] }> {
    const [classes, specialUse] = await Promise.all([this.layer(CLASSES, line), this.layer(SPECIAL_USE, line)]);
    return { classes, specialUse };
  }

  private async layer(layer: { path: string; where: string; fields: string }, line: readonly LatLon[]): Promise<AirspaceRecord[]> {
    const paths = [line.map((p) => [Number(p.lon.toFixed(DECIMALS)), Number(p.lat.toFixed(DECIMALS))])];
    const query = new URLSearchParams({
      where: layer.where,
      geometry: JSON.stringify({ paths, spatialReference: { wkid: 4326 } }),
      geometryType: 'esriGeometryPolyline',
      inSR: '4326',
      spatialRel: 'esriSpatialRelIntersects',
      outFields: layer.fields,
      returnGeometry: 'true',
      outSR: '4326',
      maxAllowableOffset: String(GENERALISE_DEGREES),
      geometryPrecision: String(DECIMALS),
      f: 'geojson',
    });
    const url = `${this.url}/${layer.path}/query?${query}`;
    const res = expectOk(url, await this.http.get(url, { headers: { Accept: 'application/json' } }));
    let parsed: { error?: { message?: unknown }; features?: unknown };
    try {
      parsed = JSON.parse(res.body) as typeof parsed;
    } catch {
      throw new AirspaceError('response is not JSON', url);
    }
    if (parsed.error) throw new AirspaceError(`the FAA refused: ${String(parsed.error.message)}`, url);
    if (!Array.isArray(parsed.features)) throw new AirspaceError('no features in the response', url);
    return (parsed.features as { properties?: Record<string, unknown>; geometry?: { type?: unknown; coordinates?: unknown } | null }[]).flatMap((f) =>
      ringsOf(f.geometry ?? null).map((rings) => ({
        properties: f.properties ?? {},
        rings: rings.map((ring) => ring.map(([lon, lat]) => ({ lat, lon }))),
      })),
    );
  }
}
