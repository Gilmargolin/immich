// Subject-detection orchestrator. Wires together YOLOv11n-seg (instance
// detection) + SlimSAM (pixel-perfect silhouettes) to produce brush-mask-
// ready PNGs for each detected subject + a "background" mask that is the
// complement of every detected subject.
//
// Output format matches what `BrushMask.mask` accepts in editing.dto.ts:
// a `data:image/png;base64,...` URL of a 512×512 grayscale PNG.

import { promises as fs } from 'node:fs';
import sharp from 'sharp';
import { decodeMaskWithBox, encodeImage, type EncodedImage } from 'src/utils/slimsam';
import { detectInstances } from 'src/utils/yolo-seg';

const TARGET_SIZE = 512; // matches BRUSH_MASK_RESOLUTION in editing.dto.ts
// Return up to 8 candidates so the web client's Sensitivity slider has range
// to filter from (without paying for a server re-run on slider drags).
const MAX_SUBJECTS = 8;
const SECONDARY_RELATIVE_THRESHOLD = 0.3; // secondary if score ≥ 30% of main's

export type SubjectRole = 'main' | 'secondary' | 'other';

export interface DetectedSubject {
  /** Stable per-photo id (`subject-0`, `subject-1`, …). Used by the client
   *  as a key for the result list; not persisted anywhere. */
  id: string;
  /** COCO class name (e.g. "person", "dog", "car"). */
  className: string;
  role: SubjectRole;
  confidence: number;
  /** 512×512 grayscale PNG as `data:image/png;base64,...`. */
  maskDataUrl: string;
}

export interface SubjectDetectionResult {
  subjects: DetectedSubject[];
  /** "Everything except every detected subject" as a brush-mask data URL.
   *  When `subjects` is empty, this is a fully-white mask (the whole image). */
  backgroundMaskDataUrl: string;
}

const grayscaleToPngDataUrl = async (buffer: Buffer, w: number, h: number): Promise<string> => {
  const png = await sharp(buffer, { raw: { width: w, height: h, channels: 1 } }).png().toBuffer();
  return `data:image/png;base64,${png.toString('base64')}`;
};

// Tiny LRU cache of SlimSAM image embeddings keyed by asset path + mtime.
// Encoding is the expensive part (~700 ms CPU); a single user box-drawing
// session typically generates several segment calls on the same image, so
// caching the embeddings makes the 2nd+ box near-instant. Capped at 4 entries
// so a busy editor session doesn't blow up resident memory (~50 MB per
// cached encoding).
type CacheEntry = { key: string; enc: EncodedImage };
const ENC_CACHE_LIMIT = 4;
const encCache: CacheEntry[] = [];

const getOrEncode = async (imagePath: string): Promise<EncodedImage> => {
  const stat = await fs.stat(imagePath);
  const key = `${imagePath}@${stat.mtimeMs}`;
  const hit = encCache.find((c) => c.key === key);
  if (hit) {
    // LRU bump.
    encCache.splice(encCache.indexOf(hit), 1);
    encCache.push(hit);
    return hit.enc;
  }
  const imageBuffer = await fs.readFile(imagePath);
  const enc = await encodeImage(imageBuffer);
  encCache.push({ key, enc });
  while (encCache.length > ENC_CACHE_LIMIT) {
    encCache.shift();
  }
  return enc;
};

// Resize a single-band mask buffer to 512×512 grayscale PNG and return as a
// data URL — same format as detectSubjects so it drops into BrushMask.mask.
const maskToBrushDataUrl = async (data: Uint8Array, width: number, height: number): Promise<string> => {
  const resized = await sharp(Buffer.from(data), {
    raw: { width, height, channels: 1 },
  })
    .resize(TARGET_SIZE, TARGET_SIZE, { fit: 'fill' })
    .toColourspace('b-w')
    .raw()
    .toBuffer();
  const png = await sharp(resized, { raw: { width: TARGET_SIZE, height: TARGET_SIZE, channels: 1 } }).png().toBuffer();
  return `data:image/png;base64,${png.toString('base64')}`;
};

/**
 * Interactive segmentation: take a user-drawn bounding box on the photo and
 * return the SAM silhouette of whatever's inside that box. Unlike
 * detectSubjects this does NOT run YOLO — the user's box IS the subject
 * prompt, so there's no class-filter or salience ranking step.
 *
 * `box` is in NORMALIZED image coords (each component in [0, 1] relative to
 * original image dimensions). The web client computes this from the user's
 * pointer drag on the photo.
 */
