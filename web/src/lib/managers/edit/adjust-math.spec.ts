// Parity tests for the TS reference impl in adjust-math.ts.
//
// These pin the same numerical invariants the server tests pin in
// server/src/repositories/media.repository.spec.ts. If a formula changes on
// either side, both test suites should be updated together — otherwise the
// preview drifts from the saved photo and the user sees the image "jump"
// on save.
//
// The GLSL shader in adjust-shader.ts is hand-mirrored from the TS in
// adjust-math.ts. We don't run GLSL in this test environment (would need
// headless WebGL). Visual parity between TS reference and shader is enforced
// by code review + the line-by-line correspondence between the two files.

import { applyAdjustToPixel, type BrushMaskBuffer } from '$lib/managers/edit/adjust-math';
import type { AdjustmentSliders, LocalMask } from '$lib/managers/edit/adjust-webgl';

const ZERO: AdjustmentSliders = {
  brightness: 0,
  contrast: 0,
  saturation: 0,
  warmth: 0,
  tint: 0,
  highlights: 0,
  shadows: 0,
  whitePoint: 0,
  blackPoint: 0,
};

// Apply a single value at one pixel; convenience wrapper for tests below.
const applyAt = (
  rgb: [number, number, number],
  globals: Partial<AdjustmentSliders> = {},
  masks: LocalMask[] = [],
  width = 100,
  height = 100,
  px = 50,
  py = 50,
  brushBuffers?: (BrushMaskBuffer | null | undefined)[],
) => applyAdjustToPixel(rgb[0], rgb[1], rgb[2], { ...ZERO, ...globals }, masks, px, py, width, height, brushBuffers);

describe('applyAdjustToPixel — global sliders', () => {
  it('round-trips a sRGB pixel when all sliders are zero', () => {
    const out = applyAt([128, 128, 128]);
    expect(out.r).toBeGreaterThanOrEqual(127);
    expect(out.r).toBeLessThanOrEqual(129);
    expect(out.g).toBe(out.r);
    expect(out.b).toBe(out.r);
  });

  it('brightness +0.5 lifts mid-gray (matches server bound > 160)', () => {
    const out = applyAt([128, 128, 128], { brightness: 0.5 });
    expect(out.r).toBeGreaterThan(160);
  });

  it('brightness -0.5 darkens mid-gray (matches server bound < 96)', () => {
    const out = applyAt([128, 128, 128], { brightness: -0.5 });
    expect(out.r).toBeLessThan(96);
  });

  it('saturation +0.8 pushes a red-leaning color further from luminance', () => {
    const out = applyAt([200, 100, 100], { saturation: 0.8 });
    expect(out.r).toBeGreaterThan(200);
    expect(out.g).toBeLessThan(100);
  });

  it('warmth +0.6 shifts R up and B down on neutral gray', () => {
    const out = applyAt([150, 150, 150], { warmth: 0.6 });
    expect(out.r).toBeGreaterThan(150);
    expect(out.b).toBeLessThan(150);
  });

  it('tint +0.5 makes neutral gray greener than R or B', () => {
    const out = applyAt([150, 150, 150], { tint: 0.5 });
    expect(out.g).toBeGreaterThan(out.r);
    expect(out.g).toBeGreaterThan(out.b);
  });

  it('highlights +0.5 brightens a near-white but barely touches mid-gray', () => {
    const bright = applyAt([220, 220, 220], { highlights: 0.5 });
    expect(bright.r).toBeGreaterThan(220);
    const mid = applyAt([128, 128, 128], { highlights: 1 });
    expect(Math.abs(mid.r - 128)).toBeLessThan(5);
  });

  // Regression: an earlier crop-mode preview applied an SVG `feFuncR
  // type=gamma` curve here (gamma = 1 / (1 + highlights·0.5) = 2 for
  // highlights=-1), which over-darkened mid-tones AND highlights compared
  // to what `applyAdjustments` writes on save. Pin the actual saved-side
  // behaviour: highlights=-1 makes a near-white pixel a touch darker (the
  // luminance mask weights are sub-1 even up at byte 220) and is a no-op
  // on a true mid-gray (mask is exactly 0 there).
  it('highlights -1 darkens a near-white pixel by roughly the smoothstep mask amount', () => {
    const bright = applyAt([220, 220, 220], { highlights: -1 });
    // For input byte 220, y_linear ≈ 0.716, smoothstep(0.5, 1, y) ≈ 0.40,
    // dy ≈ -0.099, scale ≈ 0.86; back through sRGB the byte lands ~206.
    // Allow a small band, but reject the SVG-gamma over-darkening (≤180).
    expect(bright.r).toBeGreaterThan(195);
    expect(bright.r).toBeLessThan(215);
  });

  it('highlights -1 barely touches mid-gray (luminance mask is ~0 there)', () => {
    const mid = applyAt([128, 128, 128], { highlights: -1 });
    expect(Math.abs(mid.r - 128)).toBeLessThan(5);
  });

  it('shadows +0.5 lifts dark gray but barely touches near-white', () => {
    const dark = applyAt([50, 50, 50], { shadows: 0.5 });
    expect(dark.r).toBeGreaterThan(50);
    const bright = applyAt([230, 230, 230], { shadows: 1 });
    expect(Math.abs(bright.r - 230)).toBeLessThan(5);
  });

  it('whitePoint +0.5 brightens a near-white pixel', () => {
    const out = applyAt([240, 240, 240], { whitePoint: 0.5 });
    expect(out.r).toBeGreaterThan(240);
  });

  it('blackPoint +0.5 lifts a near-black pixel', () => {
    const out = applyAt([10, 10, 10], { blackPoint: 0.5 });
    expect(out.r).toBeGreaterThan(20);
  });
});

