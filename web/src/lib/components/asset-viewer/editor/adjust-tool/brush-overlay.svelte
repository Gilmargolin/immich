<script lang="ts">
  import { adjustManager } from '$lib/managers/edit/adjust-manager.svelte';
  import { BRUSH_MASK_RESOLUTION, type BrushMask } from '$lib/managers/edit/adjust-webgl';
  import { onDestroy, onMount } from 'svelte';

  // Brush-paint canvas overlay. Active when:
  //   - editing mask kind === 'brush' AND editingMaskIndex === maskIndex, OR
  //   - the user just clicked the Brush button (pendingMaskKind === 'brush'),
  //     in which case we paint into a freshly-allocated buffer and commit it
  //     to a new mask on the first pointerup.
  //
  // Drawing model:
  //   - One offscreen canvas at fixed BRUSH_MASK_RESOLUTION × BRUSH_MASK_RESOLUTION
  //     holds the authoritative greyscale alpha. All paint ops write here.
  //   - One on-screen <canvas> overlays the photo at its full visual size and
  //     mirrors the offscreen buffer for the user to see the strokes (red tint).
  //   - Pointer coords on the on-screen canvas are mapped to the offscreen
  //     resolution: (e_x / cssWidth) * 512, (e_y / cssHeight) * 512.
  //   - On pointerup, the offscreen canvas is `toDataURL`'d into the mask DTO.
  //
  // UX:
  //   - Brush size slider (1–200 px in offscreen-canvas units, default 50).
  //     Cursor is a circle of that size on screen.
  //   - Drag = paint additively (lighter-color composite so strokes accumulate).
  //   - Right-click drag OR Alt+drag = erase (destination-out).
  //   - Soft edge: the brush is a radial gradient with hardness fixed at 30%
  //     (alpha=255 inside the inner 30% of the radius, fading to 0 at the edge).

  interface Props {
    maskIndex: number | null;
    // When true, render the painted alpha as a static red tint and ignore
    // pointer events. Used by mask-overlay.svelte to show an idle brush mask
    // (committed but not currently being edited) without offering a paint
    // surface.
    readonly?: boolean;
  }
  let { maskIndex, readonly = false }: Props = $props();

  const HARDNESS = 0.3;

  let brushSize = $state(50);
  let cursorX = $state<number | null>(null);
  let cursorY = $state<number | null>(null);
  let cursorVisible = $state(false);

  let displayCanvas = $state<HTMLCanvasElement | null>(null);
  let cssWidth = $state(0);
  let resizeObserver: ResizeObserver | null = null;

  // Authoritative paint canvas — fixed BRUSH_MASK_RESOLUTION² greyscale.
  // Stored as an RGBA canvas because <canvas>'s 2D context only supports
  // RGBA; the encoder collapses to greyscale on commit.
  let offscreen = $state<HTMLCanvasElement | null>(null);
  let offscreenCtx = $state<CanvasRenderingContext2D | null>(null);

  // Mask we're editing (when maskIndex is set). null while drawing into a
  // fresh buffer for a pending brush mask.
  let mask = $derived.by((): BrushMask | null => {
    if (maskIndex === null) {
      return null;
    }
    const m = adjustManager.masks[maskIndex];
    return m && m.kind === 'brush' ? (m as BrushMask) : null;
  });

  // Re-hydrate the offscreen canvas from the mask DTO when we (re-)mount on a
  // committed brush mask. For a pending (uncommitted) brush mask, we start
  // empty.
  let lastLoadedSrc = $state<string | null>(null);
  $effect(() => {
    if (!offscreen || !offscreenCtx) {
      return;
    }
    const src = mask?.mask ?? null;
    if (src === lastLoadedSrc) {
      return;
    }
    lastLoadedSrc = src;
    if (!src) {
      offscreenCtx.clearRect(0, 0, BRUSH_MASK_RESOLUTION, BRUSH_MASK_RESOLUTION);
      redrawDisplay();
      return;
    }
    const url = src.startsWith('data:') ? src : `data:image/png;base64,${src}`;
    const img = new Image();
    img.addEventListener('load', () => {
      if (!offscreenCtx) {
        return;
      }
      // The saved PNG is opaque greyscale: painted = white RGB, unpainted =
      // black RGB, alpha = 1 everywhere. The OFFSCREEN canvas, by contrast,
      // is kept in "white RGB + alpha = mask weight" form so paint strokes
      // composite correctly and `redrawDisplay` (source-in red on top of
      // alpha) tints only the painted region. So after drawing the loaded
      // image we re-key the canvas: copy the R channel into alpha and set
      // RGB to white. Without this the loaded mask reads as fully opaque
      // and the red tint smears across the whole photo.
      offscreenCtx.clearRect(0, 0, BRUSH_MASK_RESOLUTION, BRUSH_MASK_RESOLUTION);
      offscreenCtx.drawImage(img, 0, 0, BRUSH_MASK_RESOLUTION, BRUSH_MASK_RESOLUTION);
      const imgData = offscreenCtx.getImageData(0, 0, BRUSH_MASK_RESOLUTION, BRUSH_MASK_RESOLUTION);
      const data = imgData.data;
      for (let i = 0; i < data.length; i += 4) {
        const grey = data[i];
        data[i] = 255;
        data[i + 1] = 255;
        data[i + 2] = 255;
        data[i + 3] = grey;
      }
      offscreenCtx.putImageData(imgData, 0, 0);
      redrawDisplay();
    });
    img.src = url;
  });

  onMount(() => {
    offscreen = document.createElement('canvas');
    offscreen.width = BRUSH_MASK_RESOLUTION;
    offscreen.height = BRUSH_MASK_RESOLUTION;
    offscreenCtx = offscreen.getContext('2d');
  });

  $effect(() => {
    if (!displayCanvas) {
      return;
    }
    const update = () => {
      if (!displayCanvas) {
        return;
      }
      const r = displayCanvas.getBoundingClientRect();
      cssWidth = r.width;
      // Set the on-screen canvas's drawing buffer to its CSS size so the red
      // overlay stays crisp at any zoom.
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const targetW = Math.max(1, Math.round(r.width * dpr));
      const targetH = Math.max(1, Math.round(r.height * dpr));
      if (displayCanvas.width !== targetW || displayCanvas.height !== targetH) {
        displayCanvas.width = targetW;
        displayCanvas.height = targetH;
      }
      redrawDisplay();
    };
    update();
    resizeObserver?.disconnect();
    resizeObserver = new ResizeObserver(update);
    resizeObserver.observe(displayCanvas);
    return () => resizeObserver?.disconnect();
  });

  onDestroy(() => {
    resizeObserver?.disconnect();
    resizeObserver = null;
  });

  // Redraw the on-screen canvas from the offscreen alpha. We tint everything
  // red so the user sees what's painted; alpha is preserved.
  const redrawDisplay = () => {
    if (!displayCanvas || !offscreen) {
      return;
    }
    const ctx = displayCanvas.getContext('2d');
    if (!ctx) {
      return;
    }
    ctx.clearRect(0, 0, displayCanvas.width, displayCanvas.height);
    ctx.save();
    // Draw the painted alpha as a red tint.
    ctx.globalCompositeOperation = 'source-over';
    ctx.drawImage(offscreen, 0, 0, displayCanvas.width, displayCanvas.height);
    // Replace whatever color the offscreen has with red, preserving alpha.
    ctx.globalCompositeOperation = 'source-in';
    ctx.fillStyle = 'rgba(239, 68, 68, 0.55)';
    ctx.fillRect(0, 0, displayCanvas.width, displayCanvas.height);
    ctx.restore();
  };

  // Map an event's client coords → offscreen-canvas pixel coords.
  const eventToOffscreen = (e: PointerEvent): { x: number; y: number } => {
    if (!displayCanvas) {
      return { x: 0, y: 0 };
    }
    const rect = displayCanvas.getBoundingClientRect();
    const fx = (e.clientX - rect.left) / Math.max(1, rect.width);
    const fy = (e.clientY - rect.top) / Math.max(1, rect.height);
    return { x: fx * BRUSH_MASK_RESOLUTION, y: fy * BRUSH_MASK_RESOLUTION };
  };

  // Stamp one paint disc at (x, y) in offscreen coords.
  const stamp = (x: number, y: number, erase: boolean) => {
    if (!offscreenCtx) {
      return;
    }
    const r = brushSize;
    if (erase) {
      offscreenCtx.save();
      offscreenCtx.globalCompositeOperation = 'destination-out';
      offscreenCtx.fillStyle = 'rgba(0,0,0,1)';
      offscreenCtx.beginPath();
      offscreenCtx.arc(x, y, r, 0, Math.PI * 2);
      offscreenCtx.fill();
      offscreenCtx.restore();
      return;
    }
    // Soft-edged paint: hard inner 30%, smooth fade to the edge. Use 'lighter'
    // so strokes accumulate up to fully opaque (matches Lightroom behavior).
    const grad = offscreenCtx.createRadialGradient(x, y, r * HARDNESS, x, y, r);
    grad.addColorStop(0, 'rgba(255, 255, 255, 1)');
    grad.addColorStop(1, 'rgba(255, 255, 255, 0)');
    offscreenCtx.save();
    offscreenCtx.globalCompositeOperation = 'lighter';
    offscreenCtx.fillStyle = grad;
    offscreenCtx.beginPath();
    offscreenCtx.arc(x, y, r, 0, Math.PI * 2);
    offscreenCtx.fill();
    offscreenCtx.restore();
  };

  // Walk between the previous and current pointer position, stamping along
  // the way so a fast drag doesn't leave gaps. Spacing is half the radius —
  // good balance between solid line and overdraw cost.
  const walkAndStamp = (fromX: number, fromY: number, toX: number, toY: number, erase: boolean) => {
    const dx = toX - fromX;
    const dy = toY - fromY;
    const dist = Math.hypot(dx, dy);
    const step = Math.max(1, brushSize * 0.5);
    const n = Math.max(1, Math.ceil(dist / step));
    for (let i = 1; i <= n; i++) {
      const t = i / n;
      stamp(fromX + dx * t, fromY + dy * t, erase);
    }
  };

  let drawing = $state(false);
  let lastX = 0;
  let lastY = 0;

  const onPointerDown = (e: PointerEvent) => {
    if (!offscreenCtx) {
      return;
    }
    e.preventDefault();
    const target = e.currentTarget as HTMLCanvasElement;
    target.setPointerCapture(e.pointerId);
    drawing = true;
    const erase = e.button === 2 || e.altKey;
    const { x, y } = eventToOffscreen(e);
    lastX = x;
    lastY = y;
    stamp(x, y, erase);
    redrawDisplay();
  };

  const onPointerMove = (e: PointerEvent) => {
    cursorX = e.clientX;
    cursorY = e.clientY;
    cursorVisible = true;
    if (!drawing) {
      return;
    }
    const erase = e.button === 2 || e.altKey || (e.buttons & 2) !== 0;
    const { x, y } = eventToOffscreen(e);
    walkAndStamp(lastX, lastY, x, y, erase);
    lastX = x;
    lastY = y;
    redrawDisplay();
  };

  const finishStroke = () => {
    if (!drawing || !offscreen) {
      return;
    }
    drawing = false;
    // Encode the offscreen buffer to a greyscale PNG. Browser canvas only
    // emits RGBA; we collapse to one channel (using R since the brush writes
    // white) before encoding, so the saved PNG is small AND its bytes match
    // what the server / GLSL sampler reads (just the R channel of any
    // pixel).
    const grayCanvas = document.createElement('canvas');
    grayCanvas.width = BRUSH_MASK_RESOLUTION;
    grayCanvas.height = BRUSH_MASK_RESOLUTION;
    const gctx = grayCanvas.getContext('2d');
    if (!gctx) {
      return;
    }
    // Source pixels have white RGB and varying alpha. Composite onto an
    // opaque black background using the alpha as a mask, then we get a
    // greyscale-by-luminance image where painted = white, unpainted = black.
    gctx.fillStyle = 'black';
    gctx.fillRect(0, 0, BRUSH_MASK_RESOLUTION, BRUSH_MASK_RESOLUTION);
    gctx.drawImage(offscreen, 0, 0);
    const dataUrl = grayCanvas.toDataURL('image/png');
    // Suppress the load-from-DTO effect for the value we're about to write —
    // the offscreen already has these pixels; reloading would briefly clear
    // and redraw, causing a visible flicker.
    lastLoadedSrc = dataUrl;
    if (mask && maskIndex !== null) {
      adjustManager.updateMask(maskIndex, { ...mask, mask: dataUrl });
    } else if (adjustManager.pendingMaskKind === 'brush') {
      adjustManager.commitDrawnBrushMask(dataUrl);
    }
  };

  const onPointerUp = (e: PointerEvent) => {
    const target = e.currentTarget as HTMLCanvasElement;
    try {
      target.releasePointerCapture(e.pointerId);
    } catch {
      // pointer may already have been released by browser
    }
    finishStroke();
  };

  const onPointerLeave = () => {
    cursorVisible = false;
  };

  const onContextMenu = (e: MouseEvent) => {
    // Right-click is "erase"; suppress the OS context menu so the user can
    // drag-erase without pop-ups.
    e.preventDefault();
  };
