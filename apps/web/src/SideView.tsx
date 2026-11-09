import { useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { useAirspace } from './airspace.js';
import { AIRSPACE_STYLE, airspaceBlocks, airspaceLines, altitudeTicks, chartTop, COLUMN_PX, columnLabel, columnsOf, emptyStretches, hazardKey, hazardLetter, heightText, labelOf, layersToLabel, layerText, notesOf, pirepTag, pirepWords, placePireps, spread, terrainPath, xOfNm, type Column } from './picture.js';
import { openColumn, opens } from './stationLink.js';
import { CATEGORY_LETTER } from './summary.js';
import { useTerrain } from './terrain.js';
import { clock24, zoneOf } from './time.js';
import type { AirspaceKind, PictureHazard, PictureLayer, RoutePicture, StoredBriefing } from './types.js';

/**
 * The route from the side: distance across, altitude up, and the clock time
 * you would pass each point. Drawn by hand in SVG, with the same colour
 * variables as the rest of the page, so a station that is IFR here is the
 * same red as in the list and either colour scheme looks after itself.
 *
 * It draws only what the reports say. A cloud is a base that fades out,
 * because no report gives a top. Ground is a block under the station it
 * belongs to, with nothing joining one to the next. A letter is on every
 * station so the category never rests on colour, and a hollow one is an
 * observation from now rather than a forecast for the time you pass.
 */

const AXIS_PX = 50;
const HEAD_PX = 46;
const PLOT_PX = 252;
const ROW_PX = 15;
const LABEL_GAP_PX = 12;
/** What a phone leaves for the plot before it has been measured. */
const ASSUMED_PLOT_PX = 310;
/** How wide a bar of each cover is: wider is more of the sky. */
const COVER_PX: Readonly<Record<string, number>> = { FEW: 12, SCT: 22, BKN: 32, OVC: 44 };
const barWidth = (l: PictureLayer): number => (l.kind === 'vertical-visibility' ? COVER_PX['OVC']! : COVER_PX[l.amount ?? 'FEW']!);
const GROUND_PX = 22;
const FADE_PX = 16;
/** The narrowest empty stretch that has room for words. */
const EMPTY_WORDS_PX = 124;

function Cloud({ layer, x, y, observed, label }: { layer: PictureLayer; x: number; y: number; observed: boolean; label: boolean }) {
  const w = barWidth(layer);
  return (
    <g className={observed ? 'sv-cloud sv-observed' : 'sv-cloud'}>
      {observed ? (
        <rect className="sv-cloud-outline" x={x - w / 2} y={y - 5} width={w} height={5} rx={1.5} />
      ) : (
        <>
          <rect x={x - w / 2} y={y - FADE_PX} width={w} height={FADE_PX} fill="url(#sv-fade)" />
          <rect className="sv-cloud-base" x={x - w / 2} y={y - 1.5} width={w} height={3} rx={1.5} />
        </>
      )}
      {label && (
        <text className="sv-label" x={x} y={y + 11} textAnchor="middle">
          {layerText(layer)}
        </text>
      )}
    </g>
  );
}

function Band({ h, tag, stack, x0, x1, top, yOf, plotTop }: { h: PictureHazard; tag: string; stack: number; x0: number; x1: number; top: number; yOf: (ft: number) => number; plotTop: number }) {
  const noAltitude = h.baseFt === null && h.topFt === null;
  const base = h.baseFt ?? 0;
  const strip = noAltitude || base >= top;
  const y0 = strip ? plotTop : yOf(Math.min(h.topFt ?? top, top));
  const y1 = strip ? plotTop + 9 : yOf(base);
  const open = !strip && (h.topFt === null || h.topFt > top);
  const tagX = x0 + 2 + stack * (open || strip ? 26 : 18);
  // Under the line at the top of each column, where cloud above the chart is written.
  const tagY = plotTop + 16;
  const words = `${tag}${open || strip ? '↑' : ''}`;
  return (
    <g className={`sv-band ${h.kind}`}>
      <rect x={x0} y={y0} width={Math.max(2, x1 - x0)} height={Math.max(2, y1 - y0)} fill={`url(#sv-hatch-${h.kind})`} />
      <rect className="sv-band-edge" x={x0} y={y0} width={Math.max(2, x1 - x0)} height={Math.max(2, y1 - y0)} />
      <rect className="sv-tag-box" x={tagX} y={tagY} width={open || strip ? 23 : 15} height={14} rx={2} />
      <text className="sv-tag" x={tagX + (open || strip ? 11.5 : 7.5)} y={tagY + 11} textAnchor="middle">
        {words}
      </text>
    </g>
  );
}

const airClass = (kind: AirspaceKind): string => `sv-air ${AIRSPACE_STYLE[kind].hue} ${AIRSPACE_STYLE[kind].line}`;

/** The marks the chart uses, each drawn the way it is drawn on the chart. */
function Key({ terrain, pireps, air }: { terrain: boolean; pireps: boolean; air: readonly AirspaceKind[] }) {
  const swatch = (children: ReactNode) => (
    <svg className="side-key-mark" width={30} height={18} aria-hidden="true">
      {children}
    </svg>
  );
  const items: readonly (readonly [string, ReactNode, string])[] = [
    ['forecast', swatch(<Chip x={15} y={9} letter="V" category="vfr" hollow={false} r={8} />), 'forecast for when you pass'],
    ['observed', swatch(<Chip x={15} y={9} letter="V" category="vfr" hollow r={8} />), 'observed now, no forecast'],
    ['base', swatch(<><rect x={3} y={0} width={24} height={13} fill="url(#sv-fade)" /><rect className="sv-cloud-base" x={3} y={12} width={24} height={3} rx={1.5} /></>), 'cloud base, wider is more cover; it fades because the top is unknown'],
    ['outline', swatch(<rect className="sv-cloud-outline" x={3} y={8} width={24} height={5} rx={1.5} />), 'cloud in that observation'],
    ['overlay', swatch(<line className="sv-overlay" x1={3} y1={10} x2={27} y2={10} />), 'cloud in a TEMPO, PROB or BECMG'],
    ...(terrain ? ([['terrain', swatch(<path className="sv-terrain" d="M2 18L2 12L9 6L15 11L21 3L28 13L28 18Z" />), 'the terrain under your line']] as const) : []),
    ['ground', swatch(<rect className="sv-ground" x={8} y={4} width={14} height={14} />), 'the ground at that station'],
    ['freezing', swatch(<line className="sv-freezing" x1={3} y1={9} x2={27} y2={9} />), 'freezing level, 0 °C'],
    ...(pireps ? ([['pirep', swatch(<PirepMark x={15} y={9} n={1} hollow={false} />), 'a pilot report, listed below']] as const) : []),
    ...air.map((kind) => [`air-${kind}`, swatch(<rect className={airClass(kind)} x={3} y={3} width={24} height={12} />), AIRSPACE_STYLE[kind].name] as const),
  ];
  return (
    <ul className="side-key">
      {items.map(([key, mark, words]) => (
        <li key={key}>
          {mark} {words}
        </li>
      ))}
      <li className="side-key-letters">V VFR · M MVFR · I IFR · L LIFR</li>
    </ul>
  );
}

function PirepMark({ x, y, n, hollow }: { x: number; y: number; n: number; hollow: boolean }) {
  return (
    <g className={`sv-pirep${hollow ? ' hollow' : ''}`}>
      <circle cx={x} cy={y} r={8} />
      <text x={x} y={y + 3.5} textAnchor="middle">
        {n}
      </text>
    </g>
  );
}

function Chip({ x, y, letter, category, hollow, r = 10 }: { x: number; y: number; letter: string; category: string; hollow: boolean; r?: number }) {
  return (
    <g className={`sv-chip ${category}${hollow ? ' hollow' : ''}`}>
      <circle cx={x} cy={y} r={r} />
      <text x={x} y={y + 3.75} textAnchor="middle">
        {letter}
      </text>
    </g>
  );
}

interface Row {
  readonly key: string;
  readonly label: string;
  readonly lines: number;
  readonly cell: (c: Column) => readonly string[];
}

/** The rows of words under the chart, only the ones this flight has anything to put in. */
function rowsOf(columns: readonly Column[]): Row[] {
  const sky = (c: Column) => c.station.reading?.sky ?? null;
  const overlays = (c: Column) => c.station.reading?.overlays ?? [];
  const words = columns.map((c) => sky(c)?.weather.length ?? 0);
  const anyMetar = columns.some((c) => c.station.reading?.from === 'observed');
  const anyOverlay = columns.some((c) => overlays(c).length > 0);
  const zone = zoneOf(columns[0]!.station.at);
  return [
    { key: 'nm', label: 'nm', lines: 1, cell: (c) => [String(Math.round(c.station.nm))] },
    { key: 'at', label: zone, lines: 1, cell: (c) => [clock24(c.station.at)] },
    ...(anyMetar
      ? [{ key: 'metar', label: 'METAR', lines: 1, cell: (c: Column) => (c.station.reading?.from === 'observed' && c.station.reading.issuedAt ? [clock24(c.station.reading.issuedAt)] : ['']) }]
      : []),
    { key: 'ground', label: 'ground', lines: 1, cell: (c) => [c.station.elevationFt === null ? '?' : c.station.elevationFt.toLocaleString('en')] },
    { key: 'vis', label: 'vis SM', lines: 1, cell: (c) => [sky(c)?.visibility?.replace(/ SM$/, '') ?? '–'] },
    {
      key: 'wx',
      label: 'weather',
      lines: Math.max(1, Math.min(3, ...[Math.max(...words)])),
      cell: (c) => {
        const w = sky(c)?.weather ?? [];
        return w.length === 0 ? ['–'] : w.length > 3 ? [...w.slice(0, 2), `+${w.length - 2}`] : w;
      },
    },
    ...(anyOverlay
      ? [
          {
            key: 'overlay',
            label: 'also',
            lines: 2,
            cell: (c: Column) => {
              const o = overlays(c)[0];
              if (!o) return [''];
              const base = sky(c);
              const changed = [...(o.sky.visibility && o.sky.visibility !== base?.visibility ? [o.sky.visibility.replace(/ SM$/, '')] : []), ...o.sky.weather.filter((w) => !base?.weather.includes(w))];
              return [o.label.replace(' TEMPO', '').replace(' BECMG', ''), changed.join(' ')];
            },
          },
        ]
      : []),
  ];
}

export function SideView({ stored, picture }: { stored: StoredBriefing; picture: RoutePicture }) {
  const columns = useMemo(() => columnsOf(stored, picture), [stored, picture]);
  const scroller = useRef<HTMLDivElement>(null);
  const [plotPx, setPlotPx] = useState(ASSUMED_PLOT_PX);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const measure = () => setPlotPx(el.clientWidth > AXIS_PX ? el.clientWidth - AXIS_PX : ASSUMED_PLOT_PX);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const watcher = new ResizeObserver(measure);
    watcher.observe(el);
    return () => watcher.disconnect();
  }, []);

  const miles = columns.map((c) => c.station.nm);
  const { xs, width, spreadApart } = spread(miles, plotPx);
  const terrain = useTerrain(picture);
  const ground = terrain === 'loading' || terrain === 'failed' ? null : terrain;
  const airspace = useAirspace(picture);
  const areas = typeof airspace === 'object' ? airspace.areas : [];
  const airspaceWords = airspaceLines(areas);
  const top = chartTop(picture, ground);
  const plotBottom = HEAD_PX + PLOT_PX;
  const yOf = (ft: number) => plotBottom - (ft / top) * PLOT_PX;
  const xAt = (nm: number) => xOfNm(nm, miles, xs);
  const blocks = airspaceBlocks(areas, top, ground, xAt, yOf);
  const rows = rowsOf(columns);
  const height = plotBottom + 8 + rows.reduce((h, r) => h + r.lines * ROW_PX, 0) + 6;
  let rowY = plotBottom + 8;
  const placed = rows.map((r) => {
    const y = rowY;
    rowY += r.lines * ROW_PX;
    return { row: r, y };
  });
  const ticks = altitudeTicks(top);
  const scrolls = width > plotPx + 1;

  const key = (e: KeyboardEvent, c: Column) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    openColumn(c);
  };

  return (
    <section className="side" aria-labelledby="side-title">
      <h3 id="side-title">Side view</h3>
      <p className="explain">
        Your route from the side, at the time you would pass each point. Tap a station for its line in Along the way, or a field you named for its page.
        {scrolls && ' Swipe sideways for the rest of the route.'}
      </p>
      <div className="side-chart">
        <div className="side-scroll" ref={scroller}>
          <svg className="side-axis" width={AXIS_PX} height={height} aria-hidden="true">
            <text className="sv-row-label" x={AXIS_PX - 6} y={HEAD_PX - 22} textAnchor="end">
              ft MSL
            </text>
            {ticks.map((ft) => (
              <text key={ft} className="sv-label" x={AXIS_PX - 6} y={yOf(ft) + 3.5} textAnchor="end">
                {ft.toLocaleString('en')}
              </text>
            ))}
            {placed.map(({ row, y }) => (
              <text key={row.key} className="sv-row-label" x={AXIS_PX - 6} y={y + 10} textAnchor="end">
                {row.label}
              </text>
            ))}
          </svg>
          <svg className="side-plot" width={width} height={height} role="group" aria-label={`Side view of the route, ${Math.round(picture.totalNm)} nm at ${picture.cruiseFt.toLocaleString('en')} ft. The list under Along the way says the same in words.`}>
            <defs>
              <linearGradient id="sv-fade" x1="0" y1="1" x2="0" y2="0">
                <stop offset="0" className="sv-fade-from" />
                <stop offset="1" className="sv-fade-to" />
              </linearGradient>
              <pattern id="sv-hatch-sigmet" width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                <line x1="0" y1="0" x2="0" y2="7" className="sv-hatch sigmet" />
              </pattern>
              <pattern id="sv-hatch-airmet" width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(135)">
                <line x1="0" y1="0" x2="0" y2="7" className="sv-hatch airmet" />
              </pattern>
            </defs>

            {ticks.map((ft) => (
              <line key={ft} className="sv-grid" x1={0} x2={width} y1={yOf(ft)} y2={yOf(ft)} />
            ))}

            {/* Before the ground, so what lies under the terrain is hidden by it. */}
            {blocks.map((b) => (
              <path key={b.key} className={airClass(b.kind)} d={b.path} />
            ))}

            {ground && <path className="sv-terrain" d={terrainPath(ground, xAt, yOf)} />}

            {blocks.flatMap((b) =>
              b.label ? (
                <text key={b.key} className="sv-label sv-halo" x={b.label.x} y={b.label.y}>
                  {b.label.text}
                </text>
              ) : [],
            )}

            {picture.hazards.map((h, i) =>
              h.stretches.map((s, j) => (
                <Band key={`${i}-${j}`} h={h} tag={hazardLetter(i)} stack={picture.hazards.slice(0, i).filter((o) => o.stretches.some((other) => other.fromNm < s.toNm && other.toNm > s.fromNm)).length} x0={xAt(s.fromNm)} x1={xAt(s.toNm)} top={top} yOf={yOf} plotTop={HEAD_PX} />
              )),
            )}

            {emptyStretches(columns)
              .filter((g) => xs[g.index + 1]! - xs[g.index]! >= EMPTY_WORDS_PX)
              .map((g) => (
                <text key={g.index} className="sv-empty sv-halo" x={(xs[g.index]! + xs[g.index + 1]!) / 2} y={plotBottom - 8} textAnchor="middle">
                  {Math.round(g.nm)} nm, nothing reporting
                </text>
              ))}

            {columns.map((c, i) => {
              const elevation = c.station.elevationFt;
              return elevation === null ? null : <rect key={i} className="sv-ground" x={xs[i]! - GROUND_PX / 2} y={yOf(elevation)} width={GROUND_PX} height={Math.max(1, plotBottom - yOf(elevation))} />;
            })}

            {columns.map((c, i) => {
              const reading = c.station.reading;
              const sky = reading?.sky;
              if (!reading || !sky) return null;
              const x = xs[i]!;
              const observed = reading.from === 'observed';
              const inChart = sky.layers.filter((l) => l.baseMsl !== null && l.baseMsl <= top);
              const worded = layersToLabel(inChart, yOf, LABEL_GAP_PX);
              const seen = new Set(sky.layers.map((l) => `${l.amount}${l.baseMsl}`));
              const extra = reading.overlays.flatMap((o) => o.sky.layers).filter((l) => l.baseMsl !== null && l.baseMsl <= top && !seen.has(`${l.amount}${l.baseMsl}`));
              return (
                <g key={i}>
                  {extra.map((l, j) => (
                    <line key={j} className="sv-overlay" x1={x - barWidth(l) / 2} x2={x + barWidth(l) / 2} y1={yOf(l.baseMsl!)} y2={yOf(l.baseMsl!)} />
                  ))}
                  {inChart.map((l, j) => (
                    <Cloud key={j} layer={l} x={x} y={yOf(l.baseMsl!)} observed={observed} label={worded.has(l)} />
                  ))}
                </g>
              );
            })}

            <line className="sv-cruise" x1={0} x2={width} y1={yOf(picture.cruiseFt)} y2={yOf(picture.cruiseFt)} />
            <text className="sv-cruise-label" x={4} y={yOf(picture.cruiseFt) - 4}>
              cruise {picture.cruiseFt.toLocaleString('en')}
            </text>

            {picture.freezing.map((f, i) => {
              const x = xAt(f.nm);
              const marks = [...f.crossingsFt.map((ft) => ({ ft, sign: '' })), ...(f.belowFt !== null ? [{ ft: f.belowFt, sign: '↓' }] : []), ...(f.aboveFt !== null && f.crossingsFt.length === 0 ? [{ ft: f.aboveFt, sign: '↑' }] : [])];
              return (
                <g key={i}>
                  {marks.filter((m) => m.ft <= top).map((m) => (
                    <g key={`${m.ft}${m.sign}`}>
                      <line className="sv-freezing" x1={x - 16} x2={x + 16} y1={yOf(m.ft)} y2={yOf(m.ft)} />
                      <text className="sv-label sv-halo" x={x} y={yOf(m.ft) + 11} textAnchor="middle">
                        0°{m.sign}
                      </text>
                    </g>
                  ))}
                </g>
              );
            })}

            {/* After the freezing level, and haloed, so a level near the top of the chart does not run through them. */}
            {columns.map((c, i) => {
              const layers = c.station.reading?.sky?.layers ?? [];
              const above = layers.filter((l) => l.baseMsl !== null && l.baseMsl > top).sort((a, b) => a.baseMsl! - b.baseMsl!);
              const unknown = layers.some((l) => l.baseMsl === null);
              return (
                <g key={i}>
                  {above[0] && (
                    <text className="sv-label sv-halo" x={xs[i]!} y={HEAD_PX + 11} textAnchor="middle">
                      <title>{layerText(above[0])} ft, above this chart</title>↑{heightText(above[0])}
                    </text>
                  )}
                  {unknown && (
                    <text className="sv-label sv-halo" x={xs[i]!} y={HEAD_PX + (above[0] ? 23 : 11)} textAnchor="middle">
                      <title>Cloud reported, but its height or its station's elevation is not known</title>?
                    </text>
                  )}
                </g>
              );
            })}

            {placePireps(picture.pireps, top, xAt, yOf).map(({ p, n, x, y }) => {
              const words = pirepTag(p);
              const onTheLeft = x + 14 + words.length * 6 > width;
              return (
                <g key={n}>
                  <title>{pirepWords(p)}</title>
                  <PirepMark x={x} y={y} n={n} hollow={!p.speaksForThen} />
                  {words && (
                    <text className="sv-label sv-halo" x={onTheLeft ? x - 11 : x + 11} y={y + 3.5} textAnchor={onTheLeft ? 'end' : 'start'}>
                      {words}
                    </text>
                  )}
                </g>
              );
            })}

            {columns.map((c, i) => (
              <g key={i}>
                <text className="sv-id" x={xs[i]!} y={13} textAnchor="middle">
                  {labelOf(c.station.id)}
                </text>
                <Chip x={xs[i]!} y={31} letter={c.category ? CATEGORY_LETTER[c.category] : '–'} category={(c.category ?? 'unknown').toLowerCase()} hollow={c.from !== 'forecast'} />
                {placed.map(({ row, y }) =>
                  row.cell(c).map((line, j) => (
                    <text key={`${row.key}-${j}`} className="sv-cell" x={xs[i]!} y={y + 10 + j * ROW_PX} textAnchor="middle">
                      {line}
                    </text>
                  )),
                )}
              </g>
            ))}

            {columns.map((c, i) => {
              const w = Math.min(COLUMN_PX, (xs[i + 1] ?? Infinity) - xs[i]!, xs[i]! * 2);
              return opens(c) ? (
                <rect key={i} className="sv-hit" x={xs[i]! - w / 2} y={0} width={w} height={height} tabIndex={0} role="link" aria-label={columnLabel(c)} onClick={() => openColumn(c)} onKeyDown={(e) => key(e, c)}>
                  <title>{columnLabel(c)}</title>
                </rect>
              ) : null;
            })}
          </svg>
        </div>
      </div>
      {picture.hazards.length > 0 && (
        <ul className="side-hazards">
          {picture.hazards.map((h, i) => (
            <li key={i}>
              <span className={`side-hazard-tag ${h.kind}`}>{hazardLetter(i)}</span> {hazardKey(h)}
            </li>
          ))}
        </ul>
      )}
      {picture.pireps.length > 0 && (
        <ul className="side-hazards side-pireps">
          {picture.pireps.map((p, i) => (
            <li key={i}>
              <span className={`side-pirep-tag${p.speaksForThen ? '' : ' hollow'}`}>{i + 1}</span> {pirepWords(p)}
              <span className="side-pirep-text">{p.text}</span>
            </li>
          ))}
        </ul>
      )}
      {airspaceWords.length > 0 && (
        <ul className="side-hazards side-airspace">
          {airspaceWords.map((line) => (
            <li key={`${line.kind}${line.name}`}>
              <span className={`side-air-tag ${AIRSPACE_STYLE[line.kind].hue}`}>{AIRSPACE_STYLE[line.kind].tag}</span> {line.name}: {line.words}
            </li>
          ))}
        </ul>
      )}
      <Key terrain={ground !== null} pireps={picture.pireps.length > 0} air={[...new Set(areas.map((a) => a.kind))]} />
      <ul className="side-notes">
        {notesOf(picture, columns, spreadApart, terrain, airspace).map((n) => (
          <li key={n}>{n}</li>
        ))}
        {areas.length > 0 && (
          <li>
            Airspace from the <a href="https://adds-faa.opendata.arcgis.com/">FAA's Aeronautical Data Delivery Service</a>.
          </li>
        )}
        {ground && (
          <li>
            Terrain from the <a href="https://doi.org/10.5270/ESA-c5d3d65">Copernicus DEM GLO-90</a> of the European Union's Copernicus programme, through <a href="https://open-meteo.com/">Open-Meteo</a>.
          </li>
        )}
      </ul>
    </section>
  );
}
