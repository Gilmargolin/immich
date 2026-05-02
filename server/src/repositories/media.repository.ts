import { Injectable } from '@nestjs/common';
import { ExifDateTime, exiftool, WriteTags } from 'exiftool-vendored';
import ffmpeg, { FfprobeData } from 'fluent-ffmpeg';
import { Duration } from 'luxon';
import fs from 'node:fs/promises';
import { Writable } from 'node:stream';
import sharp from 'sharp';
import { ORIENTATION_TO_SHARP_ROTATION } from 'src/constants';
import { Exif } from 'src/database';
import {
  AdjustmentSliders,
  AdjustParameters,
  AssetEditActionItem,
  LocalMask,
  LocalMaskKind,
} from 'src/dtos/editing.dto';
import { Colorspace, LogLevel, RawExtractedFormat } from 'src/enum';
import { LoggingRepository } from 'src/repositories/logging.repository';
import {
  DecodeToBufferOptions,
  GenerateThumbhashOptions,
  GenerateThumbnailOptions,
  ImageDimensions,
  ProbeOptions,
  TranscodeCommand,
  VideoInfo,
} from 'src/types';
import { handlePromiseError } from 'src/utils/misc';
import { createAffineMatrix } from 'src/utils/transform';

const probe = (input: string, options: string[]): Promise<FfprobeData> =>
  new Promise((resolve, reject) =>
    ffmpeg.ffprobe(input, options, (error, data) => (error ? reject(error) : resolve(data))),
  );
sharp.concurrency(0);
sharp.cache({ files: 0 });

type ProgressEvent = {
  frames: number;
  currentFps: number;
  currentKbps: number;
  targetSize: number;
  timemark: string;
  percent?: number;
};

export type ExtractResult = {
  buffer: Buffer;
  format: RawExtractedFormat;
};

// 8-bit sRGB → linear-light lookup. Built once per process.
const SRGB_TO_LINEAR_LUT = ((): Float32Array => {
  const lut = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    const v = i / 255;
    lut[i] = v <= 0.040_45 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  }
  return lut;
})();

const linearToSrgb8 = (v: number): number => {
  if (v <= 0) {
    return 0;
  }
  if (v >= 1) {
    return 255;
  }
  const s = v <= 0.003_130_8 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
  return Math.round(s * 255);
};

const smoothstep = (edge0: number, edge1: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
};

const isSlidersActive = (s: AdjustmentSliders): boolean =>
  s.brightness !== 0 ||
  s.contrast !== 0 ||
  s.saturation !== 0 ||
  s.warmth !== 0 ||
  s.tint !== 0 ||
  s.highlights !== 0 ||
  s.shadows !== 0 ||
  s.whitePoint !== 0 ||
  s.blackPoint !== 0;

const isAdjustActive = (p: AdjustParameters): boolean =>
  isSlidersActive(p) || (p.masks !== undefined && p.masks.length > 0);

// Per-channel contrast S-curve (positive) / flatten (negative) in linear space.
// k in [-1, 1]. k > 0: cubic smoothstep toward extremes. k < 0: mix toward mid-gray.
const applyContrast = (v: number, k: number): number => {
  const clamped = v < 0 ? 0 : v > 1 ? 1 : v;
  if (k >= 0) {
    const s = clamped * clamped * (3 - 2 * clamped);
    return clamped * (1 - k) + s * k;
  }
  return clamped * (1 + k) + 0.5 * -k;
};

type PrecomputedSliders = {
  active: boolean;
  hasWb: boolean;
  warmthR: number;
  warmthB: number;
  tintG: number;
  hasExposure: boolean;
  exposureMult: number;
  hasTonal: boolean;
  highAmp: number;
  shadAmp: number;
  whiteAmp: number;
  blackAmp: number;
  hasSat: boolean;
  satMult: number;
  hasContrast: boolean;
  contrastK: number;
};

