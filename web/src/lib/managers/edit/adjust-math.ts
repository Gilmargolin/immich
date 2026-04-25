// TypeScript reference implementation of the live-preview adjust math.
//
// This file exists for two reasons:
//   1. Pin numerical parity with the server (`server/src/repositories/
//      media.repository.ts → applyPrecomputedSliders / precomputeMask`).
//      If the math drifts on either side, "save" produces a photo that
//      doesn't match what the user dragged the sliders to.
//   2. Pin numerical parity with the GLSL shader in `adjust-shader.ts`.
//      The shader is hand-mirrored from this TS — if you change a formula
//      here, change it there too (and on the server).
//
// If you change ANY formula in this file, run the parity test and update
// the corresponding lines in:
//   - server/src/repositories/media.repository.ts (Node pixel loop)
//   - web/src/lib/managers/edit/adjust-shader.ts  (GLSL fragment)
//
// All math runs in linear-light. sRGB inputs are converted with the standard
// piecewise transfer function, and outputs converted back the same way.

import type { AdjustmentSliders, LocalMask } from './adjust-webgl';

const SRGB_TO_LINEAR_LUT = ((): Float32Array => {
  const lut = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    const v = i / 255;
    lut[i] = v <= 0.040_45 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  }
  return lut;
})();

export const srgbToLinearByte = (b: number): number => SRGB_TO_LINEAR_LUT[b];

export const linearToSrgb8 = (v: number): number => {
  if (v <= 0) {
    return 0;
  }
  if (v >= 1) {
    return 255;
  }
  const s = v <= 0.003_130_8 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
  return Math.round(s * 255);
};

export const smoothstep = (edge0: number, edge1: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
};

export const applyContrastChannel = (v: number, k: number): number => {
  const clamped = v < 0 ? 0 : v > 1 ? 1 : v;
  if (k >= 0) {
    const s = clamped * clamped * (3 - 2 * clamped);
    return clamped * (1 - k) + s * k;
  }
  return clamped * (1 + k) + 0.5 * -k;
};

export interface RgbLinear {
  r: number;
  g: number;
  b: number;
}

// Apply the nine sliders to a single linear-light RGB triple. Order matches
// the server: WB → exposure → tonal masks → saturation → contrast.
export const applySliders = (rgb: RgbLinear, s: AdjustmentSliders): RgbLinear => {
  let { r, g, b } = rgb;

  if (s.warmth !== 0 || s.tint !== 0) {
    r *= 1 + s.warmth * 0.3;
    b /= 1 + s.warmth * 0.3;
    g *= 1 + s.tint * 0.2;
  }

  if (s.brightness !== 0) {
    const m = Math.pow(2, s.brightness * 2);
    r *= m;
    g *= m;
    b *= m;
  }

  if (s.highlights !== 0 || s.shadows !== 0 || s.whitePoint !== 0 || s.blackPoint !== 0) {
    const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const yc = y < 0 ? 0 : y > 1 ? 1 : y;
    const highMask = smoothstep(0.5, 1, yc);
    const shadMask = 1 - smoothstep(0, 0.5, yc);
    const whiteMask = smoothstep(0.75, 1, yc);
    const blackMask = 1 - smoothstep(0, 0.25, yc);
    const dy =
      s.highlights * 0.25 * highMask +
      s.shadows * 0.25 * shadMask +
      s.whitePoint * 0.15 * whiteMask +
      s.blackPoint * 0.15 * blackMask;
    if (dy !== 0) {
      if (y > 0.001) {
        const scale = (y + dy) / y;
        r *= scale;
        g *= scale;
        b *= scale;
      } else {
        r += dy;
        g += dy;
        b += dy;
      }
    }
  }

  if (s.saturation !== 0) {
    const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    r = y + (r - y) * (1 + s.saturation);
    g = y + (g - y) * (1 + s.saturation);
    b = y + (b - y) * (1 + s.saturation);
  }

  if (s.contrast !== 0) {
    r = applyContrastChannel(r, s.contrast);
    g = applyContrastChannel(g, s.contrast);
    b = applyContrastChannel(b, s.contrast);
  }

  return { r, g, b };
};

// Per-pixel mask weight in [0, 1]. px is in pixel space.
export const maskWeight = (mask: LocalMask, px: number, py: number, width: number, height: number): number => {
  if (mask.kind === 'linear') {
    const ax = mask.ax * width;
    const ay = mask.ay * height;
    const bx = mask.bx * width;
    const by = mask.by * height;
    const vx = bx - ax;
    const vy = by - ay;
    const lenSq = vx * vx + vy * vy;
    if (lenSq < 1e-6) {
      return 0;
    }
    const t = ((px - ax) * vx + (py - ay) * vy) / lenSq;
    const c = t < 0 ? 0 : t > 1 ? 1 : t;
    return 1 - c * c * (3 - 2 * c);
  }

  const minDim = Math.min(width, height);
  const cx = mask.cx * width;
  const cy = mask.cy * height;
  const rx = Math.max(1, mask.rx * minDim);
  const ry = Math.max(1, mask.ry * minDim);
  const rad = (-mask.angle * Math.PI) / 180;
  const cosA = Math.cos(rad);
  const sinA = Math.sin(rad);
  const dx = px - cx;
  const dy = py - cy;
  const dxr = dx * cosA - dy * sinA;
  const dyr = dx * sinA + dy * cosA;
  const rxN = dxr / rx;
  const ryN = dyr / ry;
  const d = Math.sqrt(rxN * rxN + ryN * ryN);
  const fs = Math.max(0, 1 - Math.max(0.001, mask.feather));
  const w = 1 - smoothstep(fs, 1, d);
  return mask.invert ? 1 - w : w;
};

// Apply global sliders + masks to a single sRGB byte triple. Returns an sRGB
// byte triple. Mirrors the inner pixel loop in
// server/src/repositories/media.repository.ts → applyAdjustments.
export const applyAdjustToPixel = (
  rByte: number,
  gByte: number,
  bByte: number,
  globals: AdjustmentSliders,
  masks: LocalMask[],
  px: number,
  py: number,
  width: number,
  height: number,
): { r: number; g: number; b: number } => {
  let rgb: RgbLinear = {
    r: SRGB_TO_LINEAR_LUT[rByte],
    g: SRGB_TO_LINEAR_LUT[gByte],
    b: SRGB_TO_LINEAR_LUT[bByte],
  };

  rgb = applySliders(rgb, globals);

  for (const mask of masks) {
    const w = maskWeight(mask, px, py, width, height);
    if (w > 0) {
      const masked = applySliders(rgb, mask.params);
      rgb = {
        r: rgb.r + (masked.r - rgb.r) * w,
        g: rgb.g + (masked.g - rgb.g) * w,
        b: rgb.b + (masked.b - rgb.b) * w,
      };
    }
  }

  return {
    r: linearToSrgb8(rgb.r),
    g: linearToSrgb8(rgb.g),
    b: linearToSrgb8(rgb.b),
  };
};
