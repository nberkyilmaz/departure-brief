/**
 * What every map on the site starts from. Imported only by the maps, so the
 * map library stays out of the pages that do not show one.
 */
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

export const isTouch = (): boolean => window.matchMedia?.('(pointer: coarse)').matches ?? false;

export function baseMap(container: HTMLElement, options: L.MapOptions = {}): L.Map {
  // Scrolling the page past the map should scroll the page; the wheel zooms only once the map has been clicked.
  const map = L.map(container, { scrollWheelZoom: false, minZoom: 3, maxZoom: 11, preferCanvas: true, ...options });
  map.once('click', () => map.scrollWheelZoom.enable());
  /*
   * OpenStreetMap's own tiles: no key, attribution shown, and light use like
   * this is within their policy. They come in one style only, so the dark
   * scheme inverts them in CSS rather than asking a second provider.
   */
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    maxZoom: 11,
  }).addTo(map);
  return map;
}