const precomputeSliders = (s: AdjustmentSliders): PrecomputedSliders => {
  const exposureMult = s.brightness === 0 ? 1 : Math.pow(2, s.brightness * 2);
  const warmthR = 1 + s.warmth * 0.3;
  const warmthB = 1 / (1 + s.warmth * 0.3);
  const tintG = 1 + s.tint * 0.2;
  const hasWb = s.warmth !== 0 || s.tint !== 0;
  const hasExposure = exposureMult !== 1;
  const hasTonal = s.highlights !== 0 || s.shadows !== 0 || s.whitePoint !== 0 || s.blackPoint !== 0;
  const hasSat = s.saturation !== 0;
  const hasContrast = s.contrast !== 0;
  return {
    active: hasWb || hasExposure || hasTonal || hasSat || hasContrast,
    hasWb,
    warmthR,
    warmthB,
    tintG,
    hasExposure,
    exposureMult,
    hasTonal,
    highAmp: s.highlights * 0.25,
    shadAmp: s.shadows * 0.25,
    whiteAmp: s.whitePoint * 0.15,
    blackAmp: s.blackPoint * 0.15,
    hasSat,
    satMult: 1 + s.saturation,
    hasContrast,
    contrastK: s.contrast,
  };
};

// Scratch return container. Hot loop: 6M+ pixels × (1 + mask-count) calls,
// so allocating a fresh object per call is expensive — reuse one module-local.
// Single-threaded by Node semantics; safe here.
const rgbScratch = { r: 0, g: 0, b: 0 };

const applyPrecomputedSliders = (
  rIn: number,
  gIn: number,
  bIn: number,
  c: PrecomputedSliders,
): { r: number; g: number; b: number } => {
  let r = rIn;
  let g = gIn;
  let b = bIn;

  if (c.hasWb) {
    r *= c.warmthR;
    g *= c.tintG;
    b *= c.warmthB;
  }
  if (c.hasExposure) {
    r *= c.exposureMult;
    g *= c.exposureMult;
    b *= c.exposureMult;
  }
  if (c.hasTonal) {
    const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const yClamped = y < 0 ? 0 : y > 1 ? 1 : y;
    const highMask = smoothstep(0.5, 1, yClamped);
    const shadMask = 1 - smoothstep(0, 0.5, yClamped);
    const whiteMask = smoothstep(0.75, 1, yClamped);
    const blackMask = 1 - smoothstep(0, 0.25, yClamped);
    const deltaY = c.highAmp * highMask + c.shadAmp * shadMask + c.whiteAmp * whiteMask + c.blackAmp * blackMask;

    if (deltaY !== 0) {
      if (y > 0.001) {
        const scale = (y + deltaY) / y;
        r *= scale;
        g *= scale;
        b *= scale;
      } else {
        r += deltaY;
        g += deltaY;
        b += deltaY;
      }
    }
  }
  if (c.hasSat) {
    const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    r = y + (r - y) * c.satMult;
    g = y + (g - y) * c.satMult;
    b = y + (b - y) * c.satMult;
  }
  if (c.hasContrast) {
    r = applyContrast(r, c.contrastK);
    g = applyContrast(g, c.contrastK);
    b = applyContrast(b, c.contrastK);
  }

  rgbScratch.r = r;
  rgbScratch.g = g;
  rgbScratch.b = b;
  return rgbScratch;
};

type PrecomputedMask = {
  sliders: PrecomputedSliders;
  weight: (x: number, y: number) => number;
};

