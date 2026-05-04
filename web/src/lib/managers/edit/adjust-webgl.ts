import { FRAGMENT_SHADER, VERTEX_SHADER } from './adjust-shader';

export interface AdjustmentSliders {
  brightness: number;
  contrast: number;
  saturation: number;
  warmth: number;
  tint: number;
  highlights: number;
  shadows: number;
  whitePoint: number;
  blackPoint: number;
}

// Optional luminance gate — within the mask's spatial weight, scale the
// adjustment by a smooth function of pixel luminance. Defaults (0, 1) =
// identity (no behavior change vs. masks saved before the feature shipped).
// Use case: a small radial around a bird's head where you want to brighten
// only the dark feathers and leave the white cheek untouched.
export interface LumGate {
  lumLow?: number; // [0, 1], default 0
  lumHigh?: number; // [0, 1], default 1, must be ≥ lumLow
}

export type LinearMask = LumGate & {
  kind: 'linear';
  ax: number;
  ay: number;
  bx: number;
  by: number;
  // Optional falloff midpoint along AB (0..1). Defaults to 0.5 = linear ramp.
  // Moving away from 0.5 biases the soft transition closer to A or B.
  mid?: number;
  params: AdjustmentSliders;
};

export type RadialMask = LumGate & {
  kind: 'radial';
  cx: number;
  cy: number;
  rx: number;
  ry: number;
  angle: number;
  feather: number;
  invert: boolean;
  // Falloff midpoint within the outer halo band (0.05..0.95). 0.5 = uniform
  // smoothstep; lower bias keeps the falloff sharp near the inner edge,
  // higher bias keeps it sharp near the outer edge.
  mid?: number;
  params: AdjustmentSliders;
};

// Freehand brush mask. The user paints the affected region directly onto the
// photo; everything inside the painted alpha gets `params` applied. The mask
// is a 512×512 grayscale PNG (encoded as base64 — either raw or a
// `data:image/png;base64,...` data URL), sampled bilinearly by image-space UV.
// 255 = fully painted (weight 1.0), 0 = unpainted (weight 0.0), intermediate
// bytes give soft edges. No geometry fields — the mask covers the whole image.
export type BrushMask = LumGate & {
  kind: 'brush';
  mask: string;
  params: AdjustmentSliders;
};

export type LocalMask = LinearMask | RadialMask | BrushMask;

export const MAX_MASKS = 8;
// Fixed canvas resolution for the brush mask, in pixels. Must match
// BRUSH_MASK_RESOLUTION on the server.
export const BRUSH_MASK_RESOLUTION = 512;

const compileShader = (gl: WebGL2RenderingContext, type: number, source: string): WebGLShader => {
  const shader = gl.createShader(type);
  if (!shader) {
    throw new Error('Failed to create WebGL shader');
  }
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`Shader compile error: ${log}`);
  }
  return shader;
};

const linkProgram = (gl: WebGL2RenderingContext, vs: WebGLShader, fs: WebGLShader): WebGLProgram => {
  const program = gl.createProgram();
  if (!program) {
    throw new Error('Failed to create WebGL program');
  }
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program);
    gl.deleteProgram(program);
    throw new Error(`Program link error: ${log}`);
  }
  return program;
};

type Uniforms = {
  u_image: WebGLUniformLocation;
  u_imageSize: WebGLUniformLocation;
  u_cropRect: WebGLUniformLocation;
  globals: Record<keyof AdjustmentSliders, WebGLUniformLocation>;
  u_maskCount: WebGLUniformLocation;
  u_maskKind: WebGLUniformLocation;
  u_maskGeomA: WebGLUniformLocation;
  u_maskGeomB: WebGLUniformLocation;
  u_maskGeomC: WebGLUniformLocation;
  u_maskSliders0: WebGLUniformLocation;
  u_maskSliders1: WebGLUniformLocation;
  u_maskBlackPoint: WebGLUniformLocation;
  brushSamplers: WebGLUniformLocation[];
};

// Texture unit 0 is the source image; brush masks live at units [1, MAX_MASKS+1).
const BRUSH_TEX_UNIT_BASE = 1;