describe('applyAdjustToPixel — local masks', () => {
  it('linear-gradient mask with brightness -1 darkens top, leaves bottom alone', () => {
    const mask: LocalMask = {
      kind: 'linear',
      ax: 0.5,
      ay: 0,
      bx: 0.5,
      by: 0.5,
      params: { ...ZERO, brightness: -1 },
    };

    const top = applyAt([180, 180, 180], {}, [mask], 100, 100, 50, 5);
    const bottom = applyAt([180, 180, 180], {}, [mask], 100, 100, 50, 95);

    expect(top.r).toBeLessThan(120);
    expect(bottom.r).toBeGreaterThan(170);
    expect(bottom.r).toBeLessThan(190);
  });

  it('linear-gradient mid biased toward A pulls the falloff toward A (so the band near B sees less effect)', () => {
    // AB runs y=0..50 in a 100×100 image. mid=0.2 means the 50% line sits
    // 20% along AB (y=10), so by y=25 the weight has dropped well below 0.5.
    const biasA: LocalMask = {
      kind: 'linear',
      ax: 0.5,
      ay: 0,
      bx: 0.5,
      by: 0.5,
      mid: 0.2,
      params: { ...ZERO, brightness: -1 },
    };
    const linear: LocalMask = { ...biasA, mid: 0.5 };

    // At y=25 (the literal midpoint of AB), the linear mask is at 50% effect
    // and the biased mask is well past that threshold (lower weight = brighter).
    const sampleLinear = applyAt([180, 180, 180], {}, [linear], 100, 100, 50, 25);
    const sampleBiased = applyAt([180, 180, 180], {}, [biasA], 100, 100, 50, 25);

    expect(sampleBiased.r).toBeGreaterThan(sampleLinear.r);
  });

  it('radial mask with brightness -1 darkens inside, leaves corner alone', () => {
    const mask: LocalMask = {
      kind: 'radial',
      cx: 0.5,
      cy: 0.5,
      rx: 0.25,
      ry: 0.25,
      angle: 0,
      feather: 0.1,
      invert: false,
      params: { ...ZERO, brightness: -1 },
    };

    const center = applyAt([180, 180, 180], {}, [mask], 100, 100, 50, 50);
    const corner = applyAt([180, 180, 180], {}, [mask], 100, 100, 5, 5);

    expect(center.r).toBeLessThan(120);
    expect(corner.r).toBeGreaterThan(170);
  });

  it('inverted radial mask flips the in/out region', () => {
    const mask: LocalMask = {
      kind: 'radial',
      cx: 0.5,
      cy: 0.5,
      rx: 0.25,
      ry: 0.25,
      angle: 0,
      feather: 0.1,
      invert: true,
      params: { ...ZERO, brightness: -1 },
    };

    const center = applyAt([180, 180, 180], {}, [mask], 100, 100, 50, 50);
    const corner = applyAt([180, 180, 180], {}, [mask], 100, 100, 5, 5);

    expect(center.r).toBeGreaterThan(170);
    expect(corner.r).toBeLessThan(120);
  });

  it('layered masks stack: mask 2 operates on mask 1 output', () => {
    const masks: LocalMask[] = [
      {
        kind: 'radial',
        cx: 0.5,
        cy: 0.5,
        rx: 0.3,
        ry: 0.3,
        angle: 0,
        feather: 0.05,
        invert: false,
        params: { ...ZERO, brightness: -0.5 },
      },
      {
        kind: 'radial',
        cx: 0.5,
        cy: 0.5,
        rx: 0.3,
        ry: 0.3,
        angle: 0,
        feather: 0.05,
        invert: false,
        params: { ...ZERO, brightness: 1 },
      },
    ];
    const stacked = applyAt([128, 128, 128], {}, masks, 100, 100, 50, 50);
    const onlyDark = applyAt([128, 128, 128], {}, [masks[0]], 100, 100, 50, 50);

    // ×0.5 then ×4 = ×2 net, so stacked should be brighter than base AND
    // brighter than mask-1-alone.
    expect(stacked.r).toBeGreaterThan(128);
    expect(stacked.r).toBeGreaterThan(onlyDark.r);
  });

  it('brush mask: painted pixel sees adjustment, unpainted does not', () => {
    // Build a tiny synthetic brush mask: 4×4, fully painted (255) in the
    // bottom-right 2×2 quadrant, fully transparent (0) elsewhere. Avoid PNG
    // decoding here — the math reference accepts a raw buffer so the spec
    // doesn't need a browser canvas/PNG codec.
    const buffer = new Uint8ClampedArray([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 255, 255, 0, 0, 255, 255]);
    const brushBuffer: BrushMaskBuffer = { buffer, width: 4, height: 4 };
    const mask: LocalMask = { kind: 'brush', mask: '', params: { ...ZERO, brightness: -1 } };

    // Image is 100×100. Pixel (10, 10) maps to UV (0.10, 0.10) → mask cell
    // ~ (0.30, 0.30) → top-left quadrant → unpainted, byte ≈ 0.
    const unpainted = applyAt([180, 180, 180], {}, [mask], 100, 100, 10, 10, [brushBuffer]);
    // Pixel (95, 95) maps to UV (0.95, 0.95) → mask cell ~ (2.85, 2.85) →
    // bottom-right quadrant → fully painted, byte ≈ 255.
    const painted = applyAt([180, 180, 180], {}, [mask], 100, 100, 95, 95, [brushBuffer]);

    expect(unpainted.r).toBeGreaterThan(170);
    expect(unpainted.r).toBeLessThan(190);
    // brightness=-1 with weight=1 cuts linear-light by 4× → byte 180 lands
    // around 95 after sRGB round-trip (matches the linear/radial brightness
    // tests above for an in-effect pixel).
    expect(painted.r).toBeLessThan(120);
  });

  it('brush mask without a buffer contributes nothing', () => {
    const mask: LocalMask = { kind: 'brush', mask: '', params: { ...ZERO, brightness: -1 } };
    // No brushBuffers passed → the brush sample defaults to 0 → unchanged.
    const out = applyAt([180, 180, 180], {}, [mask], 100, 100, 50, 50);
    expect(out.r).toBeGreaterThan(170);
    expect(out.r).toBeLessThan(190);
  });

  it('a mask with all-zero params is a no-op', () => {
    const mask: LocalMask = {
      kind: 'radial',
      cx: 0.5,
      cy: 0.5,
      rx: 0.3,
      ry: 0.3,
      angle: 0,
      feather: 0.1,
      invert: false,
      params: { ...ZERO },
    };
    const out = applyAt([128, 128, 128], {}, [mask]);
    expect(Math.abs(out.r - 128)).toBeLessThan(5);
  });

  // Luminance gate parity: pin the same numerical invariants the server
  // pins. lumLow/lumHigh scale a mask's effect by a smooth function of
  // luminance — within the spatial weight, dark pixels (below lumLow) and
  // bright pixels (above lumHigh) see less / no effect.
  it('lumLow=0.5/lumHigh=1: a dark pixel inside the mask region sees no effect', () => {
    // sRGB 30 ≈ 0.0116 linear — well below lumLow=0.5 minus the feather band,
    // so the gate is 0 and the brightness mask has no effect.
    const mask: LocalMask = {
      kind: 'radial',
      cx: 0.5,
      cy: 0.5,
      rx: 0.5,
      ry: 0.5,
      angle: 0,
      feather: 0.05,
      invert: false,
      lumLow: 0.5,
      lumHigh: 1,
      params: { ...ZERO, brightness: 1 },
    };
    const dark = applyAt([30, 30, 30], {}, [mask], 100, 100, 50, 50);
    // Without the gate, brightness=+1 would push 30 way up. With it, ~unchanged.
    expect(Math.abs(dark.r - 30)).toBeLessThan(5);
  });

  it('lumLow=0.5/lumHigh=1: a bright pixel inside the mask region sees full effect', () => {
    // sRGB 230 ≈ 0.79 linear — well above lumLow=0.5 + band, gate ≈ 1, so
    // brightness=+1 (×4 in linear) clips the byte all the way to 255.
    const mask: LocalMask = {
      kind: 'radial',
      cx: 0.5,
      cy: 0.5,
      rx: 0.5,
      ry: 0.5,
      angle: 0,
      feather: 0.05,
      invert: false,
      lumLow: 0.5,
      lumHigh: 1,
      params: { ...ZERO, brightness: 1 },
    };
    const bright = applyAt([230, 230, 230], {}, [mask], 100, 100, 50, 50);
    expect(bright.r).toBeGreaterThan(250);
  });
});