// Build a per-pixel weight function from a LocalMask. Coordinates in the mask
// DTO are normalized: cx/ax/etc to [0,1] of image width; cy/ay/etc to [0,1] of
// image height. Radial rx/ry are normalized to min(W, H) so rx=ry renders as a
// circle regardless of image aspect.
const precomputeMask = (mask: LocalMask, width: number, height: number): PrecomputedMask => {
  const sliders = precomputeSliders(mask.params);

  if (mask.kind === LocalMaskKind.Linear) {
    const ax = mask.ax * width;
    const ay = mask.ay * height;
    const bx = mask.bx * width;
    const by = mask.by * height;
    const vx = bx - ax;
    const vy = by - ay;
    const lenSq = vx * vx + vy * vy;
    if (lenSq < 1e-6) {
      return { sliders, weight: () => 0 };
    }
    const nx = vx / lenSq;
    const ny = vy / lenSq;
    // Falloff midpoint: t value where weight = 0.5. Default 0.5 = pure linear.
    // Off-center mid gives a piecewise-linear remap of t before the smoothstep
    // so the user can pull the soft transition closer to A or B.
    const mid = Math.min(0.95, Math.max(0.05, mask.mid ?? 0.5));
    const invMid = 0.5 / mid;
    const invComp = 0.5 / (1 - mid);
    return {
      sliders,
      weight: (x, y) => {
        const t = (x - ax) * nx + (y - ay) * ny;
        const clamped = t < 0 ? 0 : t > 1 ? 1 : t;
        const r = clamped <= mid ? clamped * invMid : 0.5 + (clamped - mid) * invComp;
        return 1 - r * r * (3 - 2 * r);
      },
    };
  }

  const minDim = Math.min(width, height);
  const cx = mask.cx * width;
  const cy = mask.cy * height;
  const rx = Math.max(1, mask.rx * minDim);
  const ry = Math.max(1, mask.ry * minDim);
  const rad = (-mask.angle * Math.PI) / 180;
  const cosA = Math.cos(rad);
  const sinA = Math.sin(rad);
  // featherStart < featherEnd; weight = 1 for d ≤ featherStart, 0 for d ≥ featherEnd.
  // The drawn ellipse is always the solid inner boundary (weight = 1 anywhere
  // inside). `feather` is the width of the falloff halo OUTSIDE the ellipse,
  // expressed as a fraction of the semi-axis.
  //   feather = 0   → sharp edge at the ellipse boundary
  //   feather = 1   → halo extends one full radius past the ellipse
  //   feather = 2   → halo extends two radii past the ellipse
  const featherStart = 1;
  const featherEnd = 1 + Math.max(0.001, mask.feather);
  const invert = mask.invert;

  return {
    sliders,
    weight: (x, y) => {
      const dx = x - cx;
      const dy = y - cy;
      const dxr = dx * cosA - dy * sinA;
      const dyr = dx * sinA + dy * cosA;
      const rxN = dxr / rx;
      const ryN = dyr / ry;
      const d = Math.sqrt(rxN * rxN + ryN * ryN);
      let w = 1 - smoothstep(featherStart, featherEnd, d);
      if (invert) {
        w = 1 - w;
      }
      return w;
    },
  };
};

// Apply color/lighting adjustments by materializing the pipeline to an 8-bit
// sRGB raw buffer, doing per-pixel math in linear light (correct gamma), then
// re-ingesting. This gives us:
//   - channel-multiplier white balance for warmth/tint (matches web preview)
//   - exposure-style brightness (multiplicative in linear)
//   - range-selective highlights/shadows/whites/blacks via smooth luminance
//     masks, applied as hue-preserving RGB scales
//   - saturation and contrast in linear space so mid-tones don't get muddy
//   - optional local masks (linear gradient, radial ellipse) layered on top
const applyAdjustments = async (pipeline: sharp.Sharp, params: AdjustParameters): Promise<sharp.Sharp> => {
  const { data, info } = await pipeline.toColorspace('srgb').raw().toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;
  if (channels < 3) {
    return sharp(data, { raw: { width, height, channels } });
  }

  const globalSliders = precomputeSliders(params);
  const masks = (params.masks ?? [])
    .map((m) => precomputeMask(m, width, height))
    .filter((m) => m.sliders.active);

  if (!globalSliders.active && masks.length === 0) {
    return sharp(data, { raw: { width, height, channels } });
  }

  const out = Buffer.alloc(data.length);
  const maskCount = masks.length;

  let pixelIndex = 0;
  for (let i = 0; i < data.length; i += channels, pixelIndex++) {
    const x = pixelIndex % width;
    const y = (pixelIndex / width) | 0;

    let r = SRGB_TO_LINEAR_LUT[data[i]];
    let g = SRGB_TO_LINEAR_LUT[data[i + 1]];
    let b = SRGB_TO_LINEAR_LUT[data[i + 2]];

    if (globalSliders.active) {
      const adj = applyPrecomputedSliders(r, g, b, globalSliders);
      r = adj.r;
      g = adj.g;
      b = adj.b;
    }

    for (let mi = 0; mi < maskCount; mi++) {
      const mask = masks[mi];
      const w = mask.weight(x, y);
      if (w > 0) {
        const adj = applyPrecomputedSliders(r, g, b, mask.sliders);
        r = r + (adj.r - r) * w;
        g = g + (adj.g - g) * w;
        b = b + (adj.b - b) * w;
      }
    }

    out[i] = linearToSrgb8(r);
    out[i + 1] = linearToSrgb8(g);
    out[i + 2] = linearToSrgb8(b);
    if (channels === 4) {
      out[i + 3] = data[i + 3];
    }
  }

  return sharp(out, { raw: { width, height, channels } });
};

