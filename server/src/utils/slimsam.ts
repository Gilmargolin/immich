// SAM-L (Segment Anything, ViT-Large) inference with int8-quantized weights.
// The encoder turns an image into two 256×64×64 embedding tensors; the
// decoder takes those plus point/box prompts and returns 256×256 mask
// logits.
//
// Models (in server/resources/):
//   - sam-vit-large-encoder-quantized.onnx (~310 MB, gitignored —
//     pulled from HF at Docker build time)
//   - sam-vit-large-decoder-quantized.onnx (~5 MB, committed)
// Both come from huggingface.co/Xenova/sam-vit-large.
//
// We previously used SlimSAM-77 (a heavily-distilled 77M-param variant),
// which was small + fast but subject identification was visibly weaker — it
// would often pick partial silhouettes or get confused by complex scenes.
// SAM-L is the 308M-param "large" variant; the int8-quantized export
// matches the fp32's quality within ~1-2% IoU while being ~4× smaller and
// ~2-4× faster on CPU.
//
// I/O shapes (verified via probe):
//   encoder.pixel_values:                [1, 3, 1024, 1024] float32
//   encoder.image_embeddings:            [1, 256, 64, 64]   float32
//   encoder.image_positional_embeddings: [1, 256, 64, 64]   float32
//   decoder.input_points:                [1, 1, N, 2]       float32 (1024-space x,y)
//   decoder.input_labels:                [1, 1, N]          int64  (2=tl-box, 3=br-box)
//   decoder.iou_scores:                  [1, 1, 3]          float32 (3 multimask candidates)
//   decoder.pred_masks:                  [1, 1, 3, 256, 256] float32 (logits)
//
// Preprocessing matches HF SamImageProcessor: resize longest edge to 1024,
// rescale to [0,1], normalize with ImageNet stats, pad bottom-right to
// 1024×1024 with zeros.

import * as ort from 'onnxruntime-node';
import path from 'node:path';
import sharp from 'sharp';

const ENCODER_PATH = path.resolve(__dirname, '../../resources/sam-vit-large-encoder-quantized.onnx');
const DECODER_PATH = path.resolve(__dirname, '../../resources/sam-vit-large-decoder-quantized.onnx');
const INPUT_SIZE = 1024;
// ImageNet normalization stats (the HF preprocessor's defaults).
const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];

let encoderSession: ort.InferenceSession | null = null;
let decoderSession: ort.InferenceSession | null = null;

const getEncoder = async (): Promise<ort.InferenceSession> => {
  if (!encoderSession) {
    encoderSession = await ort.InferenceSession.create(ENCODER_PATH, {
      executionProviders: ['cpu'],
      graphOptimizationLevel: 'all',
    });
  }
  return encoderSession;
};

const getDecoder = async (): Promise<ort.InferenceSession> => {
  if (!decoderSession) {
    decoderSession = await ort.InferenceSession.create(DECODER_PATH, {
      executionProviders: ['cpu'],
      graphOptimizationLevel: 'all',
    });
  }
  return decoderSession;
};

export interface EncodedImage {
  imageEmbeddings: ort.Tensor;
  imagePositionalEmbeddings: ort.Tensor;
  /** Scale factor applied during letterbox: 1024 / max(origW, origH). */
  scale: number;
  /** Original image dimensions, kept for downstream coord mapping. */
  origW: number;
  origH: number;
  /** Dimensions of the content (un-padded) region inside the 1024×1024 input. */
  contentW: number;
  contentH: number;
}

/**
 * Resize-pad-normalize an image and run it through the SlimSAM image encoder.
 * Embeddings are reusable: encode once per image, decode many times with
 * different prompts.
 */
