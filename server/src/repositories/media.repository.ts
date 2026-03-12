import { Injectable } from '@nestjs/common';
import { ExifDateTime, exiftool, WriteTags } from 'exiftool-vendored';
import ffmpeg, { FfprobeData } from 'fluent-ffmpeg';
import { Duration } from 'luxon';
import fs from 'node:fs/promises';
import { Writable } from 'node:stream';
import sharp from 'sharp';
import { ORIENTATION_TO_SHARP_ROTATION } from 'src/constants';
import { Exif } from 'src/database';
import { AssetEditActionItem } from 'src/dtos/editing.dto';
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
    if (adjustEdit) {
      const params = adjustEdit.parameters;
      const modulate: { brightness?: number; saturation?: number; hue?: number } = {};

      // Brightness: Sharp modulate uses multiplier (1 = unchanged, >1 brighter, <1 darker)
      if (params.brightness !== 0) {
        modulate.brightness = 1 + params.brightness;
      }

      // Saturation: Sharp modulate uses multiplier (1 = unchanged, >1 more saturated, 0 = greyscale)
      if (params.saturation !== 0) {
        modulate.saturation = 1 + params.saturation;
      }

      // Warmth: shift hue slightly (positive = warmer/yellow, negative = cooler/blue)
      if (params.warmth !== 0) {
        modulate.hue = Math.round(params.warmth * 30);
      }

      if (Object.keys(modulate).length > 0) {
        pipeline = pipeline.modulate(modulate);
      }

      // Contrast: use linear transform (a * pixel + b)
      if (params.contrast !== 0) {
        const factor = 1 + params.contrast;
        const offset = 128 * (1 - factor);
        pipeline = pipeline.linear(factor, offset);
      }

      // Tint: apply a subtle color tint via tint()
      if (params.tint !== 0) {
        const tintValue = params.tint;
        // Positive = green tint, negative = magenta tint
        const r = tintValue < 0 ? 255 : Math.round(255 - tintValue * 40);
        const g = tintValue > 0 ? 255 : Math.round(255 + tintValue * 40);
        const b = tintValue < 0 ? 255 : Math.round(255 - tintValue * 40);
        pipeline = pipeline.tint({ r, g, b });
      }

      // Highlights: brighten/darken light areas
      if (params.highlights !== 0) {
        if (params.highlights > 0) {
          // Brighten highlights: use output-only gamma (input gamma=1.0, output gamma>1)
          const gammaOut = 1 + params.highlights * 1.5;
          pipeline = pipeline.gamma(1.0, Math.min(3.0, gammaOut));
        } else {
          // Darken highlights: reduce slope
          const factor = 1 + params.highlights * 0.4;
          pipeline = pipeline.linear(factor, 0);
        }
      }

      // Shadows: lift dark areas using linear offset
      if (params.shadows !== 0) {
        pipeline = pipeline.linear(1 - params.shadows * 0.15, params.shadows * 40);
      }

      // White point: scale maximum brightness
      if (params.whitePoint !== 0) {
        const scale = 1 + params.whitePoint * 0.5;
        pipeline = pipeline.linear(scale, 0);
      }

      // Black point: raise the floor of dark pixels
      if (params.blackPoint !== 0) {
        pipeline = pipeline.linear(1, params.blackPoint * 50);
      }
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
