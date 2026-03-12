import { AdjustManager } from '$lib/managers/edit/adjust-manager.svelte';

describe('AdjustManager', () => {
  let sut: AdjustManager;

  beforeEach(() => {
    sut = new AdjustManager();
  });

  describe('initial state', () => {
    it('should have all values set to zero', () => {
      expect(sut.values).toEqual({
        brightness: 0,
        contrast: 0,
        saturation: 0,
        warmth: 0,
        tint: 0,
        highlights: 0,
        shadows: 0,
        whitePoint: 0,
        blackPoint: 0,
      });
    });

    it('should have no changes', () => {
      expect(sut.hasChanges).toBe(false);
    });

    it('should not be resettable', () => {
      expect(sut.canReset).toBe(false);
    });

    it('should produce no edits', () => {
      expect(sut.edits).toEqual([]);
    });
  });

  describe('setValue', () => {
    it('should update a single value', () => {
      sut.setValue('brightness', 0.5);
      expect(sut.values.brightness).toBe(0.5);
    });

    it('should preserve other values when setting one', () => {
      sut.setValue('brightness', 0.5);
      sut.setValue('contrast', -0.3);
      expect(sut.values.brightness).toBe(0.5);
      expect(sut.values.contrast).toBe(-0.3);
      expect(sut.values.saturation).toBe(0);
    });
  });

  describe('hasChanges', () => {
    it('should be true when a value differs from initial', () => {
      sut.setValue('brightness', 0.1);
      expect(sut.hasChanges).toBe(true);
    });

    it('should be false when value is set back to initial', () => {
      sut.setValue('brightness', 0.5);
      sut.setValue('brightness', 0);
      expect(sut.hasChanges).toBe(false);
    });
  });

  describe('canReset', () => {
    it('should be true when any value is non-zero', () => {
      sut.setValue('shadows', 0.2);
      expect(sut.canReset).toBe(true);
    });

    it('should be false when all values are zero', () => {
      expect(sut.canReset).toBe(false);
    });
  });

  describe('edits', () => {
    it('should return empty array when no adjustments', () => {
      expect(sut.edits).toEqual([]);
    });

    it('should return adjust action with all parameters', () => {
      sut.setValue('brightness', 0.5);
      sut.setValue('contrast', -0.2);
      const edits = sut.edits;
      expect(edits).toHaveLength(1);
      expect(edits[0]).toEqual({
        action: 'adjust',
        parameters: {
          brightness: 0.5,
          contrast: -0.2,
          saturation: 0,
          warmth: 0,
          tint: 0,
          highlights: 0,
          shadows: 0,
          whitePoint: 0,
          blackPoint: 0,
        },
      });
    });
  });

  describe('onActivate', () => {
    it('should load existing adjust edit', async () => {
      await sut.onActivate({} as any, [
        {
          action: 'adjust' as const,
          parameters: {
            brightness: 0.3,
            contrast: 0.1,
            saturation: 0,
            warmth: 0,
            tint: 0,
            highlights: -0.2,
            shadows: 0,
            whitePoint: 0,
            blackPoint: 0,
          },
        },
      ]);

      expect(sut.values.brightness).toBe(0.3);
      expect(sut.values.contrast).toBe(0.1);
      expect(sut.values.highlights).toBe(-0.2);
      expect(sut.hasChanges).toBe(false);
    });

    it('should use defaults when no adjust edit exists', async () => {
      await sut.onActivate({} as any, []);

      expect(sut.values.brightness).toBe(0);
      expect(sut.hasChanges).toBe(false);
    });
  });

  describe('resetAllChanges', () => {
    it('should reset all values to zero', async () => {
      sut.setValue('brightness', 0.8);
      sut.setValue('contrast', -0.5);
      sut.setValue('saturation', 0.3);

      await sut.resetAllChanges();

      expect(sut.values).toEqual({
        brightness: 0,
        contrast: 0,
        saturation: 0,
        warmth: 0,
        tint: 0,
        highlights: 0,
        shadows: 0,
        whitePoint: 0,
        blackPoint: 0,
      });
      expect(sut.canReset).toBe(false);
    });
  });

  describe('svgFilterParams', () => {
    it('should return identity params when all values are zero', () => {
      const params = sut.svgFilterParams;
      expect(params.r.slope).toBe(1);
      expect(params.r.intercept).toBe(0);
      expect(params.r.gamma).toBe(1);
      expect(params.g.slope).toBe(1);
      expect(params.g.intercept).toBe(0);
      expect(params.b.slope).toBe(1);
      expect(params.b.intercept).toBe(0);
    });

    it('should adjust intercept for brightness', () => {
      sut.setValue('brightness', 0.5);
      const params = sut.svgFilterParams;
      expect(params.r.intercept).toBeGreaterThan(0);
      expect(params.g.intercept).toBeGreaterThan(0);
      expect(params.b.intercept).toBeGreaterThan(0);
    });

    it('should adjust slope for contrast', () => {
      sut.setValue('contrast', 0.5);
      const params = sut.svgFilterParams;
      expect(params.r.slope).toBeGreaterThan(1);
    });

    it('should adjust gamma for highlights', () => {
      sut.setValue('highlights', 0.5);
      const params = sut.svgFilterParams;
      expect(params.r.gamma).toBeLessThan(1);
    });

    it('should create per-channel offset for warmth', () => {
      sut.setValue('warmth', 0.5);
      const params = sut.svgFilterParams;
      expect(params.r.intercept).toBeGreaterThan(0);
      expect(params.b.intercept).toBeLessThan(0);
    });

    it('should create per-channel offset for tint', () => {
      sut.setValue('tint', 0.5);
      const params = sut.svgFilterParams;
      expect(params.g.intercept).toBeGreaterThan(0);
      expect(params.r.intercept).toBeLessThan(0);
    });
  });
});
