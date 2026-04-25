<script lang="ts">
  import { adjustManager } from '$lib/managers/edit/adjust-manager.svelte';
  import { AdjustGLRenderer } from '$lib/managers/edit/adjust-webgl';
  import { onDestroy, onMount } from 'svelte';

  interface Props {
    src: string;
    onWebglUnavailable?: () => void;
  }

  let { src, onWebglUnavailable }: Props = $props();

  let canvas = $state<HTMLCanvasElement | null>(null);
  let renderer: AdjustGLRenderer | null = null;
  let imageLoaded = $state(false);

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

<canvas
  bind:this={canvas}
  class="max-h-full max-w-full object-contain"
  aria-label="Adjust preview"
></canvas>