@Injectable()
export class MediaRepository {
  constructor(private logger: LoggingRepository) {
    this.logger.setContext(MediaRepository.name);
  }

  /**
   *
   * @param input file path to the input image
   * @returns ExtractResult if succeeded, or null if failed
   */
  async extract(input: string): Promise<ExtractResult | null> {
    try {
      const buffer = await exiftool.extractBinaryTagToBuffer('JpgFromRaw2', input);
      return { buffer, format: RawExtractedFormat.Jpeg };
    } catch (error: any) {
      this.logger.debug(`Could not extract JpgFromRaw2 buffer from image, trying JPEG from RAW next: ${error}`);
    }

    try {
      const buffer = await exiftool.extractBinaryTagToBuffer('JpgFromRaw', input);
      return { buffer, format: RawExtractedFormat.Jpeg };
    } catch (error: any) {
      this.logger.debug(`Could not extract JPEG buffer from image, trying PreviewJXL next: ${error}`);
    }

    try {
      const buffer = await exiftool.extractBinaryTagToBuffer('PreviewJXL', input);
      return { buffer, format: RawExtractedFormat.Jxl };
    } catch (error: any) {
      this.logger.debug(`Could not extract PreviewJXL buffer from image, trying PreviewImage next: ${error}`);
    }

    try {
      const buffer = await exiftool.extractBinaryTagToBuffer('PreviewImage', input);
      return { buffer, format: RawExtractedFormat.Jpeg };
    } catch (error: any) {
      this.logger.debug(`Could not extract preview buffer from image: ${error}`);
      return null;
    }
  }

  async writeExif(tags: Partial<Exif>, output: string): Promise<boolean> {
    try {
      const tagsToWrite: WriteTags = {
        ExifImageWidth: tags.exifImageWidth,
        ExifImageHeight: tags.exifImageHeight,
        DateTimeOriginal: tags.dateTimeOriginal && ExifDateTime.fromMillis(tags.dateTimeOriginal.getTime()),
        ModifyDate: tags.modifyDate && ExifDateTime.fromMillis(tags.modifyDate.getTime()),
        TimeZone: tags.timeZone,
        GPSLatitude: tags.latitude,
        GPSLongitude: tags.longitude,
        ProjectionType: tags.projectionType,
        City: tags.city,
        Country: tags.country,
        Make: tags.make,
        Model: tags.model,
        LensModel: tags.lensModel,
        Fnumber: tags.fNumber?.toFixed(1),
        FocalLength: tags.focalLength?.toFixed(1),
        ISO: tags.iso,
        ExposureTime: tags.exposureTime,
        ProfileDescription: tags.profileDescription,
        ColorSpace: tags.colorspace,
        Rating: tags.rating === null ? 0 : tags.rating,
        // specially convert Orientation to numeric Orientation# for exiftool
        'Orientation#': tags.orientation ? Number(tags.orientation) : undefined,
      };

      await exiftool.write(output, tagsToWrite, {
        ignoreMinorErrors: true,
        writeArgs: ['-overwrite_original'],
      });
      return true;
    } catch (error: any) {
      this.logger.warn(`Could not write exif data to image: ${error.message}`);
      return false;
    }
  }

