<script lang="ts">
  import { adjustManager } from '$lib/managers/edit/adjust-manager.svelte';
  import { transformManager } from '$lib/managers/edit/transform-manager.svelte';
  import { getAssetMediaUrl } from '$lib/utils';
  import { getAltText } from '$lib/utils/thumbnail-util';
  import { toTimelineAsset } from '$lib/utils/timeline-util';
  import { AssetMediaSize, type AssetResponseDto } from '@immich/sdk';
  import { t } from 'svelte-i18n';

  interface Props {
    asset: AssetResponseDto;
  }

  let { asset }: Props = $props();

  let canvasContainer = $state<HTMLElement | null>(null);

  let adjustParams = $derived(adjustManager.svgFilterParams);
  let hasAdjustments = $derived(adjustManager.canReset);
  let saturationMatrix = $derived.by(() => {
    const s = 1 + adjustManager.values.saturation;
    const lumR = 0.3086;
    const lumG = 0.6094;
    const lumB = 0.0820;
    return [
      (lumR * (1 - s)) + s, lumG * (1 - s),       lumB * (1 - s),       0, 0,
      lumR * (1 - s),       (lumG * (1 - s)) + s,  lumB * (1 - s),       0, 0,
      lumR * (1 - s),       lumG * (1 - s),        (lumB * (1 - s)) + s, 0, 0,
      0,                    0,                      0,                    1, 0,
    ].join(' ');
  });

  let imageSrc = $derived(
    getAssetMediaUrl({ id: asset.id, cacheKey: asset.thumbhash, edited: false, size: AssetMediaSize.Preview }),
  );

  // Force browser to re-evaluate SVG filter when adjust params change.
  // Browsers cache SVG filter results and may not re-render when filter attributes update.
  $effect(() => {
    const _p = adjustParams;
    const _s = saturationMatrix;
    const el = transformManager.domImgEl;
    if (el) {
      el.style.filter = 'none';
      void el.offsetWidth;
      el.style.filter = 'url(#crop-adjust-filter)';
    }
  });

  let imageTransform = $derived.by(() => {
    const transforms: string[] = [];

    // Free rotation applied to the image only (frame stays static).
    // Intentionally no scale(): the previous implementation scaled the
    // image up by ~2.6% at 1° to avoid black corners appearing inside
    // the crop frame, which made the image visibly zoom out of the
    // frame on every small rotation. The server already applies an
    // inscribed-rectangle crop after rotation, so the black corners
    // never make it into the saved output. A tiny bit of transparent
    // wedge may show in the editor near the corners on non-zero
    // rotations — that's visual feedback, not part of the save.
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

  // Use matching transform function list so CSS transitions interpolate.
  // During interaction, use frozen anchor region for translate to prevent coordinate drift.
  // Disable transition during interaction so zoom adjustments are instant.
  let cropAreaStyle = $derived.by(() => {
    const zoom = transformManager.cropZoom;
    const rotation = transformManager.imageRotation;
    const interacting = transformManager.isInteracting;
    const transition = interacting ? 'transition: none;' : 'transition: transform 0.3s ease;';

    if (zoom <= 1) {
      return `${transition} transform: translate(0px, 0px) rotate(${rotation}deg) scale(1)`;
    }

    const el = transformManager.cropAreaEl;
    if (!el) return `${transition} transform: translate(0px, 0px) rotate(${rotation}deg) scale(1)`;

    const W = el.clientWidth;
    const H = el.clientHeight;

    // Use anchor region during drag so translate stays stable
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

    return `${transition} transform: translate(${tx}px, ${ty}px) rotate(${rotation}deg) scale(${zoom})`;
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

<svg class="absolute" width="0" height="0">
  <defs>
    <filter id="crop-adjust-filter" color-interpolation-filters="sRGB">
      <feComponentTransfer>
        <feFuncR type="gamma" amplitude={adjustParams.r.slope} exponent={adjustParams.r.gamma} offset={adjustParams.r.intercept} />
        <feFuncG type="gamma" amplitude={adjustParams.g.slope} exponent={adjustParams.g.gamma} offset={adjustParams.g.intercept} />
        <feFuncB type="gamma" amplitude={adjustParams.b.slope} exponent={adjustParams.b.gamma} offset={adjustParams.b.intercept} />
      </feComponentTransfer>
      {#if adjustManager.values.saturation !== 0}
        <feColorMatrix type="matrix" values={saturationMatrix} />
      {/if}
    </filter>
  </defs>
</svg>
<div class="canvas-container" bind:this={canvasContainer}>
  <div class="crop-viewport">
    <button
      class={`crop-area ${transformManager.orientationChanged ? 'changedOriention' : ''}`}
      style={cropAreaStyle}
      bind:this={transformManager.cropAreaEl}
      onmousedown={(e) => transformManager.handleMouseDown(e)}
      onmouseup={() => transformManager.handleMouseUp()}
      aria-label="Crop area"
      type="button"
    >
      <img
        bind:this={transformManager.domImgEl}
        draggable="false"
        src={imageSrc}
        alt={$getAltText(toTimelineAsset(asset))}
        style="{imageTransform ? `transform: ${imageTransform};` : ''} filter: url(#crop-adjust-filter);"
      />
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
  }

  .crop-area {
    position: relative;
    display: inline-block;
    outline: none;
    max-height: 100%;
    max-width: 100%;
    width: max-content;
    /* Clip any rotated content that would otherwise extend past the image's
       layout box. Previously we let it overflow so the dimmed "outside
       crop" area could show more of the source image, but that combined
       with the free-rotation dial produced a visible zoom-out effect
       because the rotated bounding box grows. Clipping keeps the image's
       visible footprint exactly equal to its layout size at all angles. */
    overflow: hidden;
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

  .crop-area img {
    display: block;
    user-select: none;
    transition: transform 0.15s ease;
    transform-origin: center center;
    /* Explicit width/height are set by transformManager.applyImageSize()
       via inline style — we deliberately don't constrain here so the JS
       values are authoritative and the image always fits the viewport. */
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