export const encodeImage = async (imageBuffer: Buffer): Promise<EncodedImage> => {
  const meta = await sharp(imageBuffer).metadata();
  const origW = meta.width ?? 0;
  const origH = meta.height ?? 0;
  if (!origW || !origH) {
    throw new Error('SlimSAM encodeImage: image has no dimensions');
  }

  const scale = INPUT_SIZE / Math.max(origW, origH);
  const contentW = Math.round(origW * scale);
  const contentH = Math.round(origH * scale);

  // Resize content, then pad bottom-right with zeros (matches HF SAM preprocessor).
  const padded = await sharp(imageBuffer)
    .resize(contentW, contentH, { fit: 'fill' })
    .extend({
      top: 0,
      bottom: INPUT_SIZE - contentH,
      left: 0,
      right: INPUT_SIZE - contentW,
      background: { r: 0, g: 0, b: 0 },
    })
    .removeAlpha()
    .raw()
    .toBuffer();

  // HWC uint8 → CHW float32, ImageNet-normalized.
  const pixelCount = INPUT_SIZE * INPUT_SIZE;
  const tensor = new Float32Array(3 * pixelCount);
  for (let i = 0; i < pixelCount; i++) {
    tensor[i] = (padded[i * 3] / 255 - MEAN[0]) / STD[0];
    tensor[i + pixelCount] = (padded[i * 3 + 1] / 255 - MEAN[1]) / STD[1];
    tensor[i + 2 * pixelCount] = (padded[i * 3 + 2] / 255 - MEAN[2]) / STD[2];
  }

  const encoder = await getEncoder();
  const out = await encoder.run({
    pixel_values: new ort.Tensor('float32', tensor, [1, 3, INPUT_SIZE, INPUT_SIZE]),
  });

  return {
    imageEmbeddings: out.image_embeddings,
    imagePositionalEmbeddings: out.image_positional_embeddings,
    scale,
    origW,
    origH,
    contentW,
    contentH,
  };
};

export interface DecodedMask {
  /** Raw grayscale bytes (0 = background, 255 = foreground), row-major. */
  data: Uint8Array;
  /** Width of `data`. Bounded by SlimSAM's 1024-px content region. */
  width: number;
  /** Height of `data`. Bounded by SlimSAM's 1024-px content region. */
  height: number;
}

/**
 * Decode a binary silhouette given a bounding-box prompt in original-image
 * pixel coords. Returns the mask at SlimSAM's internal content resolution
 * (≤ 1024×1024, aspect-preserving — same aspect as the source image). The
 * caller is responsible for any final resize.
 *
 * We deliberately do NOT resize back to the original image resolution here:
 * (1) the caller usually wants a small thumbnail (e.g. 512×512 for brush
 *     masks), so a round-trip through tens-of-megapixels is wasteful;
 * (2) Sharp's chained extract→resize occasionally truncates the output
 *     buffer when targeting very large dimensions, which broke the v1 of
 *     this code with a "VipsImage memory area too small" error.
 */