  async copyTagGroup(tagGroup: string, source: string, target: string): Promise<boolean> {
    try {
      await exiftool.write(
        target,
        {},
        {
          ignoreMinorErrors: true,
          writeArgs: ['-TagsFromFile', source, `-${tagGroup}:all>${tagGroup}:all`, '-overwrite_original'],
        },
      );
      return true;
    } catch (error: any) {
      this.logger.warn(`Could not copy tag data to image: ${error.message}`);
      return false;
    }
  }

  async decodeImage(input: string | Buffer, options: DecodeToBufferOptions) {
    const pipeline = await this.getImageDecodingPipeline(input, options);
    return pipeline.raw().toBuffer({ resolveWithObject: true });
  }

  private async applyEdits(pipeline: sharp.Sharp, edits: AssetEditActionItem[]): Promise<sharp.Sharp> {
    const crop = edits.find((edit) => edit.action === 'crop');
    const rotateEdit = edits.find((edit) => edit.action === 'rotate');
    const mirrorEdits = edits.filter((edit) => edit.action === 'mirror');
    const adjustEdit = edits.find((edit) => edit.action === 'adjust');

    // 1. Apply crop
    if (crop) {
      pipeline = pipeline.extract({
        left: Math.round(crop.parameters.x),
        top: Math.round(crop.parameters.y),
        width: Math.round(crop.parameters.width),
        height: Math.round(crop.parameters.height),
      });
    }

    // 2. Apply mirrors
    for (const mirror of mirrorEdits) {
      if (mirror.parameters.axis === 'horizontal') {
        pipeline = pipeline.flop();
      } else {
        pipeline = pipeline.flip();
      }
    }

    // 3. Apply rotation
    if (rotateEdit) {
      const totalAngle = rotateEdit.parameters.angle;
      const normalizedAngle = ((totalAngle % 360) + 360) % 360;
      const angle90 = Math.round(normalizedAngle / 90) * 90;
      const freeAngle = normalizedAngle - angle90;

      // Apply 90° component (no canvas expansion, skip full 360° rotation)
      if (angle90 % 360 !== 0) {
        pipeline = pipeline.rotate(angle90);
      }

      // Apply free rotation component
      if (Math.abs(freeAngle) > 0.01) {
        // Materialize to get actual dimensions before free rotation
        const { data, info } = await pipeline.raw().toBuffer({ resolveWithObject: true });
        const W = info.width;
        const H = info.height;

        // Rotate with black background, then crop inscribed rectangle
        const theta = Math.abs(freeAngle) * (Math.PI / 180);
        const cosT = Math.cos(theta);
        const sinT = Math.sin(theta);

        // Inscribed rectangle (no black corners)
        const cos2T = Math.cos(2 * theta);
        let iW: number;
        let iH: number;
        if (Math.abs(cos2T) > 0.001) {
          iW = Math.max(1, (W * cosT - H * sinT) / cos2T);
          iH = Math.max(1, (H * cosT - W * sinT) / cos2T);
        } else {
          const minDim = Math.min(W, H);
          iW = minDim / (cosT + sinT);
          iH = iW;
        }

        // Rotate and extract inscribed rectangle
        pipeline = sharp(data, { raw: { width: W, height: H, channels: info.channels } })
          .rotate(freeAngle, { background: { r: 0, g: 0, b: 0 } });

        // Get actual rotated dimensions and extract centered inscribed rect
        const rotated = await pipeline.raw().toBuffer({ resolveWithObject: true });
        const rW = rotated.info.width;
        const rH = rotated.info.height;

        const extractW = Math.min(Math.round(iW), rW);
        const extractH = Math.min(Math.round(iH), rH);
        const left = Math.max(0, Math.round((rW - extractW) / 2));
        const top = Math.max(0, Math.round((rH - extractH) / 2));

        pipeline = sharp(rotated.data, { raw: { width: rW, height: rH, channels: rotated.info.channels } })
          .extract({ left, top, width: extractW, height: extractH });
      }
    }

    // 4. Apply color/lighting adjustments
    if (adjustEdit && isAdjustActive(adjustEdit.parameters)) {
      pipeline = await applyAdjustments(pipeline, adjustEdit.parameters);
    }

    return pipeline;
  }

