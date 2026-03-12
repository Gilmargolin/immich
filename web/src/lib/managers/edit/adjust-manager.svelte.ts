import type { EditAction, EditActions, EditToolManager } from '$lib/managers/edit/edit-manager.svelte';
import type { AssetResponseDto } from '@immich/sdk';

export interface AdjustmentValues {
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

const defaultValues: AdjustmentValues = {
  brightness: 0,
  contrast: 0,
  saturation: 0,
  warmth: 0,
  tint: 0,
  highlights: 0,
  shadows: 0,
  whitePoint: 0,
  blackPoint: 0,
};

export class AdjustManager implements EditToolManager {
  values = $state<AdjustmentValues>({ ...defaultValues });
  private initialValues = $state<AdjustmentValues>({ ...defaultValues });

  hasChanges = $derived(
    this.values.brightness !== this.initialValues.brightness ||
      this.values.contrast !== this.initialValues.contrast ||
      this.values.saturation !== this.initialValues.saturation ||
      this.values.warmth !== this.initialValues.warmth ||
      this.values.tint !== this.initialValues.tint ||
      this.values.highlights !== this.initialValues.highlights ||
      this.values.shadows !== this.initialValues.shadows ||
      this.values.whitePoint !== this.initialValues.whitePoint ||
      this.values.blackPoint !== this.initialValues.blackPoint,
  );

  canReset = $derived(
    this.values.brightness !== 0 ||
      this.values.contrast !== 0 ||
      this.values.saturation !== 0 ||
      this.values.warmth !== 0 ||
      this.values.tint !== 0 ||
      this.values.highlights !== 0 ||
      this.values.shadows !== 0 ||
      this.values.whitePoint !== 0 ||
      this.values.blackPoint !== 0,
  );

  edits = $derived.by((): EditAction[] => {
    const hasAnyAdjustment =
      this.values.brightness !== 0 ||
      this.values.contrast !== 0 ||
      this.values.saturation !== 0 ||
      this.values.warmth !== 0 ||
      this.values.tint !== 0 ||
      this.values.highlights !== 0 ||
      this.values.shadows !== 0 ||
      this.values.whitePoint !== 0 ||
      this.values.blackPoint !== 0;

    if (!hasAnyAdjustment) {
      return [];
    }

    return [
      {
        action: 'adjust' as const,
        parameters: { ...this.values },
      },
    ];
  });

  /**
   * SVG filter attributes for real-time preview.
   * Uses feComponentTransfer for per-channel control (slope/intercept/gamma).
   */
  svgFilterParams = $derived.by(() => {
    // Start with identity: slope=1, intercept=0, gamma=1
    let slope = 1;
    let intercept = 0;
    let gamma = 1;

    // Brightness: offset all channels
    if (this.values.brightness !== 0) {
      intercept += this.values.brightness * 0.4;
    }

    // Contrast: scale around midpoint
    if (this.values.contrast !== 0) {
      const factor = 1 + this.values.contrast;
      slope *= factor;
      intercept = intercept * factor + 0.5 * (1 - factor);
    }

    // Highlights: adjust gamma (lower gamma = brighter highlights)
    if (this.values.highlights !== 0) {
      gamma *= 1 / (1 + this.values.highlights * 0.5);
    }

    // Shadows: lift dark areas via intercept
    if (this.values.shadows !== 0) {
      slope *= 1 - this.values.shadows * 0.15;
      intercept += this.values.shadows * 0.15;
    }

    // White point: scale max brightness
    if (this.values.whitePoint !== 0) {
      slope *= 1 + this.values.whitePoint * 0.5;
    }

    // Black point: raise the floor
    if (this.values.blackPoint !== 0) {
      intercept += this.values.blackPoint * 0.2;
    }

    // Per-channel offsets for warmth and tint
    let rSlope = slope, gSlope = slope, bSlope = slope;
    let rIntercept = intercept, gIntercept = intercept, bIntercept = intercept;

    // Warmth: shift red up, blue down
    if (this.values.warmth !== 0) {
      rIntercept += this.values.warmth * 0.15;
      gIntercept += this.values.warmth * 0.06;
      bIntercept -= this.values.warmth * 0.15;
    }

    // Tint: shift green vs magenta
    if (this.values.tint !== 0) {
      rIntercept -= this.values.tint * 0.08;
      gIntercept += this.values.tint * 0.15;
      bIntercept -= this.values.tint * 0.08;
    }

    return {
      r: { slope: rSlope, intercept: rIntercept, gamma },
      g: { slope: gSlope, intercept: gIntercept, gamma },
      b: { slope: bSlope, intercept: bIntercept, gamma },
      saturation: this.values.saturation,
    };
  });

  async onActivate(_asset: AssetResponseDto, edits: EditActions): Promise<void> {
    const adjustEdit = edits.find((edit) => edit.action === 'adjust');
    if (adjustEdit) {
      const params = adjustEdit.parameters as AdjustmentValues;
      this.values = { ...params };
      this.initialValues = { ...params };
    } else {
      this.values = { ...defaultValues };
      this.initialValues = { ...defaultValues };
    }
  }

  onDeactivate(): void {
    // no cleanup needed
  }

  async resetAllChanges(): Promise<void> {
    this.values = { ...defaultValues };
    this.initialValues = { ...defaultValues };
  }

  setValue(key: keyof AdjustmentValues, value: number) {
    this.values = { ...this.values, [key]: value };
  }
}

export const adjustManager = new AdjustManager();
