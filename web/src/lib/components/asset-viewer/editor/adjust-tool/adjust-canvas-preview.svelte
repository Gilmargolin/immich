<script lang="ts">
  import { adjustManager } from '$lib/managers/edit/adjust-manager.svelte';
  import { AdjustGLRenderer, FULL_CROP, type CropRect } from '$lib/managers/edit/adjust-webgl';
  import { transformManager } from '$lib/managers/edit/transform-manager.svelte';
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

  // Pending crop, expressed in texture UV [0,1]. Read from transformManager:
  // its `region` is in displayed-image coords (cropImageSize × cropImageScale),
  // so dividing by displayedImage{Width,Height} gives the UV. When the user
  // hasn't cropped yet, the region equals the full displayed image and this
  // collapses to FULL_CROP.
  let cropRect = $derived.by((): CropRect => {
    const dw = transformManager.displayedImageWidth;
    const dh = transformManager.displayedImageHeight;
    if (dw < 1 || dh < 1) {
      return FULL_CROP;
    }
    const r = transformManager.region;
    const u0 = Math.max(0, Math.min(1, r.x / dw));
    const v0 = Math.max(0, Math.min(1, r.y / dh));
    const u1 = Math.max(0, Math.min(1, (r.x + r.width) / dw));
    const v1 = Math.max(0, Math.min(1, (r.y + r.height) / dh));
    // Tiny default region (100x100 from initial state) → treat as full crop.
    if (u1 - u0 < 0.01 || v1 - v0 < 0.01) {
      return FULL_CROP;
    }
    return { u0, v0, u1, v1 };
  });

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
      // Initial sizing — gets refined by the cropRect effect below once
      // the renderer + image are both in.
      renderer.resizeCanvas(cropRect);
      const c = cropRect;
      const cropW = (c.u1 - c.u0) * el.naturalWidth;
      const cropH = (c.v1 - c.v0) * el.naturalHeight;
      aspectRatio = cropW / Math.max(1, cropH);
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

  // When the crop changes (user re-crops then comes back to mask mode),
  // resize the canvas + update aspect-ratio + re-render.
  $effect(() => {
    const c = cropRect;
    if (!renderer || !imageLoaded || !img) {
      return;
    }
    renderer.resizeCanvas(c);
    const cropW = (c.u1 - c.u0) * img.naturalWidth;
    const cropH = (c.v1 - c.v0) * img.naturalHeight;
    aspectRatio = cropW / Math.max(1, cropH);
    scheduleRender();
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
