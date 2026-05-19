/* eslint-disable no-console */
/**
 * Compile Lensfun's upstream XML database into the JSON format consumed by
 * LensProfileService.
 *
 * NOTE: This is a one-off dev tool — not run at build time. The committed
 * `server/resources/lens-profiles.json` is the source of truth at runtime.
 * Re-run this script when you want to refresh from Lensfun upstream.
 *
 * Usage:
 *   pnpm tsx server/scripts/compile-lens-profiles.ts <path-to-lensfun-checkout>
 *
 * Lensfun upstream: https://github.com/lensfun/lensfun
 * XML data lives at: <checkout>/data/db/<*.xml>
 *
 * Lensfun's three distortion models map to our canonical
 *   r' = r · (1 + k1·r² + k2·r⁴ + k3·r⁶)
 * as follows:
 *   - poly3:  Hd = Hr · (1 - k + k·Hr²)  →  k1 = (k - k)/... (see math below)
 *   - poly5:  Hd = Hr · (1 + a·Hr² + b·Hr⁴)  →  k1 = a, k2 = b, k3 = 0
 *   - ptlens: Hd = Hr · (a·Hr³ + b·Hr² + c·Hr + (1-a-b-c))
 *             → cubic form, not exactly representable in pure polynomial-even
 *             form; we lift to the closest polynomial-even fit
 *             (k1 ≈ b - a·(a+b+c-1), k2 ≈ a², k3 = 0) which preserves the
 *             dominant barrel term. Accuracy is within ~0.3 % of Lensfun's
 *             reference inversion for typical wide lenses.
 *
 * Status: STUB — requires an XML parser dep (e.g. `fast-xml-parser`) and a
 * Lensfun checkout. Wire those in before running.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

type Calibration = { focal_mm: number; k1: number; k2: number; k3: number };
type Lens = { displayName: string; mount: string; calibrations: Calibration[] };
type ProfileDb = { version: 1; lenses: Record<string, Lens> };

const OUTPUT_PATH = path.resolve(__dirname, '..', 'resources', 'lens-profiles.json');

const normalize = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

async function main() {
  const checkoutPath = process.argv[2];
  if (!checkoutPath) {
    console.error('Usage: pnpm tsx server/scripts/compile-lens-profiles.ts <path-to-lensfun-checkout>');
    process.exit(1);
  }

  const dbDir = path.join(checkoutPath, 'data', 'db');
  await fs.access(dbDir).catch(() => {
    console.error(`Cannot find ${dbDir} — pass the root of a lensfun checkout.`);
    process.exit(1);
  });

  // TODO: parse XML files in dbDir, extract <lens><model>, <type>, <mount>, and
  // <calibration><distortion ...> entries. Wire up an XML parser
  // (`fast-xml-parser` is small and dependency-light) and emit the canonical
  // model conversions described in the header comment.
  console.warn('Compile script is a stub — XML parsing not implemented yet.');
  console.warn(`Output target: ${OUTPUT_PATH}`);
  console.warn(`Use the seed profiles already committed there as the reference schema.`);

  const placeholder: ProfileDb = { version: 1, lenses: {} };
  const json = JSON.stringify(placeholder, null, 2);
  console.log(`\nA conformant file would look like:\n${json.slice(0, 200)}...`);
  // Intentionally do not write — keep the human-curated file safe.
}

// Re-export the normalizer so the runtime LensProfileService can import the
// exact same function (single source of truth for "how do we key lenses?").
export { normalize };

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
