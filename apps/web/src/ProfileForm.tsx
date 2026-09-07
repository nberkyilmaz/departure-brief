import type { AircraftInput, ProfileInput } from './types.js';

export const defaultProfile: ProfileInput = {
  name: 'default',
  version: 1,
  ceilingAglFt: 2500,
  visibilitySm: 5,
  crosswindKt: 15,
  crosswindIncludesGust: true,
  nightAllowed: true,
};

export const defaultAircraft: AircraftInput = { type: 'C172', demonstratedCrosswindKt: null };

export function ProfileForm({
  profile,
  aircraft,
  onProfile,
  onAircraft,
}: {
  profile: ProfileInput;
  aircraft: AircraftInput;
  onProfile: (p: ProfileInput) => void;
  onAircraft: (a: AircraftInput) => void;
}) {
  const set = (patch: Partial<ProfileInput>) => onProfile({ ...profile, ...patch });
  return (
    <fieldset>
      <legend>Personal minimums — yours, not the regulation's</legend>
      <div className="grid">
        <label>
          Ceiling (ft AGL)
          <input type="number" step={100} value={profile.ceilingAglFt} onChange={(e) => set({ ceilingAglFt: Number(e.target.value) })} />
        </label>
        <label>
          Visibility (SM)
          <input type="number" step={0.5} value={profile.visibilitySm} onChange={(e) => set({ visibilitySm: Number(e.target.value) })} />
        </label>
        <label>
          Crosswind (kt)
          <input type="number" value={profile.crosswindKt} onChange={(e) => set({ crosswindKt: Number(e.target.value) })} />
        </label>
        <label className="check">
          <input type="checkbox" checked={profile.crosswindIncludesGust} onChange={(e) => set({ crosswindIncludesGust: e.target.checked })} />
          Judge crosswind on the gust
        </label>
        <label className="check">
          <input type="checkbox" checked={profile.nightAllowed} onChange={(e) => set({ nightAllowed: e.target.checked })} />
          Night flight allowed
        </label>
        <label>
          Aircraft
          <input value={aircraft.type} onChange={(e) => onAircraft({ ...aircraft, type: e.target.value })} />
        </label>
        <label>
          POH demonstrated crosswind (kt)
          <input
            type="number"
            value={aircraft.demonstratedCrosswindKt ?? ''}
            placeholder="from the POH"
            onChange={(e) => onAircraft({ ...aircraft, demonstratedCrosswindKt: e.target.value === '' ? null : Number(e.target.value) })}
          />
        </label>
      </div>
    </fieldset>
  );
}
