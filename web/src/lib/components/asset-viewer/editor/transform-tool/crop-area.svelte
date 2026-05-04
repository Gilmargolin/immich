<script lang="ts">
  import { adjustManager } from '$lib/managers/edit/adjust-manager.svelte';
  import { editManager } from '$lib/managers/edit/edit-manager.svelte';
  import { transformManager } from '$lib/managers/edit/transform-manager.svelte';
  import { AdjustGLRenderer, FULL_CROP } from '$lib/managers/edit/adjust-webgl';
  import { getAssetMediaUrl } from '$lib/utils';
  import { AssetMediaSize, type AssetResponseDto } from '@immich/sdk';
  import { onDestroy } from 'svelte';
  import { t } from 'svelte-i18n';

  interface Props {
    asset: AssetResponseDto;
  }

  let { asset }: Props = $props();

  let canvasContainer = $state<HTMLElement | null>(null);
  let cropCanvasEl = $state<HTMLCanvasElement | null>(null);
  let cropCanvasRenderer: AdjustGLRenderer | null = null;
  let cropImageReady = $state(false);

  let imageSrc = $derived(
    getAssetMediaUrl({ id: asset.id, cacheKey: asset.thumbhash, edited: false, size: AssetMediaSize.Preview }),
  );
  // Hold-to-compare URL (default `edited: true` returns the saved/edited preview).
  let savedSrc = $derived(getAssetMediaUrl({ id: asset.id, cacheKey: asset.thumbhash, size: AssetMediaSize.Preview }));

  // Initialise the WebGL renderer on the crop canvas. Mirrors the adjust-area
  // approach so the crop-mode preview uses the same math the server runs on
  // save — the previous SVG-filter fallback used a per-channel gamma curve
  // that drastically over-darkened mid-tones for highlights/shadows sliders,
  // so the live preview disagreed with the saved file.
  $effect(() => {
    if (!cropCanvasEl || cropCanvasRenderer) return;
    // Expose the canvas to the transform manager (it reads style.width/height
    // for layout — both <canvas> and <img> work here).
    transformManager.domImgEl = cropCanvasEl;
    try {
      cropCanvasRenderer = new AdjustGLRenderer(cropCanvasEl);
    } catch (error) {
      console.warn('WebGL preview unavailable in crop area', error);
      cropCanvasRenderer = null;
    }
  });

  $effect(() => {
    const url = imageSrc;
    if (!url || !cropCanvasRenderer) return;
    let cancelled = false;
    cropImageReady = false;
    const el = new Image();
    el.crossOrigin = 'anonymous';
    el.decoding = 'async';
    el.onload = () => {
      if (cancelled || !cropCanvasRenderer) return;
      cropCanvasRenderer.setImage(el);
      cropCanvasRenderer.resizeCanvas(FULL_CROP);
      cropImageReady = true;
      scheduleCropRender();
    };
    el.onerror = () => {
      if (!cancelled) console.warn('Failed to load crop preview image', url);
    };
    el.src = url;
    return () => {
      cancelled = true;
    };
  });

  let pendingCropRaf: number | null = null;
  const scheduleCropRender = () => {
    if (pendingCropRaf !== null) return;
    pendingCropRaf = requestAnimationFrame(() => {
      pendingCropRaf = null;
      if (cropCanvasRenderer && cropImageReady) {
        cropCanvasRenderer.render(adjustManager.values, adjustManager.masks, FULL_CROP);
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
    scheduleCropRender();
  });

  onDestroy(() => {
    if (pendingCropRaf !== null) {
      cancelAnimationFrame(pendingCropRaf);
      pendingCropRaf = null;
    }
    cropCanvasRenderer?.dispose();
    cropCanvasRenderer = null;
  });

  /**
   * Scale factor so that, when rotated by θ, the image's rotated quad
   * fully covers the crop frame (the axis-aligned W×H box at the image's
   * layout size). Standard cover-after-rotation math; the max of the two
   * corner constraints is the binding one.
   *
   *   scale = max(cosθ + (H/W)·sinθ, (W/H)·sinθ + cosθ)
   *
   * This is the original Immich behavior — image grows slightly on
   * rotation, frame stays at its user-drawn size, and the .crop-area's
   * `overflow: hidden` (+ `contain: paint`) clips the extension so nothing
   * bleeds outside the image box even for portrait photos in a wide viewport.
   */
  let imageScale = $derived.by(() => {
    const theta = Math.abs(transformManager.freeRotation * Math.PI / 180);
    if (theta === 0) return 1;
    // Read cropImageSize ($state), not imgElement.width directly — the
    // native `.width` property is not reactive, so when an asset is
    // re-opened with a pre-existing rotation the derived runs once
    // before the image finishes loading (width = 0, returns 1) and
    // then never re-runs. Result: cover-scale is missing and the user
    // sees black triangular wedges inside the crop frame. cropImageSize
    // is updated in onImageLoad, so reading it here re-fires this
    // derived the moment the image dims become known.
    const { width: W, height: H } = transformManager.cropImageSize;
    if (W === 0 || H === 0) return 1;
    const cosT = Math.cos(theta);
    const sinT = Math.sin(theta);
    return Math.max(cosT + (H / W) * sinT, (W / H) * sinT + cosT);
  });

  let imageTransform = $derived.by(() => {
    const transforms: string[] = [];

    // Scale FIRST so the rotated image still covers the frame — this is
    // how the original (working) implementation did it. With `scale(X) rotate(Y)`
    // CSS applies rotate first then scale, which is the order we want
    // (rotate the image around center, then scale it up just enough to
    // cover its original W×H box).
    if (imageScale !== 1) {
      transforms.push(`scale(${imageScale})`);
    }
    if (transformManager.freeRotation !== 0) {
      transforms.push(`rotate(${transformManager.freeRotation}deg)`);
    }

    if (transformManager.mirrorHorizontal) {
      transforms.push('scaleX(-1)');
    }
    if (transformManager.mirrorVertical) {
      transforms.push('scaleY(-1)');
    }

    return transforms.join(' ');
  });


  $effect(() => {
    if (!canvasContainer) {
      return;
    }

    // When CropArea mounts (which only happens in crop mode), rehydrate
    // the transform state from the stored edits. This covers the case
    // where the editor opened in adjust mode first — onImageLoad fired
    // before cropAreaEl was bound and bailed, so state is still at
    // reset defaults until we re-run it here.
    transformManager.rehydrateIfReady();

    // Observe the outer container; the crop viewport is a flex child of
    // it and resizes with it. We don't observe the <img> itself because
    // JS now drives its rendered size (applyImageSize sets explicit
    // pixel dims on resize), and observing it would create a feedback
    // loop: style change → observer fires → recompute → style change.
    const resizeObserver = new ResizeObserver(() => {
      transformManager.resizeCanvas();
    });
    resizeObserver.observe(canvasContainer);

    return () => {
      resizeObserver.disconnect();
    };
  });

  // Per-property reactive values instead of one `style={string}` blob.
  // The blob form replaces the whole `style` attribute on every derived
  // update, which was wiping the inline `width`/`height` that
  // applyImageSize had set — cropArea then fell back to
  // max-width/height:100%, ballooned to the viewport, and the <img>
  // inside (still at its fixed pixel size) suddenly had its previously
  // clipped extension visible on the right. That only fired *after* the
  // user touched the dial or dragged a handle because those are the
  // events that cause the derived to re-run.
  //
  // With style:property={value} directives Svelte manages each property
  // independently, so width/height set by applyImageSize coexists with
  // the reactive transform/transition without being clobbered.
  let cropTransition = $derived(
    transformManager.isInteracting ? 'none' : 'transform 0.3s ease',
  );
  let cropTransform = $derived.by(() => {
    const rotation = transformManager.imageRotation;
    const zoom = transformManager.freeRotation !== 0 ? 1 : transformManager.cropZoom;

    if (zoom <= 1) {
      return `translate(0px, 0px) rotate(${rotation}deg) scale(1)`;
    }

    const el = transformManager.cropAreaEl;
    if (!el) return `translate(0px, 0px) rotate(${rotation}deg) scale(1)`;

    const W = el.clientWidth;
    const H = el.clientHeight;

    const r = transformManager.zoomAnchorRegion ?? transformManager.region;
    const cx = r.x + r.width / 2;
    const cy = r.y + r.height / 2;

    const dx = cx - W / 2;
    const dy = cy - H / 2;

    const theta = (rotation * Math.PI) / 180;
    const cosT = Math.cos(theta);
    const sinT = Math.sin(theta);

    const tx = -(zoom * dx * cosT - zoom * dy * sinT);
    const ty = -(zoom * dx * sinT + zoom * dy * cosT);

    return `translate(${tx}px, ${ty}px) rotate(${rotation}deg) scale(${zoom})`;
  });

  // Show grid when free rotating or interacting
  let showGrid = $derived(transformManager.freeRotation !== 0 || transformManager.isInteracting);

  // Counter-scale so crop frame border/corners stay visually consistent when zoomed
  let frameScale = $derived(transformManager.cropZoom > 1 ? 1 / transformManager.cropZoom : 1);

  // --- Rotation dial ---
  const DIAL_MIN = -45;
  const DIAL_MAX = 45;
  const PX_PER_DEGREE = 6;

  let isDraggingDial = $state(false);
  let dragStartX = $state(0);
  let dragStartAngle = $state(0);

  const ZERO_TICK_CENTER = (0 - DIAL_MIN) * PX_PER_DEGREE + PX_PER_DEGREE / 2;
  let dialOffset = $derived(-ZERO_TICK_CENTER - transformManager.freeRotation * PX_PER_DEGREE);
  let freeRotationDisplay = $derived(Math.round(transformManager.freeRotation));

  function handleDialPointerDown(e: PointerEvent) {
    isDraggingDial = true;
    dragStartX = e.clientX;
    dragStartAngle = transformManager.freeRotation;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }

  function handleDialPointerMove(e: PointerEvent) {
    if (!isDraggingDial) return;
    const dx = e.clientX - dragStartX;
    const angleDelta = -dx / PX_PER_DEGREE;
    const newAngle = Math.max(DIAL_MIN, Math.min(DIAL_MAX, Math.round(dragStartAngle + angleDelta)));
    transformManager.setFreeRotation(newAngle);
  }

  function handleDialPointerUp() {
    isDraggingDial = false;
  }

  const ticks: { degree: number; isMajor: boolean }[] = [];
  for (let d = DIAL_MIN; d <= DIAL_MAX; d++) {
    ticks.push({ degree: d, isMajor: d % 10 === 0 });
  }
</script>

<div class="canvas-container" bind:this={canvasContainer}>
  <div class="crop-viewport">
    <button
      class={`crop-area ${transformManager.orientationChanged ? 'changedOriention' : ''}`}
      style:transition={cropTransition}
      style:transform={cropTransform}
      bind:this={transformManager.cropAreaEl}
      onmousedown={(e) => transformManager.handleMouseDown(e)}
      onmouseup={() => transformManager.handleMouseUp()}
      aria-label="Crop area"
      type="button"
    >
      <canvas
        bind:this={cropCanvasEl}
        aria-label={$t('editor')}
        style:transform={imageTransform || undefined}
      ></canvas>
      <div
        class={`${showGrid ? 'resizing' : ''} crop-frame`}
        bind:this={transformManager.cropFrame}
        style:--s={frameScale}
      >
        <div class="grid"></div>
        <div class="corner top-left"></div>
        <div class="corner top-right"></div>
        <div class="corner bottom-left"></div>
        <div class="corner bottom-right"></div>
      </div>
      <div
        class={`${transformManager.isInteracting ? 'light' : ''} overlay`}
        bind:this={transformManager.overlayEl}
      ></div>
    </button>
    {#if editManager.showOriginal}
      <!-- Hold-to-compare overlay confined to crop-viewport so the rotation
           dial below stays visible and the layout doesn't shift. -->
      <img
        src={savedSrc}
        alt="Saved version"
        class="compare-overlay"
        draggable="false"
      />
    {/if}
  </div>

  <!-- Rotation dial below the image -->
  <div class="rotation-dial-wrapper">
    <span class="rotation-value {freeRotationDisplay !== 0 ? 'active' : ''}">{freeRotationDisplay}°</span>
    <div class="dial-container">
      <div class="dial-indicator"></div>
      <div
        class="dial-track"
        onpointerdown={handleDialPointerDown}
        onpointermove={handleDialPointerMove}
        onpointerup={handleDialPointerUp}
        onpointercancel={handleDialPointerUp}
        role="slider"
        aria-label={$t('editor_free_rotation')}
        aria-valuemin={DIAL_MIN}
        aria-valuemax={DIAL_MAX}
        aria-valuenow={freeRotationDisplay}
        tabindex="0"
      >
        <div class="dial-ruler" style="transform: translateX({dialOffset}px)">
          {#each ticks as tick (tick.degree)}
            <div class="tick {tick.isMajor ? 'major' : ''} {tick.degree === 0 ? 'zero' : ''}">
              <div class="tick-line"></div>
              {#if tick.isMajor}
                <span class="tick-label">{tick.degree}</span>
              {/if}
            </div>
          {/each}
        </div>
      </div>
    </div>
  </div>
</div>

<style>
  .canvas-container {
    width: calc(100% - 4rem);
    margin: auto;
    margin-top: 2rem;
    height: calc(100% - 4rem);
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    position: relative;
  }

  .crop-viewport {
    flex: 1;
    min-height: 0;
    width: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
    overflow: hidden;
    position: relative;
  }

  .compare-overlay {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    object-fit: contain;
    background: #000;
    z-index: 10;
    pointer-events: none;
  }

  .crop-area {
    position: relative;
    display: block;
    outline: none;
    max-height: 100%;
    max-width: 100%;
    /* Explicit width and height are set by transformManager.applyImageSize()
       to match the displayed image exactly. We don't use `width: max-content`
       any more because it doesn't always lock the element's layout against
       transformed children — the rotation extension could bleed past
       overflow:hidden. `contain: paint` forces the clipping context to be
       the element's box, independent of child transforms. */
    overflow: hidden;
    contain: paint;
  }
  .crop-area.changedOriention {
    max-width: 92vh;
    max-height: calc(100vw - 400px - 1.5rem);
  }

  .crop-frame.transition {
    transition: all 0.15s ease;
  }
  .overlay {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: rgba(0, 0, 0, 0.56);
    pointer-events: none;
    transition: background 0.1s;
  }

  .overlay.light {
    background: rgba(0, 0, 0, 0.3);
  }

  .grid {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background-image:
      linear-gradient(rgba(255, 255, 255, 0.3) 0.5px, transparent 0),
      linear-gradient(90deg, rgba(255, 255, 255, 0.3) 0.5px, transparent 0);
    background-size: calc(100% / 6) calc(100% / 6);
    opacity: 0;
    transition: opacity 0.1s ease;
  }

  .crop-frame.resizing .grid {
    opacity: 1;
  }

  .crop-area > canvas {
    display: block;
    user-select: none;
    transition: transform 0.15s ease;
    transform-origin: center center;
    /* Explicit width/height are set by transformManager.applyImageSize()
       via inline style — we deliberately don't constrain here so the JS
       values are authoritative and the canvas always fits the viewport. */
  }

  .crop-frame {
    position: absolute;
    border: max(1px, calc(2px * var(--s, 1))) solid white;
    box-sizing: border-box;
    pointer-events: none;
    z-index: 1;
  }

  .corner {
    position: absolute;
    width: max(10px, calc(20px * var(--s, 1)));
    height: max(10px, calc(20px * var(--s, 1)));
    --size: max(2px, calc(5.2px * var(--s, 1)));
    --mSize: calc(-0.5 * var(--size));
    border: var(--size) solid white;
    box-sizing: border-box;
  }

  .top-left {
    top: var(--mSize);
    left: var(--mSize);
    border-right: none;
    border-bottom: none;
  }

  .top-right {
    top: var(--mSize);
    right: var(--mSize);
    border-left: none;
    border-bottom: none;
  }

  .bottom-left {
    bottom: var(--mSize);
    left: var(--mSize);
    border-right: none;
    border-top: none;
  }

  .bottom-right {
    bottom: var(--mSize);
    right: var(--mSize);
    border-left: none;
    border-top: none;
  }

  /* Rotation dial */
  .rotation-dial-wrapper {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
    margin-top: 16px;
    width: 100%;
    max-width: 320px;
    flex-shrink: 0;
    position: relative;
  }

  .rotation-value {
    font-size: 13px;
    font-variant-numeric: tabular-nums;
    color: rgba(255, 255, 255, 0.4);
    transition: color 0.15s;
  }

  .rotation-value.active {
    color: white;
  }

  .dial-container {
    position: relative;
    width: 100%;
    height: 40px;
    overflow: hidden;
  }

  .dial-indicator {
    position: absolute;
    left: 50%;
    top: 4px;
    width: 2px;
    height: 18px;
    background: white;
    transform: translateX(-50%);
    z-index: 2;
    border-radius: 1px;
  }

  .dial-track {
    width: 100%;
    height: 100%;
    cursor: grab;
    touch-action: none;
    user-select: none;
    display: flex;
    align-items: flex-start;
    padding-top: 4px;
  }

  .dial-track:active {
    cursor: grabbing;
  }

  .dial-ruler {
    display: flex;
    align-items: flex-start;
    margin-left: 50%;
  }

  .tick {
    display: flex;
    flex-direction: column;
    align-items: center;
    width: 6px;
    flex-shrink: 0;
  }

  .tick-line {
    width: 1px;
    height: 8px;
    background: rgba(255, 255, 255, 0.25);
    border-radius: 0.5px;
  }

  .tick.major .tick-line {
    height: 14px;
    background: rgba(255, 255, 255, 0.5);
  }

  .tick.zero .tick-line {
    height: 16px;
    width: 2px;
    background: rgba(255, 255, 255, 0.7);
  }

  .tick-label {
    font-size: 9px;
    color: rgba(255, 255, 255, 0.4);
    margin-top: 2px;
    line-height: 1;
    font-variant-numeric: tabular-nums;
  }

  .tick.zero .tick-label {
    color: rgba(255, 255, 255, 0.7);
  }
</style>
