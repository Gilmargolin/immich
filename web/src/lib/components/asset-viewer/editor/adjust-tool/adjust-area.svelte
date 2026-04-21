<script lang="ts">
  import { adjustManager } from '$lib/managers/edit/adjust-manager.svelte';
  import { transformManager } from '$lib/managers/edit/transform-manager.svelte';
  import { getAssetMediaUrl } from '$lib/utils';
  import { AssetEditAction, AssetMediaSize, type AssetResponseDto, type CropParameters } from '@immich/sdk';

  interface Props {
    asset: AssetResponseDto;
  }

  let { asset }: Props = $props();

  let imgEl = $state<HTMLImageElement | null>(null);

  let imageUrl = $derived(
    getAssetMediaUrl({ id: asset.id, cacheKey: asset.thumbhash, edited: false, size: AssetMediaSize.Preview }),
  );
  let params = $derived(adjustManager.svgFilterParams);

  // Display the saved/in-session crop region as an object-view-box on the
  // <img> so adjust mode shows the cropped version of the photo, not the
  // uncropped full preview. Without this the user sees the whole image
  // with their crop effectively hidden — confusing because the main viewer
  // (and the saved result) do show the cropped version.
  let cropViewBox = $derived.by(() => {
    const cropEdit = transformManager.edits.find((e) => e.action === AssetEditAction.Crop);
    if (!cropEdit) {
      return 'none';
    }
    const p = cropEdit.parameters as CropParameters;
    const oW = transformManager.originalImageSize.width;
    const oH = transformManager.originalImageSize.height;
    if (!oW || !oH || !p.width || !p.height) {
      return 'none';
    }
    const top = (p.y / oH) * 100;
    const left = (p.x / oW) * 100;
    const right = ((oW - p.x - p.width) / oW) * 100;
    const bottom = ((oH - p.y - p.height) / oH) * 100;
    // Clamp tiny negatives that come from rounding so the browser accepts the value.
    const clamp = (n: number) => Math.max(0, Math.min(100, n));
    return `inset(${clamp(top)}% ${clamp(right)}% ${clamp(bottom)}% ${clamp(left)}%)`;
  });

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
    style="filter: url(#adjust-filter); object-view-box: {cropViewBox};"
    draggable="false"
  />
</div>
