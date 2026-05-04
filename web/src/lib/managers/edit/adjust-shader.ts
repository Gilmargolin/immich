// Vertex + fragment shader for the live adjust preview.
//
// IMPORTANT: keep the math in lockstep with `applyAdjustments` in
// `server/src/repositories/media.repository.ts`. If you change a formula
// here, update the server copy too — otherwise the preview drifts from
// what `save` produces and users see the photo "jump" on save.
//
// This is GLSL ES 3.00 (WebGL 2). Branchless where it would help; explicit
// `if` blocks where the ops are expensive enough that gating them helps.

export const VERTEX_SHADER = /* glsl */ `#version 300 es
in vec2 a_position;
in vec2 a_texCoord;
out vec2 v_texCoord;
void main() {
  gl_Position = vec4(a_position, 0.0, 1.0);
  v_texCoord = a_texCoord;
}
`;

// Mask data is packed into uniform arrays so we don't need WebGL2 struct
// arrays (which work but are awkward to set from JS via uniformXX calls).
//
// For each mask slot i in [0, MAX_MASKS):
//   u_maskKind[i]        : 0 = linear, 1 = radial, 2 = brush
//                          (only matters for i < u_maskCount)
//   u_maskGeomA[i]       : linear → (ax, ay, bx, by) all normalized [0,1]
//                          radial → (cx, cy, rx, ry); cx/cy normalized to W/H,
//                                    rx/ry normalized to min(W, H)
//                          brush  → unused
//   u_maskGeomB[i]       : linear → (mid, _, _, _)
//                          radial → (angleDeg, feather, invert?1:0, mid)
//                          brush  → unused
//   u_maskSliders0[i]    : (brightness, contrast, saturation, warmth)
//   u_maskSliders1[i]    : (tint, highlights, shadows, whitePoint)
//   u_maskBlackPoint[i]  : blackPoint
//   u_brushMask[i]       : sampler2D bound to texture unit BRUSH_TEX_UNIT_BASE + i
//                          Sampled with normalized UV in [0, 1]; LINEAR
//                          filtering + CLAMP_TO_EDGE wrap. Only the red
//                          channel is used (greyscale upload).
export const FRAGMENT_SHADER = /* glsl */ `#version 300 es
precision highp float;

in vec2 v_texCoord;
out vec4 outColor;

uniform sampler2D u_image;
uniform vec2 u_imageSize;
// Crop rect as (u0, v0, u1, v1) in texture-UV space [0,1]. When the user has
// a pending crop, this restricts sampling to that subregion so the canvas
// shows the post-crop view (matches what crop mode renders).
uniform vec4 u_cropRect;

// Global sliders (same nine fields as AdjustmentSliders)
uniform float u_brightness;
uniform float u_contrast;
uniform float u_saturation;
uniform float u_warmth;
uniform float u_tint;
uniform float u_highlights;
uniform float u_shadows;
uniform float u_whitePoint;
uniform float u_blackPoint;

// Local masks
const int MAX_MASKS = 8;
uniform int u_maskCount;
uniform int u_maskKind[MAX_MASKS];
uniform vec4 u_maskGeomA[MAX_MASKS];
uniform vec4 u_maskGeomB[MAX_MASKS];
uniform vec4 u_maskSliders0[MAX_MASKS];
uniform vec4 u_maskSliders1[MAX_MASKS];
uniform float u_maskBlackPoint[MAX_MASKS];
// One brush-mask sampler per slot. Slots whose kind is not 2 (brush) still
// have a 1×1 zeroed texture bound so the sampler is valid; the maskWeight
// branch only reads from these for kind==2 slots.
uniform sampler2D u_brushMask0;
uniform sampler2D u_brushMask1;
uniform sampler2D u_brushMask2;
uniform sampler2D u_brushMask3;
uniform sampler2D u_brushMask4;
uniform sampler2D u_brushMask5;
uniform sampler2D u_brushMask6;
uniform sampler2D u_brushMask7;

float smoothStepF(float edge0, float edge1, float x) {
  float t = clamp((x - edge0) / (edge1 - edge0), 0.0, 1.0);
  return t * t * (3.0 - 2.0 * t);
}

vec3 srgbToLinear(vec3 c) {
  vec3 cutoff = step(vec3(0.04045), c);
  vec3 lo = c / 12.92;
  vec3 hi = pow((c + 0.055) / 1.055, vec3(2.4));
  return mix(lo, hi, cutoff);
}

vec3 linearToSrgb(vec3 c) {
  c = clamp(c, vec3(0.0), vec3(1.0));
  vec3 cutoff = step(vec3(0.0031308), c);
  vec3 lo = c * 12.92;
  vec3 hi = 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055;
  return mix(lo, hi, cutoff);
}

float applyContrastChannel(float v, float k) {
  v = clamp(v, 0.0, 1.0);
  if (k >= 0.0) {
    float s = v * v * (3.0 - 2.0 * v);
    return v * (1.0 - k) + s * k;
  }
  return v * (1.0 + k) + 0.5 * (-k);
}

// Apply the same nine-slider math the server does. Mirrors
// applyPrecomputedSliders in media.repository.ts.
vec3 applySliders(
  vec3 rgb,
  float brightness, float contrast, float saturation, float warmth,
  float tint, float highlights, float shadows, float whitePoint, float blackPoint
) {
  if (warmth != 0.0 || tint != 0.0) {
    rgb.r *= 1.0 + warmth * 0.3;
    rgb.b /= 1.0 + warmth * 0.3;
    rgb.g *= 1.0 + tint * 0.2;
  }
  if (brightness != 0.0) {
    rgb *= pow(2.0, brightness * 2.0);
  }
  if (highlights != 0.0 || shadows != 0.0 || whitePoint != 0.0 || blackPoint != 0.0) {
    float y = dot(rgb, vec3(0.2126, 0.7152, 0.0722));
    float yc = clamp(y, 0.0, 1.0);
    float highMask = smoothStepF(0.5, 1.0, yc);
    float shadMask = 1.0 - smoothStepF(0.0, 0.5, yc);
    float whiteMask = smoothStepF(0.75, 1.0, yc);
    float blackMask = 1.0 - smoothStepF(0.0, 0.25, yc);
    float dy = highlights * 0.25 * highMask
             + shadows * 0.25 * shadMask
             + whitePoint * 0.15 * whiteMask
             + blackPoint * 0.15 * blackMask;
    if (dy != 0.0) {
      if (y > 0.001) {
        rgb *= (y + dy) / y;
      } else {
        rgb += vec3(dy);
      }
    }
  }
  if (saturation != 0.0) {
    float y = dot(rgb, vec3(0.2126, 0.7152, 0.0722));
    rgb = vec3(y) + (rgb - vec3(y)) * (1.0 + saturation);
  }
  if (contrast != 0.0) {
    rgb.r = applyContrastChannel(rgb.r, contrast);
    rgb.g = applyContrastChannel(rgb.g, contrast);
    rgb.b = applyContrastChannel(rgb.b, contrast);
  }
  return rgb;
}

// Sample the brush-mask texture for slot idx at normalized UV. GLSL ES 3.00
// disallows indexing a sampler array by a non-constant; an explicit if-chain
// is the standard workaround. Only the red channel (greyscale upload).
float sampleBrushMask(int idx, vec2 uv) {
  if (idx == 0) return texture(u_brushMask0, uv).r;
  if (idx == 1) return texture(u_brushMask1, uv).r;
  if (idx == 2) return texture(u_brushMask2, uv).r;
  if (idx == 3) return texture(u_brushMask3, uv).r;
  if (idx == 4) return texture(u_brushMask4, uv).r;
  if (idx == 5) return texture(u_brushMask5, uv).r;
  if (idx == 6) return texture(u_brushMask6, uv).r;
  return texture(u_brushMask7, uv).r;
}

// Per-pixel mask weight in [0, 1]. Mirrors precomputeMask in
// media.repository.ts. px is in pixel space.
float maskWeight(int idx, vec2 px) {
  if (u_maskKind[idx] == 2) {
    // Brush mask: sample the bound texture by image-space UV. CLAMP_TO_EDGE
    // wrap + LINEAR filter on the texture handle the bilinear interpolation
    // the math reference uses explicitly.
    return sampleBrushMask(idx, px / u_imageSize);
  }
  if (u_maskKind[idx] == 0) {
    vec2 a = u_maskGeomA[idx].xy * u_imageSize;
    vec2 b = u_maskGeomA[idx].zw * u_imageSize;
    vec2 v = b - a;
    float lenSq = dot(v, v);
    if (lenSq < 1e-6) return 0.0;
    float t = clamp(dot(px - a, v) / lenSq, 0.0, 1.0);
    // Falloff midpoint (0..1, default 0.5). Piecewise-linear remap so that
    // t == mid maps to 0.5, then the smoothstep below shapes the curve.
    float mid = clamp(u_maskGeomB[idx].x, 0.05, 0.95);
    float r = t <= mid ? (t * 0.5) / mid : 0.5 + ((t - mid) * 0.5) / (1.0 - mid);
    return 1.0 - r * r * (3.0 - 2.0 * r);
  }
  float minDim = min(u_imageSize.x, u_imageSize.y);
  vec2 c = u_maskGeomA[idx].xy * u_imageSize;
  float rx = max(1.0, u_maskGeomA[idx].z * minDim);
  float ry = max(1.0, u_maskGeomA[idx].w * minDim);
  float angleDeg = u_maskGeomB[idx].x;
  float feather = u_maskGeomB[idx].y;
  bool invert = u_maskGeomB[idx].z > 0.5;
  float rmid = clamp(u_maskGeomB[idx].w, 0.05, 0.95);
  float rad = -angleDeg * 3.14159265358979323846 / 180.0;
  float cosA = cos(rad);
  float sinA = sin(rad);
  vec2 d = px - c;
  vec2 dr = vec2(d.x * cosA - d.y * sinA, d.x * sinA + d.y * cosA);
  float dist = length(vec2(dr.x / rx, dr.y / ry));
  // Drawn ellipse = solid inner boundary (weight=1 anywhere inside). The
  // feather param is the width of the outer halo where weight transitions
  // from 1 to 0, measured in fractions of the semi-axis. The mid param
  // biases where weight=0.5 lands inside that band (piecewise-linear remap
  // before the cubic smoothstep, matching the linear mask).
  float featherSpan = max(0.001, feather);
  float t = clamp((dist - 1.0) / featherSpan, 0.0, 1.0);
  float r = (t <= rmid) ? (t * 0.5 / rmid) : (0.5 + (t - rmid) * 0.5 / (1.0 - rmid));
  float w = 1.0 - r * r * (3.0 - 2.0 * r);
  return invert ? 1.0 - w : w;
}

void main() {
  // Sample within the crop rect — v_texCoord is the canvas's [0,1] but the
  // texture coords go through the crop region.
  vec2 uv = mix(u_cropRect.xy, u_cropRect.zw, v_texCoord);
  vec4 srcRgba = texture(u_image, uv);
  vec3 lin = srgbToLinear(srcRgba.rgb);

  lin = applySliders(
    lin,
    u_brightness, u_contrast, u_saturation, u_warmth,
    u_tint, u_highlights, u_shadows, u_whitePoint, u_blackPoint
  );

  // v_texCoord runs (0,0) at the BOTTOM-left of the canvas (WebGL Y-up
  // convention) while the mask DTO and SVG overlay use Y top-to-bottom
  // (also the server's pixel-buffer iteration order). Flip Y here so the
  // live preview's affected area lines up with the red overlay and matches
  // what the server produces on save.
  vec2 px = vec2(v_texCoord.x, 1.0 - v_texCoord.y) * u_imageSize;
  for (int i = 0; i < MAX_MASKS; ++i) {
    if (i >= u_maskCount) break;
    float w = maskWeight(i, px);
    if (w > 0.0) {
      vec4 s0 = u_maskSliders0[i];
      vec4 s1 = u_maskSliders1[i];
      vec3 masked = applySliders(lin, s0.x, s0.y, s0.z, s0.w, s1.x, s1.y, s1.z, s1.w, u_maskBlackPoint[i]);
      lin = mix(lin, masked, w);
    }
  }

  outColor = vec4(linearToSrgb(lin), srcRgba.a);
}
`;
