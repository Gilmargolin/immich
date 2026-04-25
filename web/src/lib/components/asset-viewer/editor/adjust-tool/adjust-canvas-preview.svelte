<script lang="ts">
  import { adjustManager } from '$lib/managers/edit/adjust-manager.svelte';
  import { AdjustGLRenderer } from '$lib/managers/edit/adjust-webgl';
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
  // Image aspect ratio (W/H). Used so the canvas+overlay wrapper sizes to the
  // image's aspect within the available area (object-contain semantics).
  let aspectRatio = $state(1);

  // The current image element kept around so we can re-upload to the texture
  // if WebGL state ever needs to be rebuilt (e.g. context loss).
  let img = $state<HTMLImageElement | null>(null);

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

  // Load the source image whenever it changes. Using fetch+createImageBitmap
  // (rather than a plain <img>) avoids CORS-tainting the canvas read path
  // and lets us tear down the bitmap after upload.
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
      aspectRatio = el.naturalWidth / Math.max(1, el.naturalHeight);
      renderer.setImage(el);
      renderer.resizeCanvas();
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

  // Re-render whenever sliders or masks change. We track the relevant state
  // through Svelte's $derived/$effect machinery so changing a slider triggers
  // a single GL draw on the next frame.
  let pendingRaf: number | null = null;
  const scheduleRender = () => {
    if (pendingRaf !== null) {
      return;
    }
    pendingRaf = requestAnimationFrame(() => {
      pendingRaf = null;
      if (renderer && imageLoaded) {
        renderer.render(adjustManager.values, adjustManager.masks);
      }
    });
  };

  $effect(() => {
    // Read reactive state to subscribe to it.
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
  <!--
    Inner wrapper sized to the image's aspect ratio within the available area
    (max-h/max-w + aspect-ratio = "object-contain" for a div). Canvas fills
    the wrapper; the children slot is layered on top at the same dimensions
    so the mask overlay lands exactly on top of the rendered image.
  -->
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
