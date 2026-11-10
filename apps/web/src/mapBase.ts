/**
 * What every map on the site starts from. Imported only by the maps, so the
 * map library stays out of the pages that do not show one.
 */
import { Map as MapLibreMap, NavigationControl, Popup, setWorkerUrl, type LngLatBoundsLike, type MapOptions } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';
import { chartStyle, PALETTE, type Scheme } from './chartStyle.js';
import type { MarkPopup } from './routeLayers.js';

/*
 * The library reads tiles in a worker of its own, which it looks for beside
 * its own file. Bundled, that file is somewhere else under another name, so
 * the bundler is asked for it and the library told where it went.
 */
setWorkerUrl(workerUrl);

export const isTouch = (): boolean => window.matchMedia?.('(pointer: coarse)').matches ?? false;
export const schemeNow = (): Scheme => (window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'night' : 'day');

/**
 * How the map takes a gesture. On a touch screen the map sits in a long
 * page, so one finger scrolls the page and two move the map. With a mouse,
 * the wheel scrolls the page until the map has been clicked.
 */
export const gesturesFor = (touch: boolean): Pick<MapOptions, 'cooperativeGestures' | 'scrollZoom'> => ({ cooperativeGestures: touch, scrollZoom: false });

export function baseMap(
  container: HTMLElement,
  view: { bounds: LngLatBoundsLike; padding?: number | { top: number; bottom: number; left: number; right: number } } | { center: [number, number]; zoom: number },
  scheme: Scheme = schemeNow(),
): MapLibreMap {
  const touch = isTouch();
  const map = new MapLibreMap({
    container,
    style: chartStyle(scheme),
    ...('bounds' in view ? { bounds: view.bounds, fitBoundsOptions: { padding: view.padding ?? 16, maxZoom: 9 } } : { center: view.center, zoom: view.zoom }),
    ...gesturesFor(touch),
    minZoom: 2,
    maxZoom: 13,
    // North stays up, as on a chart.
    dragRotate: false,
    pitchWithRotate: false,
    touchPitch: false,
    attributionControl: { compact: true },
  });
  map.touchZoomRotate.disableRotation();
  map.keyboard.disableRotation();
  map.addControl(new NavigationControl({ showCompass: false }), 'top-right');
  if (!touch) map.once('click', () => map.scrollZoom.enable());
  // Before anything that uses it: this listener is the first the map has.
  map.on('load', () => map.addImage('chart-airport', airportSymbol(PALETTE[scheme].airport), { pixelRatio: 2 }));
  return map;
}

/** A chart's airport symbol, small: a ring. Drawn at twice the size so it stays sharp. */
function airportSymbol(colour: string): ImageData {
  const size = 18;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const g = canvas.getContext('2d')!;
  g.strokeStyle = colour;
  g.lineWidth = 3;
  g.beginPath();
  g.arc(size / 2, size / 2, 5.5, 0, Math.PI * 2);
  g.stroke();
  return g.getImageData(0, 0, size, size);
}

/** A popup built from text, never from markup: report text and names are not ours to trust as HTML. */
export function popupWith(content: MarkPopup): Popup {
  const box = document.createElement('div');
  box.className = 'rm-popup';
  const head = document.createElement('b');
  head.textContent = content.title;
  box.append(head, ` ${content.text}`);
  if (content.code) {
    const code = document.createElement('code');
    code.textContent = content.code;
    box.append(document.createElement('br'), code);
  }
  return new Popup({ closeButton: true, maxWidth: '18rem', offset: 12 }).setDOMContent(box);
}
