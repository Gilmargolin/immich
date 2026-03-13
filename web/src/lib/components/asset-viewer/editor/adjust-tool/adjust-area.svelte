<script lang="ts">
  import { adjustManager } from '$lib/managers/edit/adjust-manager.svelte';
  import { getAssetMediaUrl } from '$lib/utils';
  import { AssetMediaSize, type AssetResponseDto } from '@immich/sdk';

  interface Props {
    asset: AssetResponseDto;
  }

  let { asset }: Props = $props();

  let imgEl = $state<HTMLImageElement | null>(null);

  let imageUrl = $derived(
    getAssetMediaUrl({ id: asset.id, cacheKey: asset.thumbhash, edited: false, size: AssetMediaSize.Preview }),
  );
  let params = $derived(adjustManager.svgFilterParams);

  // Saturation matrix for feColorMatrix
  // Same luminance weights as the server-side implementation
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

  // Force browser to re-evaluate SVG filter when params change.
  // Browsers cache SVG filter results and may not re-render when filter attributes update.
  $effect(() => {
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
  <!-- SVG filter definition -->
  <svg class="absolute" width="0" height="0">
    <defs>
      <filter id="adjust-filter" color-interpolation-filters="sRGB">
        <!-- Per-channel gamma + linear transfer -->
        <feComponentTransfer>
          <feFuncR type="gamma" amplitude={params.r.slope} exponent={params.r.gamma} offset={params.r.intercept} />
          <feFuncG type="gamma" amplitude={params.g.slope} exponent={params.g.gamma} offset={params.g.intercept} />
          <feFuncB type="gamma" amplitude={params.b.slope} exponent={params.b.gamma} offset={params.b.intercept} />
        </feComponentTransfer>
        <!-- Saturation via color matrix -->
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
</div>