</script>

<div class="absolute inset-0" style="pointer-events: {readonly ? 'none' : 'auto'};">
  {#if readonly}
    <canvas bind:this={displayCanvas} class="absolute inset-0 h-full w-full" style="opacity: 0.7;"></canvas>
  {:else}
    <canvas
      bind:this={displayCanvas}
      class="absolute inset-0 h-full w-full"
      style="cursor: none; touch-action: none;"
      onpointerdown={onPointerDown}
      onpointermove={onPointerMove}
      onpointerup={onPointerUp}
      onpointercancel={onPointerUp}
      onpointerleave={onPointerLeave}
      oncontextmenu={onContextMenu}
    ></canvas>

    {#if cursorVisible && cursorX !== null && cursorY !== null && cssWidth > 0}
      {@const cssRadius = brushSize * (cssWidth / BRUSH_MASK_RESOLUTION)}
      <div
        class="pointer-events-none fixed rounded-full border border-white"
        style="left: {cursorX - cssRadius}px; top: {cursorY - cssRadius}px; width: {cssRadius *
          2}px; height: {cssRadius * 2}px; box-shadow: 0 0 0 1px rgba(0,0,0,0.6) inset;"
      ></div>
    {/if}

    <!-- Brush-size slider, anchored top-center over the photo. Same visual
         language as the draw-mode hint banner in mask-overlay.svelte so the
         editor reads as one tool. -->
    <div
      class="pointer-events-auto absolute left-1/2 top-3 -translate-x-1/2 rounded-md bg-black/70 px-3 py-1.5 text-xs text-white"
      style="font-family: system-ui, sans-serif;"
    >
      <label class="flex items-center gap-2">
        Brush
        <input type="range" min="1" max="200" bind:value={brushSize} class="w-32" />
        <span class="tabular-nums">{brushSize}px</span>
        <span class="ms-2 text-gray-300">Alt or right-click to erase</span>
      </label>
    </div>
  {/if}
</div>