// Crop UV rect (u0, v0, u1, v1). Default is the full image (no crop).
export type CropRect = { u0: number; v0: number; u1: number; v1: number };
export const FULL_CROP: CropRect = { u0: 0, v0: 0, u1: 1, v1: 1 };

const requireLocation = (gl: WebGL2RenderingContext, program: WebGLProgram, name: string): WebGLUniformLocation => {
  const loc = gl.getUniformLocation(program, name);
  if (!loc) {
    throw new Error(`Uniform ${name} not found (likely optimized out)`);
  }
  return loc;
};

// Owns a WebGL2 context that renders the live adjust preview onto a canvas.
// Lifecycle: construct → setImage → render(state) → ... → dispose.
//
// Construction can throw (no WebGL2 support, shader compile failure). Call
// sites should catch and fall back to a non-WebGL preview path.
export class AdjustGLRenderer {
  private gl: WebGL2RenderingContext;
  private program: WebGLProgram;
  private uniforms: Uniforms;
  private texture: WebGLTexture;
  private vao: WebGLVertexArrayObject;
  private imageWidth = 1;
  private imageHeight = 1;
  // Pre-allocated typed arrays for uniform uploads (avoid per-frame churn).
  private kindBuf = new Int32Array(MAX_MASKS);
  private geomABuf = new Float32Array(MAX_MASKS * 4);
  private geomBBuf = new Float32Array(MAX_MASKS * 4);
  // u_maskGeomC: (lumLow, lumHigh, _, _) — luminance gate for both kinds.
  // Defaults (0, 1) ⇒ identity ⇒ byte-identical to pre-feature behavior.
  private geomCBuf = new Float32Array(MAX_MASKS * 4);
  private sliders0Buf = new Float32Array(MAX_MASKS * 4);
  private sliders1Buf = new Float32Array(MAX_MASKS * 4);
  private blackPointBuf = new Float32Array(MAX_MASKS);
  // One texture per mask slot. Always allocated with a 1×1 zero-filled
  // payload so the sampler is always valid (even for slots whose mask isn't
  // a brush). Brush masks re-upload into their slot's texture on render.
  private brushTextures: WebGLTexture[] = [];
  // Cache of the last-uploaded base64 string per slot so we don't re-decode +
  // re-upload the same PNG every frame. Cleared on slot reuse.
  private brushSrcCache: (string | null)[] = Array.from({ length: MAX_MASKS }, () => null);

  constructor(canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl2', { alpha: true, premultipliedAlpha: false });
    if (!gl) {
      throw new Error('WebGL2 not supported');
    }
    this.gl = gl;

    const vs = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
    const fs = compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
    this.program = linkProgram(gl, vs, fs);
    gl.deleteShader(vs);
    gl.deleteShader(fs);

    // Full-screen quad in clip space, with matching texCoords.
    // Two triangles, NDC (-1,-1)→(1,1). Texture v is flipped because we
    // upload the image with UNPACK_FLIP_Y_WEBGL=true so it's right-side-up.
    // prettier-ignore
    const positions = new Float32Array([
      -1, -1, 0, 0,
       1, -1, 1, 0,
      -1,  1, 0, 1,
      -1,  1, 0, 1,
       1, -1, 1, 0,
       1,  1, 1, 1,
    ]);

    const vao = gl.createVertexArray();
    if (!vao) {
      throw new Error('Failed to create VAO');
    }
    this.vao = vao;
    gl.bindVertexArray(vao);

    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, positions, gl.STATIC_DRAW);

