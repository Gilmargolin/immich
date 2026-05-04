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
// lumLow=0, lumHigh=1 are the identity values for the luminance gate (gate is
// inactive). Set explicitly so the saved JSON round-trips cleanly through the
// UI, but absence in older saved data still defaults to the same identity.
const defaultLinearMask = (): LocalMask => ({
  kind: 'linear',
  ax: 0.5,
  ay: 0.2,
  bx: 0.5,
  by: 0.6,
  mid: 0.5,
  lumLow: 0,
  lumHigh: 1,
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
  lumLow: 0,
  lumHigh: 1,
  params: { ...defaultValues },
});

export class AdjustManager implements EditToolManager {
  values = $state<AdjustmentValues>({ ...defaultValues });
  masks = $state<LocalMask[]>([]);
  // null = editing globals; index = editing that mask's params via the slider panel.
  selectedMaskIndex = $state<number | null>(null);
  // Geometry edit: when set, that mask shows handles + red affected-area
  // overlay. Separate from selection so a user can adjust sliders for a
  // mask without the visual clutter, and only enter geometry edit on demand.
  editingMaskIndex = $state<number | null>(null);
  // When set, the next click-drag on the photo creates a mask of this kind
  // (Lightroom-style draw flow). null = drawing inactive.
  pendingMaskKind = $state<'linear' | 'radial' | null>(null);
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
    this.editingMaskIndex = null;
    this.pendingMaskKind = null;
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
    this.editingMaskIndex = null;
    this.pendingMaskKind = null;
  }

  setValue(key: keyof AdjustmentValues, value: number) {
    if (this.selectedMaskIndex !== null && this.masks[this.selectedMaskIndex]) {
      const idx = this.selectedMaskIndex;
      this.masks = this.masks.map((m, i) =>
        i === idx ? ({ ...m, params: { ...m.params, [key]: value } } as LocalMask) : m,
      );
      // Once the user starts adjusting sliders for a mask, hide the red
      // affected-area overlay — they've already seen where it applies and the
      // overlay just gets in the way of judging the result. Pencil button
      // re-enters geometry edit on demand.
      if (this.editingMaskIndex === idx) {
        this.editingMaskIndex = null;
      }
      return;
    }
    this.values = { ...this.values, [key]: value };
  }

  addLinearMask(): void {
    this.masks = [...this.masks, defaultLinearMask()];
    const idx = this.masks.length - 1;
    this.selectedMaskIndex = idx;
    this.editingMaskIndex = idx;
  }

  addRadialMask(): void {
    this.masks = [...this.masks, defaultRadialMask()];
    const idx = this.masks.length - 1;
    this.selectedMaskIndex = idx;
    this.editingMaskIndex = idx;
  }

  // Lightroom-style draw flow: arm draw mode and let the overlay component
  // listen for pointer events on the photo. The mask is materialized on
  // pointerup with the user-drawn geometry, not on this call.
  startDrawingMask(kind: 'linear' | 'radial'): void {
    if (this.masks.length >= 8) {
      return;
    }
    this.pendingMaskKind = kind;
  }

  cancelDrawingMask(): void {
    this.pendingMaskKind = null;
  }

  // Called by the overlay on pointerup with linear endpoints already in
  // normalized [0,1] image-W/H coordinates.
  commitDrawnLinearMask(ax: number, ay: number, bx: number, by: number): void {
    if (this.pendingMaskKind !== 'linear') {
      return;
    }
    const mask: LocalMask = {
      kind: 'linear',
      ax,
      ay,
      bx,
      by,
      mid: 0.5,
      lumLow: 0,
      lumHigh: 1,
      params: { ...defaultValues },
    };
    this.masks = [...this.masks, mask];
    const idx = this.masks.length - 1;
    this.selectedMaskIndex = idx;
    this.editingMaskIndex = idx;
    this.pendingMaskKind = null;
  }

  // Called by the overlay on pointerup. cx/cy in normalized image-W/H.
  // rx/ry already converted to the DTO's min(W, H)-relative units by the
  // overlay (which owns the aspect ratio knowledge).
  commitDrawnRadialMask(cx: number, cy: number, rx: number, ry: number): void {
    if (this.pendingMaskKind !== 'radial') {
      return;
    }
    const mask: LocalMask = {
      kind: 'radial',
      cx,
      cy,
      rx: Math.max(0.02, rx),
      ry: Math.max(0.02, ry),
      angle: 0,
      feather: 0.2,
      invert: false,
      lumLow: 0,
      lumHigh: 1,
      params: { ...defaultValues },
    };
    this.masks = [...this.masks, mask];
    const idx = this.masks.length - 1;
    this.selectedMaskIndex = idx;
    this.editingMaskIndex = idx;
    this.pendingMaskKind = null;
  }

  removeMask(index: number): void {
    this.masks = this.masks.filter((_, i) => i !== index);
    const fixIndex = (current: number | null) => {
      if (current === index) return null;
      if (current !== null && current > index) return current - 1;
      return current;
    };
    this.selectedMaskIndex = fixIndex(this.selectedMaskIndex);
    this.editingMaskIndex = fixIndex(this.editingMaskIndex);
  }

  updateMask(index: number, mask: LocalMask): void {
    this.masks = this.masks.map((m, i) => (i === index ? mask : m));
  }

  // Set the luminance gate for a mask, clamping to [0, 1] and enforcing
  // lumLow ≤ lumHigh so the server's class-validator never has to reject.
  setLumGate(index: number, lumLow: number, lumHigh: number): void {
    const lo = Math.min(1, Math.max(0, lumLow));
    const hi = Math.min(1, Math.max(0, lumHigh));
    const orderedLo = Math.min(lo, hi);
    const orderedHi = Math.max(lo, hi);
    this.masks = this.masks.map((m, i) =>
      i === index ? ({ ...m, lumLow: orderedLo, lumHigh: orderedHi } as LocalMask) : m,
    );
  }

  selectMask(index: number | null): void {
    if (index === null) {
      this.selectedMaskIndex = null;
      this.editingMaskIndex = null;
      return;
    }
    if (index < 0 || index >= this.masks.length) {
      return;
    }
    this.selectedMaskIndex = index;
  }

  toggleEditingMask(index: number): void {
    if (this.editingMaskIndex === index) {
      this.editingMaskIndex = null;
    } else {
      this.editingMaskIndex = index;
      this.selectedMaskIndex = index;
    }
  }
}

export const adjustManager = new AdjustManager();