  async generateThumbnail(input: string | Buffer, options: GenerateThumbnailOptions, output: string): Promise<void> {
    const pipeline = await this.getImageDecodingPipeline(input, options);
    const decoded = pipeline.toFormat(options.format, {
      quality: options.quality,
      // this is default in libvips (except the threshold is 90), but we need to set it manually in sharp
      chromaSubsampling: options.quality >= 80 ? '4:4:4' : '4:2:0',
      progressive: options.progressive,
    });

    await decoded.toFile(output);
  }

  private async getImageDecodingPipeline(input: string | Buffer, options: DecodeToBufferOptions) {
    let pipeline = sharp(input, {
      // some invalid images can still be processed by sharp, but we want to fail on them by default to avoid crashes
      failOn: options.processInvalidImages ? 'none' : 'error',
      limitInputPixels: false,
      raw: options.raw,
      unlimited: true,
    })
      .pipelineColorspace(options.colorspace === Colorspace.Srgb ? 'srgb' : 'rgb16')
      .withIccProfile(options.colorspace);

    if (!options.raw) {
      const { angle, flip, flop } = options.orientation ? ORIENTATION_TO_SHARP_ROTATION[options.orientation] : {};
      pipeline = pipeline.rotate(angle);
      if (flip) {
        pipeline = pipeline.flip();
      }

      if (flop) {
        pipeline = pipeline.flop();
      }
    }

    if (options.edits && options.edits.length > 0) {
      pipeline = await this.applyEdits(pipeline, options.edits);
    }

    if (options.size !== undefined) {
      pipeline = pipeline.resize(options.size, options.size, { fit: 'outside', withoutEnlargement: true });
    }
    return pipeline;
  }

  async generateThumbhash(input: string | Buffer, options: GenerateThumbhashOptions): Promise<Buffer> {
    const [{ rgbaToThumbHash }, decodingPipeline] = await Promise.all([
      import('thumbhash'),
      this.getImageDecodingPipeline(input, {
        colorspace: options.colorspace,
        processInvalidImages: options.processInvalidImages,
        raw: options.raw,
        edits: options.edits,
      }),
    ]);

    const pipeline = decodingPipeline.resize(100, 100, { fit: 'inside' }).raw().ensureAlpha();

    const { data, info } = await pipeline.toBuffer({ resolveWithObject: true });

    // Ensure dimensions are within thumbhash limits (100x100) after affine transforms
    if (info.width > 100 || info.height > 100) {
      const resized = sharp(data, { raw: { width: info.width, height: info.height, channels: info.channels } })
        .resize(100, 100, { fit: 'inside' })
        .raw()
        .ensureAlpha();
      const result = await resized.toBuffer({ resolveWithObject: true });
      return Buffer.from(rgbaToThumbHash(result.info.width, result.info.height, result.data));
    }

    return Buffer.from(rgbaToThumbHash(info.width, info.height, data));
  }

  async probe(input: string, options?: ProbeOptions): Promise<VideoInfo> {
    const results = await probe(input, options?.countFrames ? ['-count_packets'] : []); // gets frame count quickly: https://stackoverflow.com/a/28376817
    return {
      format: {
        formatName: results.format.format_name,
        formatLongName: results.format.format_long_name,
        duration: this.parseFloat(results.format.duration),
        bitrate: this.parseInt(results.format.bit_rate),
      },
      videoStreams: results.streams
        .filter((stream) => stream.codec_type === 'video' && !stream.disposition?.attached_pic)
        .map((stream) => {
          const height = this.parseInt(stream.height);
          const dar = this.getDar(stream.display_aspect_ratio);
          return {
            index: stream.index,
            height,
            width: dar ? Math.round(height * dar) : this.parseInt(stream.width),
            codecName: stream.codec_name === 'h265' ? 'hevc' : stream.codec_name,
            codecType: stream.codec_type,
            frameCount: this.parseInt(options?.countFrames ? stream.nb_read_packets : stream.nb_frames),
            rotation: this.parseInt(stream.rotation),
            isHDR: stream.color_transfer === 'smpte2084' || stream.color_transfer === 'arib-std-b67',
            bitrate: this.parseInt(stream.bit_rate),
            pixelFormat: stream.pix_fmt || 'yuv420p',
            colorPrimaries: stream.color_primaries,
            colorSpace: stream.color_space,
            colorTransfer: stream.color_transfer,
          };
        }),
      audioStreams: results.streams
        .filter((stream) => stream.codec_type === 'audio')
        .map((stream) => ({
          index: stream.index,
          codecType: stream.codec_type,
          codecName: stream.codec_name,
          bitrate: this.parseInt(stream.bit_rate),
        })),
    };
  }

