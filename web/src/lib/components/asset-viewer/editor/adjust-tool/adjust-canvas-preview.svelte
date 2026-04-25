<script lang="ts">
  import { adjustManager } from '$lib/managers/edit/adjust-manager.svelte';
  import { AdjustGLRenderer, FULL_CROP, type CropRect } from '$lib/managers/edit/adjust-webgl';
  import { onDestroy, onMount, type Snippet } from 'svelte';

  interface Props {
    src: string;
    onWebglUnavailable?: () => void;
    children?: Snippet;
  }

  let { src, onWebglUnavailable, children }: Props = $props();

  let canvas = $state<HTMLCanvasElement | null>(null);
  let renderer: AdjustGLRenderer | null = null;
  let imageLoaded = $state(false);
  // Aspect ratio of the *visible* (cropped) area — drives the wrapper sizing
  // so the SVG overlay lands exactly on the rendered photo.
  let aspectRatio = $state(1);

  let img = $state<HTMLImageElement | null>(null);

  // Crop is intentionally NOT applied to the live preview (was tried in
  // iter2 — caused the photo to "resize" when switching modes because crop
  // mode shows full image while shader-cropped adjust mode shows only the
  // kept region). Both modes now show the full preview at the same scale.
  // Crop is still applied server-side on save; mask coords are stored as
  // post-crop normalized (the DTO contract), which is correct in the no-crop
  // case (post-crop == full image) and acceptable for now in the cropped
  // case (mask placement may shift after save — to revisit).
  const cropRect: CropRect = FULL_CROP;

  $effect(() => {
    if (!canvas) {
      return;
    }
    if (renderer) {
      return;
    }
    try {
      renderer = new AdjustGLRenderer(canvas);
    } catch (error) {
      console.warn('WebGL preview unavailable, falling back to SVG filter', error);
      renderer = null;
      onWebglUnavailable?.();
    }
  });

  $effect(() => {
    const url = src;
    if (!url || !renderer) {
      return;
    }
    let cancelled = false;
    imageLoaded = false;
    const el = new Image();
    el.crossOrigin = 'anonymous';
    el.decoding = 'async';
    el.onload = () => {
      if (cancelled || !renderer) {
        return;
      }
      img = el;
      renderer.setImage(el);
      renderer.resizeCanvas(cropRect);
      aspectRatio = el.naturalWidth / Math.max(1, el.naturalHeight);
      imageLoaded = true;
      scheduleRender();
    };
    el.onerror = () => {
      if (!cancelled) {
        console.warn('Failed to load adjust preview image', url);
      }
    };
    el.src = url;
    return () => {
      cancelled = true;
    };
  });

  let pendingRaf: number | null = null;
  const scheduleRender = () => {
    if (pendingRaf !== null) {
      return;
    }
    pendingRaf = requestAnimationFrame(() => {
      pendingRaf = null;
      if (renderer && imageLoaded) {
        renderer.render(adjustManager.values, adjustManager.masks, cropRect);
      }
    });
  };

  $effect(() => {
    void adjustManager.values.brightness;
    void adjustManager.values.contrast;
    void adjustManager.values.saturation;
    void adjustManager.values.warmth;
    void adjustManager.values.tint;
    void adjustManager.values.highlights;
    void adjustManager.values.shadows;
    void adjustManager.values.whitePoint;
    void adjustManager.values.blackPoint;
    void adjustManager.masks;
    scheduleRender();
  });

  onMount(() => {
    // canvas is bound via {bind:this} below; the $effect handles init.
  });

  onDestroy(() => {
    if (pendingRaf !== null) {
      cancelAnimationFrame(pendingRaf);
      pendingRaf = null;
    }
    renderer?.dispose();
    renderer = null;
    img = null;
  });
</script>

<div class="relative flex h-full w-full items-center justify-center">
  <div
    class="relative"
    style="max-width: 100%; max-height: 100%; aspect-ratio: {aspectRatio}; width: 100%; height: 100%;"
  >
    <canvas
      bind:this={canvas}
      class="absolute inset-0 h-full w-full"
      aria-label="Adjust preview"
    ></canvas>
    {#if children}
      {@render children()}
    {/if}
  </div>
</div>
