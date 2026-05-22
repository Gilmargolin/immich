// SlimSAM (Segment Anything, pruned ~50 MB variant) inference. The encoder
// turns an image into two 256×64×64 embedding tensors; the decoder takes
// those plus a box prompt and returns 256×256 mask logits.
//
// Models (vendored in server/resources/):
//   - slimsam-vision-encoder.onnx (~22 MB)
//   - slimsam-decoder.onnx (~16 MB)
// Both come from huggingface.co/Xenova/slimsam-77-uniform.
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

const ENCODER_PATH = path.resolve(__dirname, '../../resources/slimsam-vision-encoder.onnx');
const DECODER_PATH = path.resolve(__dirname, '../../resources/slimsam-decoder.onnx');
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

/**
 * Decode a binary silhouette at the original image resolution given a
 * bounding-box prompt in original-image pixel coords.
 *
 * Returns a Uint8Array of length origW*origH, row-major, where each byte is
 * 0 (background) or 255 (foreground). Threshold is sigmoid(logit) > 0.5,
 * which matches what SAM is trained for.
 */
export const decodeMaskWithBox = async (
  enc: EncodedImage,
  bbox: { x0: number; y0: number; x1: number; y1: number },
): Promise<Uint8Array> => {
  // Box coords in original image space → 1024-space.
  const points = new Float32Array([
    bbox.x0 * enc.scale,
    bbox.y0 * enc.scale,
    bbox.x1 * enc.scale,
    bbox.y1 * enc.scale,
  ]);
  // Labels: 2 = top-left of box, 3 = bottom-right of box (SAM convention).
  const labels = new BigInt64Array([2n, 3n]);

  const decoder = await getDecoder();
  const out = await decoder.run({
    image_embeddings: enc.imageEmbeddings,
    image_positional_embeddings: enc.imagePositionalEmbeddings,
    input_points: new ort.Tensor('float32', points, [1, 1, 2, 2]),
    input_labels: new ort.Tensor('int64', labels, [1, 1, 2]),
  });

  // pred_masks: [1, 1, 3, 256, 256] logits — three multimask candidates.
  // iou_scores: [1, 1, 3] predicted quality. Pick the highest-quality candidate.
  const iouScores = out.iou_scores.data as Float32Array;
  let bestIdx = 0;
  for (let i = 1; i < 3; i++) {
    if (iouScores[i] > iouScores[bestIdx]) {
      bestIdx = i;
    }
  }

  const masks = out.pred_masks.data as Float32Array;
  const maskSize = 256;
  const offset = bestIdx * maskSize * maskSize;

  // Threshold logits to a binary 256×256 grayscale buffer. SAM is trained so
  // the decision boundary is at logit = 0 (equivalently sigmoid > 0.5).
  const lowRes = Buffer.alloc(maskSize * maskSize);
  for (let i = 0; i < maskSize * maskSize; i++) {
    lowRes[i] = masks[offset + i] > 0 ? 255 : 0;
  }

  // Upsample 256→1024, crop the un-padded content region (which is
  // (0,0)-(contentW, contentH) in the 1024 space), then resize to the
  // original image dimensions.
  const upsampled = await sharp(lowRes, { raw: { width: maskSize, height: maskSize, channels: 1 } })
    .resize(INPUT_SIZE, INPUT_SIZE, { fit: 'fill', kernel: 'nearest' })
    .extract({ left: 0, top: 0, width: enc.contentW, height: enc.contentH })
    .resize(enc.origW, enc.origH, { fit: 'fill' })
    .raw()
    .toBuffer();

  return new Uint8Array(upsampled.buffer, upsampled.byteOffset, upsampled.byteLength);
};
