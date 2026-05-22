// Subject-detection orchestrator. Wires together YOLOv11n-seg (instance
// detection) + SlimSAM (pixel-perfect silhouettes) to produce brush-mask-
// ready PNGs for each detected subject + a "background" mask that is the
// complement of every detected subject.
//
// Output format matches what `BrushMask.mask` accepts in editing.dto.ts:
// a `data:image/png;base64,...` URL of a 512×512 grayscale PNG.

import { promises as fs } from 'node:fs';
import sharp from 'sharp';
import { decodeMaskWithBox, encodeImage } from 'src/utils/slimsam';
import { detectInstances } from 'src/utils/yolo-seg';

const TARGET_SIZE = 512; // matches BRUSH_MASK_RESOLUTION in editing.dto.ts
const MAX_SUBJECTS = 5;
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

    // SAM mask at original image resolution (binary 0/255 bytes).
    const fullRes = await decodeMaskWithBox(enc, detection.bbox);

    // Resize to 512×512 with "fill" (stretches aspect) — brush masks are sampled
    // in normalized UV across the whole image, so the storage format is always
    // a square stretched to fit.
    const mask512Buf = await sharp(Buffer.from(fullRes), {
      raw: { width: originalSize.w, height: originalSize.h, channels: 1 },
    })
      .resize(TARGET_SIZE, TARGET_SIZE, { fit: 'fill' })
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
