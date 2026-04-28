<script lang="ts">
  import { adjustManager } from '$lib/managers/edit/adjust-manager.svelte';
  import { editManager } from '$lib/managers/edit/edit-manager.svelte';
  import { AdjustGLRenderer, FULL_CROP, type CropRect } from '$lib/managers/edit/adjust-webgl';
  import { onDestroy, onMount, type Snippet } from 'svelte';

  interface Props {
    src: string;
    compareSrc?: string;
    onWebglUnavailable?: () => void;
    children?: Snippet;
  }

  let { src, compareSrc, onWebglUnavailable, children }: Props = $props();

  let canvas = $state<HTMLCanvasElement | null>(null);
  let renderer: AdjustGLRenderer | null = null;
  let imageLoaded = $state(false);
  // Aspect ratio of the *visible* (cropped) area — drives the wrapper sizing
  // so the SVG overlay lands exactly on the rendered photo.
  let aspectRatio = $state(1);

  // Pure-CSS aspect-ratio with both `width: 100%` and `height: 100%` is
  // overridden (aspect-ratio is ignored when both dims are explicit), and
  // dropping one collapses the box to zero. JS-driven sizing is reliable:
  // measure the outer flex area, fit the wrapper to whichever dim binds
  // first while preserving aspect.
  let outerEl = $state<HTMLDivElement | null>(null);
  let outerWidth = $state(0);
  let outerHeight = $state(0);

  let img = $state<HTMLImageElement | null>(null);

  let fittedWidth = $derived.by(() => {
    if (outerWidth < 1 || outerHeight < 1) return 0;
    const candidateW = Math.min(outerWidth, outerHeight * aspectRatio);
    return Math.floor(candidateW);
  });
  let fittedHeight = $derived.by(() => {
    if (outerWidth < 1 || outerHeight < 1) return 0;
    const candidateH = Math.min(outerHeight, outerWidth / Math.max(0.001, aspectRatio));
    return Math.floor(candidateH);
  });

  let outerObserver: ResizeObserver | null = null;
  $effect(() => {
    if (!outerEl) return;
    const updateSize = () => {
      if (outerEl) {
        const r = outerEl.getBoundingClientRect();
        outerWidth = r.width;
        outerHeight = r.height;
      }
    };
    updateSize();
    outerObserver?.disconnect();
    outerObserver = new ResizeObserver(updateSize);
    outerObserver.observe(outerEl);
    return () => outerObserver?.disconnect();
  });

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
    outerObserver?.disconnect();
    outerObserver = null;
    renderer?.dispose();
    renderer = null;
    img = null;
  });
</script>

<div bind:this={outerEl} class="relative flex h-full w-full items-center justify-center">
  <div
    class="relative"
    style="width: {fittedWidth}px; height: {fittedHeight}px;"
  >
    <canvas
      bind:this={canvas}
      class="absolute inset-0 h-full w-full"
      aria-label="Adjust preview"
    ></canvas>
    {#if editManager.showOriginal && compareSrc}
      <!-- Hold-to-compare overlay: shows the saved (server-rendered) preview
           at exactly the same fitted dimensions as the WebGL canvas. Confined
           to the canvas area so the surrounding UI (rotation dial, sidebar)
           doesn't shift when the user holds the eye button. -->
      <img
        src={compareSrc}
        alt="Saved version"
        class="absolute inset-0 h-full w-full object-fill"
        draggable="false"
      />
    {/if}
    {#if children}
      {@render children()}
    {/if}
  </div>
</div>
