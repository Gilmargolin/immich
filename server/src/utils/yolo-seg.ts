// YOLOv11n-seg instance detection. We use this purely for bounding boxes +
// class labels — the silhouette refinement is done by SlimSAM (see
// `slimsam.ts`), so the mask-coefficient + prototype outputs are ignored.
//
// Model: yolo11n-seg.onnx from Ultralytics (~10 MB). Letterbox 640×640 input,
// output[0] shape [1, 116, 8400] where 116 = 4 (xywh) + 80 (class scores) + 32
// (mask coefficients, unused here), 8400 = anchor count.

import * as ort from 'onnxruntime-node';
import path from 'node:path';
import sharp from 'sharp';

const MODEL_PATH = path.resolve(__dirname, '../../resources/yolo11n-seg.onnx');
const INPUT_SIZE = 640;
const NUM_CLASSES = 80;

// Standard COCO 80-class label list. Index matches the model's class output.
export const COCO_CLASS_NAMES: readonly string[] = [
  'person', 'bicycle', 'car', 'motorcycle', 'airplane', 'bus', 'train', 'truck', 'boat',
  'traffic light', 'fire hydrant', 'stop sign', 'parking meter', 'bench',
  'bird', 'cat', 'dog', 'horse', 'sheep', 'cow', 'elephant', 'bear', 'zebra', 'giraffe',
  'backpack', 'umbrella', 'handbag', 'tie', 'suitcase',
  'frisbee', 'skis', 'snowboard', 'sports ball', 'kite', 'baseball bat', 'baseball glove',
  'skateboard', 'surfboard', 'tennis racket',
  'bottle', 'wine glass', 'cup', 'fork', 'knife', 'spoon', 'bowl',
  'banana', 'apple', 'sandwich', 'orange', 'broccoli', 'carrot', 'hot dog', 'pizza', 'donut', 'cake',
  'chair', 'couch', 'potted plant', 'bed', 'dining table', 'toilet',
  'tv', 'laptop', 'mouse', 'remote', 'keyboard', 'cell phone',
  'microwave', 'oven', 'toaster', 'sink', 'refrigerator',
  'book', 'clock', 'vase', 'scissors', 'teddy bear', 'hair drier', 'toothbrush',
];

// Classes considered "subjects" for masking purposes: living things + vehicles.
// Excludes furniture, food, indoor objects — they're rarely the subject of a
// photo and YOLO over-detects them in busy scenes.
export const SUBJECT_CLASS_IDS = new Set<number>([
  0, // person
  1, 2, 3, 4, 5, 6, 7, 8, // vehicles
  14, 15, 16, 17, 18, 19, 20, 21, 22, 23, // animals
]);

export interface YoloDetection {
  classId: number;
  className: string;
  confidence: number;
  /** Bounding box in ORIGINAL image pixel coordinates (not letterbox-640). */
  bbox: { x0: number; y0: number; x1: number; y1: number };
}

let session: ort.InferenceSession | null = null;
const getSession = async (): Promise<ort.InferenceSession> => {
  if (!session) {
    session = await ort.InferenceSession.create(MODEL_PATH, {
      executionProviders: ['cpu'],
      graphOptimizationLevel: 'all',
    });
  }
  return session;
};

// Letterbox the image to INPUT_SIZE×INPUT_SIZE, return the CHW float32 tensor
// plus the scale + pad offsets so we can reverse-map detected boxes back to
// original image space.
const preprocess = async (
  imageBuffer: Buffer,
): Promise<{ tensor: Float32Array; origW: number; origH: number; scale: number; padX: number; padY: number }> => {
  const meta = await sharp(imageBuffer).metadata();
  const origW = meta.width ?? 0;
  const origH = meta.height ?? 0;
  if (!origW || !origH) {
    throw new Error('YOLO preprocess: image has no dimensions');
  }

  const scale = INPUT_SIZE / Math.max(origW, origH);
  const newW = Math.round(origW * scale);
  const newH = Math.round(origH * scale);
  const padX = Math.floor((INPUT_SIZE - newW) / 2);
  const padY = Math.floor((INPUT_SIZE - newH) / 2);

  const padded = await sharp(imageBuffer)
    .resize(newW, newH, { fit: 'fill' })
    .extend({
      top: padY,
      bottom: INPUT_SIZE - newH - padY,
      left: padX,
      right: INPUT_SIZE - newW - padX,
      background: { r: 114, g: 114, b: 114 },
    })
    .removeAlpha()
    .raw()
    .toBuffer();

  // HWC uint8 → CHW float32 in [0, 1].
  const pixelCount = INPUT_SIZE * INPUT_SIZE;
  const tensor = new Float32Array(3 * pixelCount);
  for (let i = 0; i < pixelCount; i++) {
    tensor[i] = padded[i * 3] / 255;
    tensor[i + pixelCount] = padded[i * 3 + 1] / 255;
    tensor[i + 2 * pixelCount] = padded[i * 3 + 2] / 255;
  }

  return { tensor, origW, origH, scale, padX, padY };
};