export const decodeMaskWithBox = async (
  enc: EncodedImage,
  bbox: { x0: number; y0: number; x1: number; y1: number },
): Promise<DecodedMask> => {
  // Hybrid SAM prompt: the user's box corners (labels 2 = top-left,
  // 3 = bottom-right) PLUS a single positive centre point (label 1).
  //
  // The 5-positive-point grid we tried previously was leaking foreground
  // hints onto the background when the subject didn't fill the user's box
  // (a portrait with a door visible on one side had the quarter points
  // landing on the door → SAM segmented the door too).
  //
  // Box corners constrain SAM to look inside the box; the centre point
  // gives it an unambiguous foreground anchor. This is the standard SAM
  // "box + point" combined prompt; with SAM-L (vs the SlimSAM we used
  // before) it works very well on real photos.
  const cx = (bbox.x0 + bbox.x1) / 2;
  const cy = (bbox.y0 + bbox.y1) / 2;
  const promptPoints: [number, number, number][] = [
    [bbox.x0, bbox.y0, 2], // top-left of box
    [bbox.x1, bbox.y1, 3], // bottom-right of box
    [cx, cy, 1], // positive centre point — foreground anchor
  ];
  const points = new Float32Array(promptPoints.length * 2);
  const labels = new BigInt64Array(promptPoints.length);
  for (let i = 0; i < promptPoints.length; i++) {
    points[i * 2] = promptPoints[i][0] * enc.scale;
    points[i * 2 + 1] = promptPoints[i][1] * enc.scale;
    labels[i] = BigInt(promptPoints[i][2]);
  }

  const decoder = await getDecoder();
  const out = await decoder.run({
    image_embeddings: enc.imageEmbeddings,
    image_positional_embeddings: enc.imagePositionalEmbeddings,
    input_points: new ort.Tensor('float32', points, [1, 1, promptPoints.length, 2]),
    input_labels: new ort.Tensor('int64', labels, [1, 1, promptPoints.length]),
  });

  const masks = out.pred_masks.data as Float32Array;
  const maskSize = 256;

  // Pick the candidate with the highest predicted IoU — the convention
  // recommended by the model card and used by Transformers.js's reference
  // post-processing. For point prompts, the higher-IoU candidate is usually
  // the one that captures the whole intended object rather than a sub-part.
  const iouScores = out.iou_scores.data as Float32Array;
  let bestIdx = 0;
  for (let i = 1; i < 3; i++) {
    if (iouScores[i] > iouScores[bestIdx]) {
      bestIdx = i;
    }
  }

  const offset = bestIdx * maskSize * maskSize;
  const lowRes = Buffer.alloc(maskSize * maskSize);
  // Soft sigmoid → 0..255 grayscale. Anti-aliased boundary preserves SAM's
  // confidence falloff at edges (hair, fur, edges of clothing) instead of
  // punching holes where the model is medium-confident.
  for (let i = 0; i < maskSize * maskSize; i++) {
    const prob = 1 / (1 + Math.exp(-masks[offset + i]));
    lowRes[i] = Math.round(prob * 255);
  }

  // Upsample 256 → 1024 with smooth interpolation, then crop to the un-padded
  // content region. The content region is the source image's aspect at SAM's
  // 1024 scale; e.g. for a 3:2 horizontal photo it's roughly 1024 × 683.
  //
  // Sharp's default kernel (lanczos3) is what we want here — equivalent in
  // spirit to the bilinear interpolate_4d that Transformers.js's
  // `post_process_masks` uses. The v1 of this code passed `kernel: 'nearest'`
  // (preserving exact byte values), which left visible 256×256 block edges
  // in the final mask when stretched onto a multi-megapixel photo. The
  // sigmoid mask is already continuous-valued, so smooth resampling is the
  // right call.
  //
  // `.toColourspace('b-w')` is load-bearing: Sharp's `.extract()` after
  // `.resize()` silently promotes a 1-band raw input to 3-band RGB, which
  // makes `.raw().toBuffer()` emit 3× the expected bytes. Forcing the
  // libvips colourspace back to b/w (1 band) before raw output guarantees
  // exactly w*h bytes.
  const contentMask = await sharp(lowRes, { raw: { width: maskSize, height: maskSize, channels: 1 } })
    .resize(INPUT_SIZE, INPUT_SIZE, { fit: 'fill' })
    .extract({ left: 0, top: 0, width: enc.contentW, height: enc.contentH })
    .toColourspace('b-w')
    .raw()
    .toBuffer();

  // Defensive check: the buffer should match the requested content dims.
  // Without this, downstream resizers fail with cryptic "memory area too
  // small" errors when libvips silently does something unexpected.
  const expected = enc.contentW * enc.contentH;
  if (contentMask.byteLength !== expected) {
    throw new Error(
      `slimsam: decoded mask buffer size mismatch — got ${contentMask.byteLength}, expected ${expected} (${enc.contentW}×${enc.contentH})`,
    );
  }

  return {
    data: new Uint8Array(contentMask.buffer, contentMask.byteOffset, contentMask.byteLength),
    width: enc.contentW,
    height: enc.contentH,
  };
};
