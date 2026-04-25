import type { EditAction, EditActions, EditToolManager } from '$lib/managers/edit/edit-manager.svelte';
import type { LocalMask } from '$lib/managers/edit/adjust-webgl';
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

export type { LocalMask } from '$lib/managers/edit/adjust-webgl';

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

const slidersActive = (v: AdjustmentValues): boolean =>
  v.brightness !== 0 ||
  v.contrast !== 0 ||
  v.saturation !== 0 ||
  v.warmth !== 0 ||
  v.tint !== 0 ||
  v.highlights !== 0 ||
  v.shadows !== 0 ||
  v.whitePoint !== 0 ||
  v.blackPoint !== 0;

// Defaults for newly-added masks. Centered, ~30% of image dimensions, no
// adjustments yet — the user picks sliders after creation.
const defaultLinearMask = (): LocalMask => ({
  kind: 'linear',
  ax: 0.5,
  ay: 0.2,
  bx: 0.5,
  by: 0.6,
  params: { ...defaultValues },
});

const defaultRadialMask = (): LocalMask => ({
  kind: 'radial',
  cx: 0.5,
  cy: 0.5,
  rx: 0.25,
  ry: 0.25,
  angle: 0,
  feather: 0.2,
  invert: false,
  params: { ...defaultValues },
});

export class AdjustManager implements EditToolManager {
  values = $state<AdjustmentValues>({ ...defaultValues });
  masks = $state<LocalMask[]>([]);
  // null = editing globals; index = editing that mask's params via the slider panel.
  selectedMaskIndex = $state<number | null>(null);
  private initialValues = $state<AdjustmentValues>({ ...defaultValues });
  private initialMasks = $state<LocalMask[]>([]);

  // Sliders panel binding: when a mask is selected, the panel reads/writes
  // its params; otherwise it reads/writes the global values.
  activeSliders = $derived.by((): AdjustmentValues => {
    if (this.selectedMaskIndex !== null && this.masks[this.selectedMaskIndex]) {
      return this.masks[this.selectedMaskIndex].params;
    }
    return this.values;
  });

  hasChanges = $derived(
    this.values.brightness !== this.initialValues.brightness ||
      this.values.contrast !== this.initialValues.contrast ||
      this.values.saturation !== this.initialValues.saturation ||
      this.values.warmth !== this.initialValues.warmth ||
      this.values.tint !== this.initialValues.tint ||
      this.values.highlights !== this.initialValues.highlights ||
      this.values.shadows !== this.initialValues.shadows ||
      this.values.whitePoint !== this.initialValues.whitePoint ||
      this.values.blackPoint !== this.initialValues.blackPoint ||
      JSON.stringify(this.masks) !== JSON.stringify(this.initialMasks),
  );

  canReset = $derived(slidersActive(this.values) || this.masks.length > 0);

  edits = $derived.by((): EditAction[] => {
    if (!slidersActive(this.values) && this.masks.length === 0) {
      return [];
    }

    const parameters: AdjustmentValues & { masks?: LocalMask[] } = { ...this.values };
    if (this.masks.length > 0) {
      parameters.masks = [...this.masks];
    }

    return [{ action: 'adjust' as const, parameters }];
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
    this.selectedMaskIndex = null;
    const adjustEdit = edits.find((edit) => edit.action === 'adjust');
    if (adjustEdit) {
      const params = adjustEdit.parameters as AdjustmentValues & { masks?: LocalMask[] };
      const { masks, ...sliders } = params;
      this.values = { ...sliders };
      this.initialValues = { ...sliders };
      this.masks = masks ? [...masks] : [];
      this.initialMasks = masks ? [...masks] : [];
    } else {
      this.values = { ...defaultValues };
      this.initialValues = { ...defaultValues };
      this.masks = [];
      this.initialMasks = [];
    }
  }

  onDeactivate(): void {
    // no cleanup needed
  }

  async resetAllChanges(): Promise<void> {
    this.values = { ...defaultValues };
    this.initialValues = { ...defaultValues };
    this.masks = [];
    this.initialMasks = [];
    this.selectedMaskIndex = null;
  }

  setValue(key: keyof AdjustmentValues, value: number) {
    if (this.selectedMaskIndex !== null && this.masks[this.selectedMaskIndex]) {
      const idx = this.selectedMaskIndex;
      this.masks = this.masks.map((m, i) =>
        i === idx ? ({ ...m, params: { ...m.params, [key]: value } } as LocalMask) : m,
      );
      return;
    }
    this.values = { ...this.values, [key]: value };
  }

  addLinearMask(): void {
    this.masks = [...this.masks, defaultLinearMask()];
    this.selectedMaskIndex = this.masks.length - 1;
  }

  addRadialMask(): void {
    this.masks = [...this.masks, defaultRadialMask()];
    this.selectedMaskIndex = this.masks.length - 1;
  }

  removeMask(index: number): void {
    this.masks = this.masks.filter((_, i) => i !== index);
    if (this.selectedMaskIndex === index) {
      this.selectedMaskIndex = null;
    } else if (this.selectedMaskIndex !== null && this.selectedMaskIndex > index) {
      this.selectedMaskIndex -= 1;
    }
  }

  updateMask(index: number, mask: LocalMask): void {
    this.masks = this.masks.map((m, i) => (i === index ? mask : m));
  }

  selectMask(index: number | null): void {
    if (index === null) {
      this.selectedMaskIndex = null;
      return;
    }
    if (index < 0 || index >= this.masks.length) {
      return;
    }
    this.selectedMaskIndex = index;
  }
}

export const adjustManager = new AdjustManager();