type Box = YoloDetection['bbox'];
const iou = (a: Box, b: Box): number => {
  const ix0 = Math.max(a.x0, b.x0);
  const iy0 = Math.max(a.y0, b.y0);
  const ix1 = Math.min(a.x1, b.x1);
  const iy1 = Math.min(a.y1, b.y1);
  if (ix1 <= ix0 || iy1 <= iy0) {
    return 0;
  }
  const inter = (ix1 - ix0) * (iy1 - iy0);
  const aArea = (a.x1 - a.x0) * (a.y1 - a.y0);
  const bArea = (b.x1 - b.x0) * (b.y1 - b.y0);
  return inter / (aArea + bArea - inter);
};

export const detectInstances = async (
  imageBuffer: Buffer,
  opts: { confThreshold?: number; iouThreshold?: number; subjectsOnly?: boolean } = {},
): Promise<{ detections: YoloDetection[]; originalSize: { w: number; h: number } }> => {
  const confThreshold = opts.confThreshold ?? 0.4;
  const iouThreshold = opts.iouThreshold ?? 0.5;
  const subjectsOnly = opts.subjectsOnly ?? true;

  const { tensor, origW, origH, scale, padX, padY } = await preprocess(imageBuffer);
  const sess = await getSession();
  const inputName = sess.inputNames[0];
  const out = await sess.run({
    [inputName]: new ort.Tensor('float32', tensor, [1, 3, INPUT_SIZE, INPUT_SIZE]),
  });

  const pred = out[sess.outputNames[0]];
  const data = pred.data as Float32Array;
  const dims = pred.dims as readonly number[];
  // Expected: [1, 4 + NUM_CLASSES + maskCoeffs, NUM_ANCHORS]
  const NUM_ANCHORS = dims[2];

  const raw: YoloDetection[] = [];
  for (let a = 0; a < NUM_ANCHORS; a++) {
    // Find best class for this anchor.
    let bestClass = -1;
    let bestScore = 0;
    for (let c = 0; c < NUM_CLASSES; c++) {
      const s = data[(4 + c) * NUM_ANCHORS + a];
      if (s > bestScore) {
        bestScore = s;
        bestClass = c;
      }
    }
    if (bestScore < confThreshold) {
      continue;
    }
    if (subjectsOnly && !SUBJECT_CLASS_IDS.has(bestClass)) {
      continue;
    }

    // Bbox is (cx, cy, w, h) in letterbox-640 pixel space.
    const cx = data[0 * NUM_ANCHORS + a];
    const cy = data[1 * NUM_ANCHORS + a];
    const w = data[2 * NUM_ANCHORS + a];
    const h = data[3 * NUM_ANCHORS + a];

    // Reverse letterbox to original image coords.
    const x0 = Math.max(0, (cx - w / 2 - padX) / scale);
    const y0 = Math.max(0, (cy - h / 2 - padY) / scale);
    const x1 = Math.min(origW, (cx + w / 2 - padX) / scale);
    const y1 = Math.min(origH, (cy + h / 2 - padY) / scale);
    if (x1 <= x0 || y1 <= y0) {
      continue;
    }

    raw.push({
      classId: bestClass,
      className: COCO_CLASS_NAMES[bestClass] ?? `class_${bestClass}`,
      confidence: bestScore,
      bbox: { x0, y0, x1, y1 },
    });
  }

  // Per-class NMS.
  raw.sort((a, b) => b.confidence - a.confidence);
  const kept: YoloDetection[] = [];
  for (const det of raw) {
    let suppress = false;
    for (const k of kept) {
      if (k.classId === det.classId && iou(k.bbox, det.bbox) > iouThreshold) {
        suppress = true;
        break;
      }
    }
    if (!suppress) {
      kept.push(det);
    }
  }

  return { detections: kept, originalSize: { w: origW, h: origH } };
};