export const segmentFromBox = async (
  imagePath: string,
  box: { x0: number; y0: number; x1: number; y1: number },
): Promise<{ maskDataUrl: string }> => {
  const enc = await getOrEncode(imagePath);

  // Convert normalized box to original-image pixel coords (SlimSAM's
  // decodeMaskWithBox expects pixels, then internally rescales to its
  // 1024-input space).
  const x0 = Math.max(0, box.x0 * enc.origW);
  const y0 = Math.max(0, box.y0 * enc.origH);
  const x1 = Math.min(enc.origW, box.x1 * enc.origW);
  const y1 = Math.min(enc.origH, box.y1 * enc.origH);
  if (x1 - x0 < 1 || y1 - y0 < 1) {
    throw new Error('Box is degenerate (zero width or height)');
  }

  const decoded = await decodeMaskWithBox(enc, { x0, y0, x1, y1 });
  const maskDataUrl = await maskToBrushDataUrl(decoded.data, decoded.width, decoded.height);
  return { maskDataUrl };
};

export const detectSubjects = async (imagePath: string): Promise<SubjectDetectionResult> => {
  const imageBuffer = await fs.readFile(imagePath);

  const { detections, originalSize } = await detectInstances(imageBuffer, { subjectsOnly: true });

  // No subjects detected → background is the entire image.
  if (detections.length === 0) {
    const allOn = Buffer.alloc(TARGET_SIZE * TARGET_SIZE, 255);
    return {
      subjects: [],
      backgroundMaskDataUrl: await grayscaleToPngDataUrl(allOn, TARGET_SIZE, TARGET_SIZE),
    };
  }

  // Rank by area × centeredness so the user's focus point is preferred over a
  // huge background object (e.g. a bus filling the back of a portrait).
  const cx = originalSize.w / 2;
  const cy = originalSize.h / 2;
  const halfDiag = Math.hypot(cx, cy);
  const scored = detections.map((d) => {
    const bCx = (d.bbox.x0 + d.bbox.x1) / 2;
    const bCy = (d.bbox.y0 + d.bbox.y1) / 2;
    const distFromCenter = Math.hypot(bCx - cx, bCy - cy);
    const centeredness = Math.max(0, 1 - distFromCenter / halfDiag);
    const area = (d.bbox.x1 - d.bbox.x0) * (d.bbox.y1 - d.bbox.y0);
    const score = area * (0.5 + 0.5 * centeredness);
    return { detection: d, score };
  });
  scored.sort((a, b) => b.score - a.score);
  const ranked = scored.slice(0, MAX_SUBJECTS);

  // SAM image embeddings are reusable across decoder calls — encode once, then
  // run the decoder per box.
  const enc = await encodeImage(imageBuffer);

  const subjects: DetectedSubject[] = [];
  // Accumulator for the "background = complement of union" mask. Kept at the
  // 512×512 target resolution to avoid hauling around full-res buffers for
  // each subject (a 24-MP photo would be ~24 MB per mask).
  const unionAt512 = Buffer.alloc(TARGET_SIZE * TARGET_SIZE, 0);

  for (let i = 0; i < ranked.length; i++) {
    const { detection, score } = ranked[i];
    const role: SubjectRole =
      i === 0
        ? 'main'
        : i === 1 && score >= SECONDARY_RELATIVE_THRESHOLD * ranked[0].score
          ? 'secondary'
          : 'other';

    // SAM mask at SlimSAM's content resolution (≤ 1024 px, aspect-preserving).
    // Same aspect as the source image, so resizing straight to 512×512 with
    // "fill" gives a brush-mask-compatible square stretched to fit. The
    // `.toColourspace('b-w')` is required: without it Sharp's resize emits
    // 3-band RGB even though the input was 1-band (same issue as in
    // slimsam.ts; see decodeMaskWithBox comments).
    const decoded = await decodeMaskWithBox(enc, detection.bbox);
    const mask512Buf = await sharp(Buffer.from(decoded.data), {
      raw: { width: decoded.width, height: decoded.height, channels: 1 },
    })
      .resize(TARGET_SIZE, TARGET_SIZE, { fit: 'fill' })
      .toColourspace('b-w')
      .raw()
      .toBuffer();

    // Union with the running accumulator (OR over a 128 threshold).
    for (let j = 0; j < TARGET_SIZE * TARGET_SIZE; j++) {
      if (mask512Buf[j] > 128) {
        unionAt512[j] = 255;
      }
    }

    subjects.push({
      id: `subject-${i}`,
      className: detection.className,
      role,
      confidence: detection.confidence,
      maskDataUrl: await grayscaleToPngDataUrl(mask512Buf, TARGET_SIZE, TARGET_SIZE),
    });
  }

  // Background = complement of union.
  const bgBuf = Buffer.alloc(TARGET_SIZE * TARGET_SIZE);
  for (let j = 0; j < TARGET_SIZE * TARGET_SIZE; j++) {
    bgBuf[j] = unionAt512[j] === 0 ? 255 : 0;
  }

  return {
    subjects,
    backgroundMaskDataUrl: await grayscaleToPngDataUrl(bgBuf, TARGET_SIZE, TARGET_SIZE),
  };
};
