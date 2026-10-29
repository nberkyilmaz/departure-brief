/**
 * Every aerodrome in Canada and the United States, carried to a page that
 * has no database.
 *
 * Seventeen and a half thousand fields with their runways is fourteen
 * megabytes of JSON: too much to make every visitor download before they
 * can look one field up. So the set travels in two layers.
 *
 * - An index of every field: its identifiers, its name and where it is to
 *   about a hundred metres. That is what search and the map need, and it is
 *   small enough to load with the page.
 * - The full records, runways and all, in squares `cellDegrees` on a side,
 *   fetched only when a question is about somewhere in that square.
 *
 * `CatalogStore` puts the two together behind the ordinary store interface.
 * Before it answers a question about an identifier or a neighbourhood, it
 * fetches every square that could hold part of the answer, and then answers
 * exactly as a store holding the whole continent would. The resolvers know
 * nothing about any of this, and brief the same flight the same way either
 * way, to the byte.
 */
import type { Airport, Runway, RunwayEnd } from '../domain/airport.js';
import { distanceNm } from '../domain/geo.js';
import { degTrue, feet } from '../domain/units.js';
import { MemoryStore } from '../store/memory.js';

/** Two degrees: a square holds a few hundred fields at most, and a sixty-mile question touches about four. */
export const CELL_DEGREES = 2;

/**
 * One field in the index: ICAO identifier (empty when it has none), FAA or
 * local identifier, name, and position rounded to three decimals.
 */
export type IndexedAirport = readonly [icaoId: string, faaId: string, name: string, lat: number, lon: number];

export interface AirportIndex {
  readonly source: 'ourairports';
  /** The OurAirports snapshot, `YYYY-MM-DD`; it becomes each record's `cycle`. */
  readonly snapshot: string;
  readonly cellDegrees: number;
  readonly airports: readonly IndexedAirport[];
}

type PackedEnd = readonly [id: string, trueHeading: number | null, lat: number | null, lon: number | null, elevation: number | null, displacedThreshold: number | null];
type PackedRunway = readonly [id: string, length: number | null, width: number | null, surface: string | null, lighting: string | null, ends: readonly PackedEnd[]];

/** An `Airport` as a row rather than an object: the names of the fields are most of the bytes otherwise. */
export type PackedAirport = readonly [
  siteNo: string,
  siteType: string,
  faaId: string,
  icaoId: string | null,
  name: string,
  city: string,
  state: string,
  country: string,
  lat: number,
  lon: number,
  elevation: number | null,
  runways: readonly PackedRunway[],
];

/** Every field in one square, in full. */
export interface AirportCell {
  readonly source: 'ourairports';
  readonly snapshot: string;
  readonly airports: readonly PackedAirport[];
}

const round3 = (n: number): number => Math.round(n * 1000) / 1000;
/** By code unit, not by locale: the files have to come out the same on any machine. */
const byCode = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** `N42W080`: the square's south-west corner, so a file name says where it is. */
export function cellOf(lat: number, lon: number, size: number = CELL_DEGREES): string {
  const south = Math.floor(lat / size) * size;
  const west = Math.floor(lon / size) * size;
  return `${south < 0 ? 'S' : 'N'}${String(Math.abs(south)).padStart(2, '0')}${west < 0 ? 'W' : 'E'}${String(Math.abs(west)).padStart(3, '0')}`;
}

export class UnpackableAirportError extends Error {
  constructor(a: Airport, field: string) {
    super(`${a.icaoId ?? a.faaId} has a ${field}, which the packed form does not carry`);
    this.name = 'UnpackableAirportError';
  }
}

/**
 * Pack an OurAirports record. OurAirports never gives magnetic variation, a
 * pattern altitude, runway condition, ILS or declared distances, so the
 * packed form has no place for them, and a record that has one is refused
 * rather than quietly losing it.
 */
export function packAirport(a: Airport): PackedAirport {
  if (a.magneticVariation !== null || a.magneticVariationYear !== null) throw new UnpackableAirportError(a, 'magnetic variation');
  if (a.patternAltitude !== null) throw new UnpackableAirportError(a, 'pattern altitude');
  const runways = a.runways.map((r): PackedRunway => {
    if (r.condition !== null) throw new UnpackableAirportError(a, 'runway condition');
    const ends = r.ends.map((e): PackedEnd => {
      if (e.rightHandPattern || e.ils !== null || e.tora !== null || e.toda !== null || e.asda !== null || e.lda !== null) {
        throw new UnpackableAirportError(a, 'runway end with a pattern side, ILS or declared distances');
      }
      return [e.id, e.trueHeading, e.lat, e.lon, e.elevation, e.displacedThreshold];
    });
    return [r.id, r.length, r.width, r.surface, r.lighting, ends];
  });
  return [a.siteNo, a.siteType, a.faaId, a.icaoId, a.name, a.city, a.state, a.country, a.lat, a.lon, a.elevation, runways];
}

const ft = (n: number | null) => (n === null ? null : feet(n));

export function unpackAirport(p: PackedAirport, from: { readonly source: 'ourairports'; readonly snapshot: string }): Airport {
  const [siteNo, siteType, faaId, icaoId, name, city, state, country, lat, lon, elevation, runways] = p;
  return {
    source: from.source,
    cycle: from.snapshot,
    siteNo,
    siteType,
    faaId,
    icaoId,
    name,
    city,
    state,
    country,
    lat,
    lon,
    elevation: ft(elevation),
    magneticVariation: null,
    magneticVariationYear: null,
    patternAltitude: null,
    runways: runways.map(
      ([id, length, width, surface, lighting, ends]): Runway => ({
        id,
        length: ft(length),
        width: ft(width),
        surface,
        condition: null,
        lighting,
        ends: ends.map(
          ([endId, heading, endLat, endLon, endElevation, displaced]): RunwayEnd => ({
            id: endId,
            trueHeading: heading === null ? null : degTrue(heading),
            lat: endLat,
            lon: endLon,
            elevation: ft(endElevation),
            displacedThreshold: ft(displaced),
            rightHandPattern: false,
            ils: null,
            tora: null,
            toda: null,
            asda: null,
            lda: null,
          }),
        ),
      }),
    ),
  };
}

