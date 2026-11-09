/**
 * Where America's weather balloons go up.
 *
 * A sounding bulletin names its station by WMO number and says nothing else
 * about it: not where it is, and not how high the ground is, which is the
 * height of the first level it reports. So the table is carried here, from
 * NCEI's list of upper-air stations (`igra2-station-list.txt`), which gives
 * the launch site rather than the nearest airport.
 *
 * One bulletin per station, in a file of its own at NOAA, named by the
 * forecast office that launches it. Alaska is not here: its stations are
 * published only in combined bulletins that are overwritten piecemeal.
 */
import { distanceNm, type LatLon } from './geo.js';

export interface SoundingStation {
  /** The WMO number the bulletin goes by. */
  readonly id: string;
  /** The place, as a pilot would say it: "the Albany balloon". */
  readonly name: string;
  /** NOAA's file for it, under `data/raw/us/`, without the `.txt`. */
  readonly file: string;
  readonly lat: number;
  readonly lon: number;
  readonly elevationFt: number;
}

export const SOUNDING_STATIONS: readonly SoundingStation[] = [
  { id: '91165', name: 'Lihue', file: 'ushw40.phli.man.lih', lat: 21.9933, lon: -159.347, elevationFt: 106 },
  { id: '91285', name: 'Hilo', file: 'ushw40.phto.man.ito', lat: 19.7183, lon: -155.058, elevationFt: 36 },
  { id: '72518', name: 'Albany', file: 'usus41.kaly.man.aly', lat: 42.75, lon: -73.8, elevationFt: 289 },
  { id: '72528', name: 'Buffalo', file: 'usus41.kbuf.man.buf', lat: 42.9411, lon: -78.7189, elevationFt: 717 },
  { id: '72712', name: 'Caribou', file: 'usus41.kcar.man.car', lat: 46.8683, lon: -68.0136, elevationFt: 627 },
  { id: '74389', name: 'Gray', file: 'usus41.kgyx.man.gyx', lat: 43.8925, lon: -70.2572, elevationFt: 408 },
  { id: '72426', name: 'Wilmington, Ohio', file: 'usus41.kiln.man.iln', lat: 39.4214, lon: -83.8217, elevationFt: 1059 },
  { id: '72403', name: 'Sterling', file: 'usus41.klwx.man.iad', lat: 38.95, lon: -77.45, elevationFt: 312 },
  { id: '72501', name: 'Upton', file: 'usus41.kokx.man.okx', lat: 40.865, lon: -72.8628, elevationFt: 64 },
  { id: '72520', name: 'Pittsburgh', file: 'usus41.kpbz.man.pbz', lat: 40.5167, lon: -80.2167, elevationFt: 1184 },
  { id: '72318', name: 'Blacksburg', file: 'usus41.krnk.man.rnk', lat: 37.2039, lon: -80.4142, elevationFt: 2098 },
  { id: '72208', name: 'Charleston', file: 'usus42.kchs.man.chs', lat: 32.895, lon: -80.0275, elevationFt: 44 },
  { id: '72215', name: 'Peachtree City', file: 'usus42.kffc.man.ffc', lat: 33.3558, lon: -84.5672, elevationFt: 803 },
  { id: '72206', name: 'Jacksonville', file: 'usus42.kjax.man.jax', lat: 30.4839, lon: -81.7011, elevationFt: 33 },
  { id: '72201', name: 'Key West', file: 'usus42.kkey.man.key', lat: 24.5531, lon: -81.7886, elevationFt: 44 },
  { id: '72202', name: 'Miami', file: 'usus42.kmfl.man.mfl', lat: 25.75, lon: -80.3833, elevationFt: 13 },
  { id: '72305', name: 'Newport', file: 'usus42.kmhx.man.mhx', lat: 34.7761, lon: -76.8767, elevationFt: 36 },
  { id: '72317', name: 'Greensboro', file: 'usus42.krah.man.gso', lat: 36.0981, lon: -79.9428, elevationFt: 907 },
  { id: '72210', name: 'Tampa Bay', file: 'usus42.ktbw.man.tbw', lat: 27.7053, lon: -82.4006, elevationFt: 43 },
  { id: '72659', name: 'Aberdeen', file: 'usus43.kabr.man.abr', lat: 45.4556, lon: -98.4133, elevationFt: 1307 },
  { id: '72634', name: 'Gaylord', file: 'usus43.kapx.man.apx', lat: 44.9075, lon: -84.7189, elevationFt: 1469 },
  { id: '72764', name: 'Bismarck', file: 'usus43.kbis.man.bis', lat: 46.7717, lon: -100.759, elevationFt: 1661 },
  { id: '72451', name: 'Dodge City', file: 'usus43.kddc.man.ddc', lat: 37.7614, lon: -99.9686, elevationFt: 2580 },
  { id: '72747', name: 'International Falls', file: 'usus43.kdlh.man.inl', lat: 48.5647, lon: -93.3975, elevationFt: 1172 },
  { id: '72632', name: 'Detroit', file: 'usus43.kdtx.man.dtx', lat: 42.6989, lon: -83.4714, elevationFt: 1083 },
  { id: '74455', name: 'Davenport', file: 'usus43.kdvn.man.dvn', lat: 41.6114, lon: -90.5817, elevationFt: 756 },
  { id: '72645', name: 'Green Bay', file: 'usus43.kgrb.man.grb', lat: 44.4986, lon: -88.1119, elevationFt: 687 },
  { id: '74560', name: 'Lincoln', file: 'usus43.kilx.man.ilx', lat: 40.1517, lon: -89.3383, elevationFt: 588 },
  { id: '72562', name: 'North Platte', file: 'usus43.klbf.man.lbf', lat: 41.1328, lon: -100.7, elevationFt: 2785 },
  { id: '72649', name: 'Minneapolis', file: 'usus43.kmpx.man.mpx', lat: 44.8497, lon: -93.5647, elevationFt: 952 },
  { id: '72558', name: 'Omaha', file: 'usus43.koax.man.oax', lat: 41.32, lon: -96.3669, elevationFt: 1153 },
  { id: '72440', name: 'Springfield', file: 'usus43.ksgf.man.sgf', lat: 37.2347, lon: -93.4014, elevationFt: 1283 },
  { id: '72456', name: 'Topeka', file: 'usus43.ktop.man.top', lat: 39.0722, lon: -95.6305, elevationFt: 880 },
  { id: '72662', name: 'Rapid City', file: 'usus43.kunr.man.unr', lat: 44.0453, lon: -103.057, elevationFt: 3168 },
  { id: '72363', name: 'Amarillo', file: 'usus44.kama.man.ama', lat: 35.2331, lon: -101.709, elevationFt: 3593 },
  { id: '72230', name: 'Birmingham', file: 'usus44.kbmx.man.bmx', lat: 33.1789, lon: -86.7822, elevationFt: 571 },
  { id: '72250', name: 'Brownsville', file: 'usus44.kbro.man.bro', lat: 25.9167, lon: -97.4192, elevationFt: 23 },
  { id: '72251', name: 'Corpus Christi', file: 'usus44.kcrp.man.crp', lat: 27.7789, lon: -97.5055, elevationFt: 49 },
  { id: '72364', name: 'El Paso', file: 'usus44.kepz.man.epz', lat: 31.8728, lon: -106.698, elevationFt: 4114 },
  { id: '72261', name: 'Del Rio', file: 'usus44.kewx.man.drt', lat: 29.3744, lon: -100.918, elevationFt: 1030 },
  { id: '72249', name: 'Fort Worth', file: 'usus44.kfwd.man.fwd', lat: 32.835, lon: -97.2986, elevationFt: 640 },
  { id: '72235', name: 'Jackson', file: 'usus44.kjan.man.jan', lat: 32.3189, lon: -90.08, elevationFt: 298 },
  { id: '72240', name: 'Lake Charles', file: 'usus44.klch.man.lch', lat: 30.1253, lon: -93.2161, elevationFt: 16 },
  { id: '72233', name: 'Slidell', file: 'usus44.klix.man.lix', lat: 30.3369, lon: -89.825, elevationFt: 32 },
  { id: '72340', name: 'Little Rock', file: 'usus44.klzk.man.lzk', lat: 34.835, lon: -92.2594, elevationFt: 568 },
  { id: '72265', name: 'Midland', file: 'usus44.kmaf.man.maf', lat: 31.9425, lon: -102.189, elevationFt: 2870 },
  { id: '72327', name: 'Nashville', file: 'usus44.kohx.man.ohx', lat: 36.2333, lon: -86.55, elevationFt: 591 },
  { id: '72357', name: 'Norman', file: 'usus44.koun.man.oun', lat: 35.1808, lon: -97.4378, elevationFt: 1132 },
  { id: '72248', name: 'Shreveport', file: 'usus44.kshv.man.shv', lat: 32.4511, lon: -93.8414, elevationFt: 279 },
  { id: '72365', name: 'Albuquerque', file: 'usus45.kabq.man.abq', lat: 35.0378, lon: -106.622, elevationFt: 5312 },
  { id: '72681', name: 'Boise', file: 'usus45.kboi.man.boi', lat: 43.5672, lon: -116.211, elevationFt: 2865 },
  { id: '72376', name: 'Flagstaff', file: 'usus45.kfgz.man.fgz', lat: 35.23, lon: -111.822, elevationFt: 7149 },
  { id: '72768', name: 'Glasgow', file: 'usus45.kggw.man.ggw', lat: 48.2067, lon: -106.626, elevationFt: 2274 },
  { id: '72476', name: 'Grand Junction', file: 'usus45.kgjt.man.gjt', lat: 39.12, lon: -108.525, elevationFt: 4836 },
  { id: '72582', name: 'Elko', file: 'usus45.klkn.man.lkn', lat: 40.86, lon: -115.742, elevationFt: 5226 },
  { id: '74626', name: 'Phoenix', file: 'usus45.kpsr.man.psr', lat: 33.45, lon: -111.95, elevationFt: 1266 },
  { id: '72489', name: 'Reno', file: 'usus45.krev.man.rev', lat: 39.5681, lon: -119.797, elevationFt: 4980 },
  { id: '72672', name: 'Riverton', file: 'usus45.kriw.man.riw', lat: 43.0647, lon: -108.477, elevationFt: 5574 },
  { id: '72572', name: 'Salt Lake City', file: 'usus45.kslc.man.slc', lat: 40.7722, lon: -111.955, elevationFt: 4229 },
  { id: '72776', name: 'Great Falls', file: 'usus45.ktfx.man.tfx', lat: 47.4614, lon: -111.385, elevationFt: 3714 },
  { id: '72274', name: 'Tucson', file: 'usus45.ktwc.man.twc', lat: 32.2278, lon: -110.956, elevationFt: 2465 },
  { id: '72388', name: 'Las Vegas', file: 'usus45.kvef.man.vef', lat: 36.0471, lon: -115.185, elevationFt: 2287 },
  { id: '72597', name: 'Medford', file: 'usus46.kmfr.man.mfr', lat: 42.3769, lon: -122.882, elevationFt: 1306 },
  { id: '72493', name: 'Oakland', file: 'usus46.kmtr.man.oak', lat: 37.7444, lon: -122.224, elevationFt: 8 },
  { id: '72786', name: 'Spokane', file: 'usus46.kotx.man.otx', lat: 47.6806, lon: -117.627, elevationFt: 2392 },
  { id: '72694', name: 'Salem', file: 'usus46.kpqr.man.sle', lat: 44.9092, lon: -123.008, elevationFt: 205 },
  { id: '72797', name: 'Quillayute', file: 'usus46.ksew.man.uil', lat: 47.9339, lon: -124.56, elevationFt: 186 },
  { id: '72293', name: 'San Diego', file: 'usus46.ksgx.man.nkx', lat: 32.8333, lon: -117.117, elevationFt: 438 },
];

const BY_ID = new Map(SOUNDING_STATIONS.map((s) => [s.id, s]));

export const soundingStation = (id: string): SoundingStation | null => BY_ID.get(id) ?? null;

/** The stations within reach of a position, nearest first, each with how far away it is. */
export function soundingStationsNear(position: LatLon, radiusNm: number): { station: SoundingStation; distanceNm: number }[] {
  return SOUNDING_STATIONS.map((station) => ({ station, distanceNm: distanceNm(position, station) as number }))
    .filter((s) => s.distanceNm <= radiusNm)
    .sort((a, b) => a.distanceNm - b.distanceNm);
}