  transcode(input: string, output: string | Writable, options: TranscodeCommand): Promise<void> {
    if (!options.twoPass) {
      return new Promise((resolve, reject) => {
        this.configureFfmpegCall(input, output, options)
          .on('error', reject)
          .on('end', () => resolve())
          .run();
      });
    }

    if (typeof output !== 'string') {
      throw new TypeError('Two-pass transcoding does not support writing to a stream');
    }

    // two-pass allows for precise control of bitrate at the cost of running twice
    // recommended for vp9 for better quality and compression
    return new Promise((resolve, reject) => {
      // first pass output is not saved as only the .log file is needed
      this.configureFfmpegCall(input, '/dev/null', options)
        .addOptions('-pass', '1')
        .addOptions('-passlogfile', output)
        .addOptions('-f null')
        .on('error', reject)
        .on('end', () => {
          // second pass
          this.configureFfmpegCall(input, output, options)
            .addOptions('-pass', '2')
            .addOptions('-passlogfile', output)
            .on('error', reject)
            .on('end', () => handlePromiseError(fs.unlink(`${output}-0.log`), this.logger))
            .on('end', () => handlePromiseError(fs.rm(`${output}-0.log.mbtree`, { force: true }), this.logger))
            .on('end', () => resolve())
            .run();
        })
        .run();
    });
  }

  async getImageMetadata(input: string | Buffer): Promise<ImageDimensions & { isTransparent: boolean }> {
    const { width = 0, height = 0, hasAlpha = false } = await sharp(input).metadata();
    return { width, height, isTransparent: hasAlpha };
  }

  private configureFfmpegCall(input: string, output: string | Writable, options: TranscodeCommand) {
    const ffmpegCall = ffmpeg(input, { niceness: 10 })
      .inputOptions(options.inputOptions)
      .outputOptions(options.outputOptions)
      .output(output)
      .on('start', (command: string) => this.logger.debug(command))
      .on('error', (error, _, stderr) => this.logger.error(stderr || error));

    const { frameCount, percentInterval } = options.progress;
    const frameInterval = Math.ceil(frameCount / (100 / percentInterval));
    if (this.logger.isLevelEnabled(LogLevel.Debug) && frameCount && frameInterval) {
      let lastProgressFrame: number = 0;
      ffmpegCall.on('progress', (progress: ProgressEvent) => {
        if (progress.frames - lastProgressFrame < frameInterval) {
          return;
        }

        lastProgressFrame = progress.frames;
        const percent = ((progress.frames / frameCount) * 100).toFixed(2);
        const ms = progress.currentFps ? Math.floor((frameCount - progress.frames) / progress.currentFps) * 1000 : 0;
        const duration = ms ? Duration.fromMillis(ms).rescale().toHuman({ unitDisplay: 'narrow' }) : '';
        const outputText = output instanceof Writable ? 'stream' : output.split('/').pop();
        this.logger.debug(
          `Transcoding ${percent}% done${duration ? `, estimated ${duration} remaining` : ''} for output ${outputText}`,
        );
      });
    }

    return ffmpegCall;
  }

  private parseInt(value: string | number | undefined): number {
    return Number.parseInt(value as string) || 0;
  }

  private parseFloat(value: string | number | undefined): number {
    return Number.parseFloat(value as string) || 0;
  }

  private getDar(dar: string | undefined): number {
    if (dar) {
      const [darW, darH] = dar.split(':').map(Number);
      if (darW && darH) {
        return darW / darH;
      }
    }

    return 0;
  }
}