/**
 * Split a set of airports into the index and its squares. Each field goes
 * in the square its rounded position falls in, so the square a page works
 * out from the index is always the one the field was written to.
 */
export function packCatalog(airports: readonly Airport[], snapshot: string, cellDegrees: number = CELL_DEGREES): { index: AirportIndex; cells: Map<string, AirportCell> } {
  const sorted = [...airports].sort((a, b) => byCode(a.icaoId ?? a.faaId, b.icaoId ?? b.faaId) || byCode(a.siteNo, b.siteNo));
  const rows: IndexedAirport[] = [];
  const packed = new Map<string, PackedAirport[]>();
  for (const a of sorted) {
    const lat = round3(a.lat);
    const lon = round3(a.lon);
    rows.push([a.icaoId ?? '', a.faaId, a.name, lat, lon]);
    const cell = cellOf(lat, lon, cellDegrees);
    const list = packed.get(cell) ?? [];
    list.push(packAirport(a));
    packed.set(cell, list);
  }
  const cells = new Map([...packed].sort(([a], [b]) => byCode(a, b)).map(([name, list]): [string, AirportCell] => [name, { source: 'ourairports', snapshot, airports: list }]));
  return { index: { source: 'ourairports', snapshot, cellDegrees, airports: rows }, cells };
}

export type CellLoader = (cell: string) => Promise<AirportCell>;

/** How far the index's rounding can move a field, and then some: a field this close to the edge of a question is fetched anyway. */
const ROUNDING_MARGIN_NM = 1;

/**
 * A store that holds the index from the start and fetches the full records
 * of a square the first time a question needs it. Everything that is not
 * about airports — reports, briefings, assessments — is the memory store's
 * own.
 */
export class CatalogStore extends MemoryStore {
  private readonly byId = new Map<string, IndexedAirport[]>();
  private readonly byCell = new Map<string, IndexedAirport[]>();
  private readonly loading = new Map<string, Promise<void>>();

  constructor(
    readonly index: AirportIndex,
    private readonly load: CellLoader,
  ) {
    super();
    const file = <K,>(map: Map<K, IndexedAirport[]>, key: K, row: IndexedAirport) => {
      const list = map.get(key);
      if (list) list.push(row);
      else map.set(key, [row]);
    };
    for (const row of index.airports) {
      for (const id of new Set([row[0], row[1]])) if (id !== '') file(this.byId, id.toUpperCase(), row);
      file(this.byCell, this.cellOfRow(row), row);
    }
  }

  private cellOfRow(row: IndexedAirport): string {
    return cellOf(row[3], row[4], this.index.cellDegrees);
  }

  /** The index rows filed under an identifier, ICAO or FAA: what the page can say about a field without fetching anything. */
  indexed(id: string): readonly IndexedAirport[] {
    return this.byId.get(id.trim().toUpperCase()) ?? [];
  }

  /** Every identifier the index knows, ICAO and FAA alike, upper case. */
  identifiers(): ReadonlySet<string> {
    return new Set(this.byId.keys());
  }

  /** Fetch each square once, however many questions arrive for it together. A square that failed is asked for again next time. */
  private async ensure(cells: Iterable<string>): Promise<void> {
    await Promise.all(
      [...new Set(cells)].map((name) => {
        let pending = this.loading.get(name);
        if (!pending) {
          pending = this.load(name).then(async (cell) => {
            await this.putAirports(cell.airports.map((p) => unpackAirport(p, cell)));
          });
          this.loading.set(name, pending);
          pending.catch(() => this.loading.delete(name));
        }
        return pending;
      }),
    );
  }

  /** The squares holding a field within `radiusNm` of a point, judged from the index. */
  private cellsNear(lat: number, lon: number, radiusNm: number): string[] {
    const size = this.index.cellDegrees;
    const reach = radiusNm + ROUNDING_MARGIN_NM;
    const dLat = reach / 60;
    const dLon = reach / (60 * Math.max(Math.cos((lat * Math.PI) / 180), 0.01));
    const here = { lat, lon };
    const wanted: string[] = [];
    for (let south = Math.floor((lat - dLat) / size) * size; south <= lat + dLat; south += size) {
      for (let west = Math.floor((lon - dLon) / size) * size; west <= lon + dLon; west += size) {
        // Across the antimeridian, where the Aleutians are, a square's name is taken the other way round.
        const name = cellOf(south, ((west + 540) % 360) - 180, size);
        const rows = this.byCell.get(name);
        if (rows?.some((r) => distanceNm(here, { lat: r[3], lon: r[4] }) <= reach)) wanted.push(name);
      }
    }
    return wanted;
  }

  override async getAirport(id: string): Promise<Airport | null> {
    const rows = this.indexed(id);
    if (rows.length === 0) return null;
    await this.ensure(rows.map((r) => this.cellOfRow(r)));
    return super.getAirport(id);
  }

  override async listAirportsNear(lat: number, lon: number, radiusNm: number): Promise<Airport[]> {
    await this.ensure(this.cellsNear(lat, lon, radiusNm));
    return super.listAirportsNear(lat, lon, radiusNm);
  }
}
