// Lens-correction profile lookup. Loads the vendored JSON once at module
// init, exposes a pure `resolveLensProfile(exif)` that returns interpolated
// radial-distortion coefficients keyed by EXIF lens model + focal length.
//
// Schema, format, and the canonical radial model are documented in
// `server/resources/lens-profiles.json`.

import profilesJson from '../../resources/lens-profiles.json';

type Calibration = { focal_mm: number; k1: number; k2: number; k3: number };

type LensEntry = {
  displayName: string;
  mount: string;
  calibrations: Calibration[];
};

type ProfileDb = {
  version: number;
  lenses: Record<string, LensEntry>;
};

export type ResolvedLensProfile = {
  /** Whether a matching lens entry exists in the profile DB. */
  hasProfile: boolean;
  /** Polynomial coefficients for r' = r·(1 + k1·r² + k2·r⁴ + k3·r⁶). All
   *  zero when hasProfile is false. */
  k1: number;
  k2: number;
  k3: number;
  /** Display name of the matched lens (or null when no match). */
  displayName: string | null;
  /** Echoed back for client-side captions. */
  focalLength: number | null;
};

// Normalize a free-form lens model string into a canonical lookup key.
// Lowercase, alphanumerics and spaces only, single-space-collapsed, trimmed.
// Also truncates at the first " or " separator — exiftool reports ambiguous
// lens detections as "Lens A or Lens B or Lens C + RF2x", and we want all of
// those to resolve to the same profile entry. Keep in lockstep with the
// compile script's normalizer.
export const normalizeLensModel = (s: string): string => {
  const trimmedAtOr = s.split(/\s+or\s+/i)[0];
  return trimmedAtOr
    .toLowerCase()
    .replaceAll(/[^a-z0-9 ]+/g, ' ')
    .replaceAll(/\s+/g, ' ')
    .trim();
};

const db: ProfileDb = profilesJson as ProfileDb;

const interpolate = (calibrations: Calibration[], focalMm: number): Calibration => {
  if (calibrations.length === 0) {
    return { focal_mm: focalMm, k1: 0, k2: 0, k3: 0 };
  }
  if (calibrations.length === 1) {
    return calibrations[0];
  }
  // Sort defensively; the JSON should already be sorted but don't rely on it.
  const sorted = [...calibrations].sort((a, b) => a.focal_mm - b.focal_mm);
  if (focalMm <= sorted[0].focal_mm) {
    return sorted[0];
  }
  const last = sorted.at(-1)!;
  if (focalMm >= last.focal_mm) {
    return last;
  }
  // Linear interpolation between the two bracketing entries.
  for (let i = 0; i < sorted.length - 1; i++) {
    const lo = sorted[i];
    const hi = sorted[i + 1];
    if (focalMm >= lo.focal_mm && focalMm <= hi.focal_mm) {
      const t = (focalMm - lo.focal_mm) / (hi.focal_mm - lo.focal_mm);
      return {
        focal_mm: focalMm,
        k1: lo.k1 + t * (hi.k1 - lo.k1),
        k2: lo.k2 + t * (hi.k2 - lo.k2),
        k3: lo.k3 + t * (hi.k3 - lo.k3),
      };
    }
  }
  return last;
};

export const resolveLensProfile = (exif: {
  lensModel?: string | null;
  focalLength?: number | null;
}): ResolvedLensProfile => {
  const emptyResult: ResolvedLensProfile = {
    hasProfile: false,
    k1: 0,
    k2: 0,
    k3: 0,
    displayName: null,
    focalLength: exif.focalLength ?? null,
  };

  if (!exif.lensModel) {
    return emptyResult;
  }

  const key = normalizeLensModel(exif.lensModel);
  const entry = db.lenses[key];
  if (!entry) {
    return emptyResult;
  }

  // No focal length? Take the middle calibration as a reasonable default —
  // better than zero coefficients, which would silently mean "no correction"
  // even though we matched a lens.
  const focal =
    exif.focalLength ??
    (entry.calibrations.length === 0
      ? 0
      : entry.calibrations[Math.floor(entry.calibrations.length / 2)].focal_mm);
  const cal = interpolate(entry.calibrations, focal);

  return {
    hasProfile: true,
    k1: cal.k1,
    k2: cal.k2,
    k3: cal.k3,
    displayName: entry.displayName,
    focalLength: exif.focalLength ?? null,
  };
};