    const aPos = gl.getAttribLocation(this.program, 'a_position');
    const aTex = gl.getAttribLocation(this.program, 'a_texCoord');
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 16, 0);
    gl.enableVertexAttribArray(aTex);
    gl.vertexAttribPointer(aTex, 2, gl.FLOAT, false, 16, 8);

    const tex = gl.createTexture();
    if (!tex) {
      throw new Error('Failed to create texture');
    }
    this.texture = tex;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

    // Brush-mask textures: one per slot. Each starts as a 1×1 zero-byte
    // greyscale texture so the sampler is valid even for slots whose mask
    // isn't a brush. CLAMP_TO_EDGE + LINEAR (no mipmaps), per the constraints
    // section in the brush-mask design.
    // Initial 1×1 zero RGBA texture per slot — sampler is always valid even
    // for non-brush slots, and shader reads .r so a zero pixel = weight 0.
    const zeroRgba = new Uint8Array([0, 0, 0, 0]);
    for (let i = 0; i < MAX_MASKS; i++) {
      const bt = gl.createTexture();
      if (!bt) {
        throw new Error('Failed to create brush-mask texture');
      }
      gl.activeTexture(gl.TEXTURE0 + BRUSH_TEX_UNIT_BASE + i);
      gl.bindTexture(gl.TEXTURE_2D, bt);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, zeroRgba);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      this.brushTextures.push(bt);
    }

    const brushSamplers: WebGLUniformLocation[] = [];
    for (let i = 0; i < MAX_MASKS; i++) {
      brushSamplers.push(requireLocation(gl, this.program, `u_brushMask${i}`));
    }

    this.uniforms = {
      u_image: requireLocation(gl, this.program, 'u_image'),
      u_imageSize: requireLocation(gl, this.program, 'u_imageSize'),
      u_cropRect: requireLocation(gl, this.program, 'u_cropRect'),
      globals: {
        brightness: requireLocation(gl, this.program, 'u_brightness'),
        contrast: requireLocation(gl, this.program, 'u_contrast'),
        saturation: requireLocation(gl, this.program, 'u_saturation'),
        warmth: requireLocation(gl, this.program, 'u_warmth'),
        tint: requireLocation(gl, this.program, 'u_tint'),
        highlights: requireLocation(gl, this.program, 'u_highlights'),
        shadows: requireLocation(gl, this.program, 'u_shadows'),
        whitePoint: requireLocation(gl, this.program, 'u_whitePoint'),
        blackPoint: requireLocation(gl, this.program, 'u_blackPoint'),
      },
      u_maskCount: requireLocation(gl, this.program, 'u_maskCount'),
      u_maskKind: requireLocation(gl, this.program, 'u_maskKind[0]'),
      u_maskGeomA: requireLocation(gl, this.program, 'u_maskGeomA[0]'),
      u_maskGeomB: requireLocation(gl, this.program, 'u_maskGeomB[0]'),
      u_maskGeomC: requireLocation(gl, this.program, 'u_maskGeomC[0]'),
      u_maskSliders0: requireLocation(gl, this.program, 'u_maskSliders0[0]'),
      u_maskSliders1: requireLocation(gl, this.program, 'u_maskSliders1[0]'),
      u_maskBlackPoint: requireLocation(gl, this.program, 'u_maskBlackPoint[0]'),
      brushSamplers,
    };
  }

  // Re-upload one brush mask's PNG into its texture slot. Decoding goes
  // through an HTMLImageElement so the browser handles the PNG bytes for us.
  // Returns synchronously after kicking off the upload (Promise<void>); the
  // caller's next render will pick up the new texture data.
  async uploadBrushMaskFromBase64(slot: number, base64: string | null): Promise<void> {
    if (slot < 0 || slot >= MAX_MASKS) {
      return;
    }
    const gl = this.gl;
    const tex = this.brushTextures[slot];
    if (!base64) {
      if (this.brushSrcCache[slot] !== null) {
        gl.activeTexture(gl.TEXTURE0 + BRUSH_TEX_UNIT_BASE + slot);
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 0]));
        this.brushSrcCache[slot] = null;
      }
      return;
    }
    if (this.brushSrcCache[slot] === base64) {
      return;
    }
    const url = base64.startsWith('data:') ? base64 : `data:image/png;base64,${base64}`;
    const img = new Image();
    img.src = url;
    await img.decode();
    gl.activeTexture(gl.TEXTURE0 + BRUSH_TEX_UNIT_BASE + slot);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    // Upload as RGBA and let the shader read the .r channel; this is the
    // most portable path (R8 from an HTMLImageElement upload isn't supported
    // by every implementation). The web encoder writes a greyscale PNG so all
    // four channels carry the same byte anyway.
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
    this.brushSrcCache[slot] = base64;
  }

  setImage(image: HTMLImageElement | ImageBitmap): void {
    const gl = this.gl;
    const w = 'naturalWidth' in image ? image.naturalWidth : image.width;
    const h = 'naturalHeight' in image ? image.naturalHeight : image.height;
    this.imageWidth = w;
    this.imageHeight = h;
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
  }

  // Resize the canvas drawing buffer to the (cropped) image dimensions
  // clamped to a max edge. Browser then scales via CSS to fill the visible
  // area; the wrapper's aspect-ratio is set from these dims so the page
  // layout shows the cropped photo correctly.
  resizeCanvas(crop: CropRect = FULL_CROP, maxEdge = 4096): void {
    const canvas = this.gl.canvas as HTMLCanvasElement;
    const cropW = Math.max(1, (crop.u1 - crop.u0) * this.imageWidth);
    const cropH = Math.max(1, (crop.v1 - crop.v0) * this.imageHeight);
    const aspect = cropW / cropH;
    let w = cropW;
    let h = cropH;
    if (w > maxEdge || h > maxEdge) {
      if (aspect >= 1) {
        w = maxEdge;
        h = Math.round(maxEdge / aspect);
      } else {
        h = maxEdge;
        w = Math.round(maxEdge * aspect);
      }
    }
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
  }

  render(globals: AdjustmentSliders, masks: LocalMask[], crop: CropRect = FULL_CROP): void {
    const gl = this.gl;
    const u = this.uniforms;
    const canvas = gl.canvas as HTMLCanvasElement;

    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    gl.useProgram(this.program);
    gl.bindVertexArray(this.vao);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.uniform1i(u.u_image, 0);
    // The y axis is flipped on upload (UNPACK_FLIP_Y_WEBGL=true), so the
    // crop's v values are flipped against texture-space-with-flip-y. Pass
    // them in flipped here so the visible crop matches what the user
    // selected in crop-area.
    gl.uniform4f(u.u_cropRect, crop.u0, 1 - crop.v1, crop.u1, 1 - crop.v0);
    // For mask-weight math, use the crop dimensions in pixels so masks
    // (whose normalized coords are post-crop) align with what the user sees.
    const cropPixelW = Math.max(1, (crop.u1 - crop.u0) * this.imageWidth);
    const cropPixelH = Math.max(1, (crop.v1 - crop.v0) * this.imageHeight);
    gl.uniform2f(u.u_imageSize, cropPixelW, cropPixelH);

    gl.uniform1f(u.globals.brightness, globals.brightness);
    gl.uniform1f(u.globals.contrast, globals.contrast);
    gl.uniform1f(u.globals.saturation, globals.saturation);
    gl.uniform1f(u.globals.warmth, globals.warmth);
    gl.uniform1f(u.globals.tint, globals.tint);
    gl.uniform1f(u.globals.highlights, globals.highlights);
    gl.uniform1f(u.globals.shadows, globals.shadows);
    gl.uniform1f(u.globals.whitePoint, globals.whitePoint);
    gl.uniform1f(u.globals.blackPoint, globals.blackPoint);

    const maskCount = Math.min(masks.length, MAX_MASKS);
    this.kindBuf.fill(0);
    this.geomABuf.fill(0);
    this.geomBBuf.fill(0);
    this.geomCBuf.fill(0);
    this.sliders0Buf.fill(0);
    this.sliders1Buf.fill(0);
    this.blackPointBuf.fill(0);

    for (let i = 0; i < maskCount; i++) {
      const m = masks[i];
      const p = m.params;
      this.sliders0Buf[i * 4 + 0] = p.brightness;
      this.sliders0Buf[i * 4 + 1] = p.contrast;
      this.sliders0Buf[i * 4 + 2] = p.saturation;
      this.sliders0Buf[i * 4 + 3] = p.warmth;
      this.sliders1Buf[i * 4 + 0] = p.tint;
      this.sliders1Buf[i * 4 + 1] = p.highlights;
      this.sliders1Buf[i * 4 + 2] = p.shadows;
      this.sliders1Buf[i * 4 + 3] = p.whitePoint;
      this.blackPointBuf[i] = p.blackPoint;

      // Luminance gate: defaults (0, 1) match the shader's no-op branch
      // (lumLow ≤ 0 && lumHigh ≥ 1), so unset gate stays byte-identical.
      this.geomCBuf[i * 4 + 0] = m.lumLow ?? 0;
      this.geomCBuf[i * 4 + 1] = m.lumHigh ?? 1;

      if (m.kind === 'linear') {
        this.kindBuf[i] = 0;
        this.geomABuf[i * 4 + 0] = m.ax;
        this.geomABuf[i * 4 + 1] = m.ay;
        this.geomABuf[i * 4 + 2] = m.bx;
        this.geomABuf[i * 4 + 3] = m.by;
        // For linear masks, geomB[0] carries the falloff midpoint (0..1).
        this.geomBBuf[i * 4 + 0] = m.mid ?? 0.5;
      } else if (m.kind === 'radial') {
        this.kindBuf[i] = 1;
        this.geomABuf[i * 4 + 0] = m.cx;
        this.geomABuf[i * 4 + 1] = m.cy;
        this.geomABuf[i * 4 + 2] = m.rx;
        this.geomABuf[i * 4 + 3] = m.ry;
        this.geomBBuf[i * 4 + 0] = m.angle;
        this.geomBBuf[i * 4 + 1] = m.feather;
        this.geomBBuf[i * 4 + 2] = m.invert ? 1 : 0;
        // geomB.w = mid (falloff bias), default 0.5.
        this.geomBBuf[i * 4 + 3] = m.mid ?? 0.5;
      } else {
        // Brush mask. Geometry uniforms are unused; the texture bound to
        // u_brushMask{i} carries the painted alpha. Caller is expected to
        // have already invoked uploadBrushMaskFromBase64(i, m.mask) so the
        // texture is fresh — render is sync and won't re-decode.
        this.kindBuf[i] = 2;
      }
    }

    // Bind every brush-mask sampler to its dedicated texture unit. Even
    // unused slots have a valid 1×1 zero texture bound so the sampler stays
    // legal — needed because the shader has all eight as separate uniforms.
    for (let i = 0; i < MAX_MASKS; i++) {
      gl.activeTexture(gl.TEXTURE0 + BRUSH_TEX_UNIT_BASE + i);
      gl.bindTexture(gl.TEXTURE_2D, this.brushTextures[i]);
      gl.uniform1i(u.brushSamplers[i], BRUSH_TEX_UNIT_BASE + i);
    }
    // Restore TEXTURE0 active so subsequent setImage calls don't surprise us.
    gl.activeTexture(gl.TEXTURE0);

    gl.uniform1i(u.u_maskCount, maskCount);
    gl.uniform1iv(u.u_maskKind, this.kindBuf);
    gl.uniform4fv(u.u_maskGeomA, this.geomABuf);
    gl.uniform4fv(u.u_maskGeomB, this.geomBBuf);
    gl.uniform4fv(u.u_maskGeomC, this.geomCBuf);
    gl.uniform4fv(u.u_maskSliders0, this.sliders0Buf);
    gl.uniform4fv(u.u_maskSliders1, this.sliders1Buf);
    gl.uniform1fv(u.u_maskBlackPoint, this.blackPointBuf);

    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  // Read a single sRGB pixel (post-render). Used by parity/diagnostics tests
  // and not on the normal preview path.
  readPixel(x: number, y: number): { r: number; g: number; b: number; a: number } {
    const gl = this.gl;
    const buf = new Uint8Array(4);
    gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    return { r: buf[0], g: buf[1], b: buf[2], a: buf[3] };
  }

  dispose(): void {
    const gl = this.gl;
    gl.deleteTexture(this.texture);
    for (const bt of this.brushTextures) {
      gl.deleteTexture(bt);
    }
    this.brushTextures = [];
    gl.deleteVertexArray(this.vao);
    gl.deleteProgram(this.program);
  }
}
