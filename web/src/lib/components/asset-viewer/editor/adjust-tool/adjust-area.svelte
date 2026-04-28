<script lang="ts">
  import AdjustCanvasPreview from '$lib/components/asset-viewer/editor/adjust-tool/adjust-canvas-preview.svelte';
  import MaskOverlay from '$lib/components/asset-viewer/editor/adjust-tool/mask-overlay.svelte';
  import { adjustManager } from '$lib/managers/edit/adjust-manager.svelte';
  import { getAssetMediaUrl } from '$lib/utils';
  import { AssetMediaSize, type AssetResponseDto } from '@immich/sdk';

  interface Props {
    asset: AssetResponseDto;
  }

  let { asset }: Props = $props();

  let imgEl = $state<HTMLImageElement | null>(null);
  let useFallback = $state(false);

  let imageUrl = $derived(
    getAssetMediaUrl({ id: asset.id, cacheKey: asset.thumbhash, edited: false, size: AssetMediaSize.Preview }),
  );
  // For hold-to-compare: the server-rendered saved preview (with previously-
  // applied edits baked in). Default `edited: true` is what we want.
  let savedUrl = $derived(getAssetMediaUrl({ id: asset.id, cacheKey: asset.thumbhash, size: AssetMediaSize.Preview }));

  // Fallback path only — used when WebGL isn't available. SVG filter can do the
  // global per-pixel-value adjustments via feComponentTransfer + saturation
  // matrix, but cannot handle spatial masks. With masks present and no WebGL
  // we silently render globals only here; the saved output (server) will still
  // include masks correctly.
  let params = $derived(adjustManager.svgFilterParams);

  let saturationMatrix = $derived.by(() => {
    const s = 1 + adjustManager.values.saturation;
    const lumR = 0.3086;
    const lumG = 0.6094;
    const lumB = 0.082;
    return [
      lumR * (1 - s) + s, lumG * (1 - s),     lumB * (1 - s),     0, 0,
      lumR * (1 - s),     lumG * (1 - s) + s, lumB * (1 - s),     0, 0,
      lumR * (1 - s),     lumG * (1 - s),     lumB * (1 - s) + s, 0, 0,
      0,                  0,                  0,                  1, 0,
    ].join(' ');
  });

  // Browsers cache SVG filter results across attribute changes; force a
  // reflow + re-application on each param change so updates are visible.
  $effect(() => {
    if (!useFallback) {
      return;
    }
    const _p = params;
    const _s = saturationMatrix;
    if (imgEl) {
      imgEl.style.filter = 'none';
      void imgEl.offsetWidth;
      imgEl.style.filter = 'url(#adjust-filter)';
    }
  });
</script>

<div class="flex h-full w-full items-center justify-center">
  {#if !useFallback}
    <AdjustCanvasPreview src={imageUrl} compareSrc={savedUrl} onWebglUnavailable={() => (useFallback = true)}>
      <MaskOverlay />
    </AdjustCanvasPreview>
  {:else}
    <svg class="absolute" width="0" height="0">
      <defs>
        <filter id="adjust-filter" color-interpolation-filters="sRGB">
          <feComponentTransfer>
            <feFuncR type="gamma" amplitude={params.r.slope} exponent={params.r.gamma} offset={params.r.intercept} />
            <feFuncG type="gamma" amplitude={params.g.slope} exponent={params.g.gamma} offset={params.g.intercept} />
            <feFuncB type="gamma" amplitude={params.b.slope} exponent={params.b.gamma} offset={params.b.intercept} />
          </feComponentTransfer>
          {#if adjustManager.values.saturation !== 0}
            <feColorMatrix type="matrix" values={saturationMatrix} />
          {/if}
        </filter>
      </defs>
    </svg>

    <img
      bind:this={imgEl}
      src={imageUrl}
      alt="Adjust preview"
      class="max-h-full max-w-full object-contain"
      style="filter: url(#adjust-filter)"
      draggable="false"
    />
  {/if}
</div>
