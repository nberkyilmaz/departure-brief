/**
 * Branded unit types.
 *
 * Visibility is statute miles; navigation is nautical miles; altitudes are AGL
 * or MSL; winds are true or magnetic. Each pair appears in the same code paths
 * and mixing them is a correctness bug, so they are distinct types. The brand
 * is erased at runtime — a `StatuteMiles` is a plain `number` in JSON.
 */

declare const brand: unique symbol;
type Brand<T, Name extends string> = T & { readonly [brand]: Name };

export type StatuteMiles = Brand<number, 'StatuteMiles'>;
export type NauticalMiles = Brand<number, 'NauticalMiles'>;
export type Meters = Brand<number, 'Meters'>;
export type Feet = Brand<number, 'Feet'>;
export type FeetAgl = Brand<number, 'FeetAgl'>;
export type FeetMsl = Brand<number, 'FeetMsl'>;
export type Knots = Brand<number, 'Knots'>;
export type MetersPerSecond = Brand<number, 'MetersPerSecond'>;
export type KilometersPerHour = Brand<number, 'KilometersPerHour'>;
export type DegreesTrue = Brand<number, 'DegreesTrue'>;
export type DegreesMagnetic = Brand<number, 'DegreesMagnetic'>;
export type Celsius = Brand<number, 'Celsius'>;
export type InchesHg = Brand<number, 'InchesHg'>;
export type HectoPascals = Brand<number, 'HectoPascals'>;
export type Inches = Brand<number, 'Inches'>;

export const sm = (n: number): StatuteMiles => n as StatuteMiles;
export const nm = (n: number): NauticalMiles => n as NauticalMiles;
export const meters = (n: number): Meters => n as Meters;
export const feet = (n: number): Feet => n as Feet;
export const ftAgl = (n: number): FeetAgl => n as FeetAgl;
export const ftMsl = (n: number): FeetMsl => n as FeetMsl;
export const kt = (n: number): Knots => n as Knots;
export const mps = (n: number): MetersPerSecond => n as MetersPerSecond;
export const kmh = (n: number): KilometersPerHour => n as KilometersPerHour;
export const degTrue = (n: number): DegreesTrue => n as DegreesTrue;
export const degMag = (n: number): DegreesMagnetic => n as DegreesMagnetic;
export const celsius = (n: number): Celsius => n as Celsius;
export const inHg = (n: number): InchesHg => n as InchesHg;
export const hPa = (n: number): HectoPascals => n as HectoPascals;
export const inches = (n: number): Inches => n as Inches;

export const METERS_PER_STATUTE_MILE = 1609.344;
export const METERS_PER_NAUTICAL_MILE = 1852;
export const KNOTS_PER_METER_PER_SECOND = 1.943844;

export const metersToStatuteMiles = (m: Meters): StatuteMiles => sm(m / METERS_PER_STATUTE_MILE);
export const mpsToKnots = (v: MetersPerSecond): Knots => kt(v * KNOTS_PER_METER_PER_SECOND);
export const kmhToKnots = (v: KilometersPerHour): Knots => kt(v / 1.852);
