<script lang="ts">
  import { adjustManager, type AdjustmentValues } from '$lib/managers/edit/adjust-manager.svelte';
  import { t } from 'svelte-i18n';
  import {
    mdiBrightness6,
    mdiCircle,
    mdiCircleOutline,
    mdiContrastCircle,
    mdiDelete,
    mdiGradientHorizontal,
    mdiPalette,
    mdiPlus,
    mdiThermometer,
    mdiWaterOutline,
    mdiWeatherNight,
    mdiWhiteBalanceSunny,
  } from '@mdi/js';
  import { Icon } from '@immich/ui';
  import AdjustSlider from './adjust-slider.svelte';

  interface SliderConfig {
    key: keyof AdjustmentValues;
    icon: string;
    labelKey: string;
  }

  const lightSliders: SliderConfig[] = [
    { key: 'brightness', icon: mdiBrightness6, labelKey: 'adjust_brightness' },
    { key: 'contrast', icon: mdiContrastCircle, labelKey: 'adjust_contrast' },
    { key: 'highlights', icon: mdiWhiteBalanceSunny, labelKey: 'adjust_highlights' },
    { key: 'shadows', icon: mdiWeatherNight, labelKey: 'adjust_shadows' },
    { key: 'whitePoint', icon: mdiCircleOutline, labelKey: 'adjust_white_point' },
    { key: 'blackPoint', icon: mdiCircle, labelKey: 'adjust_black_point' },
  ];

  const colorSliders: SliderConfig[] = [
    { key: 'saturation', icon: mdiWaterOutline, labelKey: 'adjust_saturation' },
    { key: 'warmth', icon: mdiThermometer, labelKey: 'adjust_warmth' },
    { key: 'tint', icon: mdiPalette, labelKey: 'adjust_tint' },
  ];

  let selectedIndex = $derived(adjustManager.selectedMaskIndex);
  let masks = $derived(adjustManager.masks);
  let active = $derived(adjustManager.activeSliders);

  const maskLabel = (mask: { kind: 'linear' | 'radial' }, i: number): string =>
    `${mask.kind === 'linear' ? 'Linear' : 'Radial'} mask ${i + 1}`;
</script>

<div class="mt-3 px-4 overflow-y-auto max-h-[calc(100vh-200px)]">
  <!-- Masks section -->
  <div class="flex h-10 w-full items-center justify-between text-sm mt-2">
    <h2>Masks</h2>
    <div class="flex gap-1">
      <button
        type="button"
        class="flex items-center gap-1 rounded px-2 py-1 text-xs hover:bg-immich-bg-hover"
        onclick={() => adjustManager.addLinearMask()}
        disabled={masks.length >= 8}
        aria-label="Add linear gradient mask"
      >
        <Icon icon={mdiGradientHorizontal} size="14" />
        <span>Linear</span>
      </button>
      <button
        type="button"
        class="flex items-center gap-1 rounded px-2 py-1 text-xs hover:bg-immich-bg-hover"
        onclick={() => adjustManager.addRadialMask()}
        disabled={masks.length >= 8}
        aria-label="Add radial mask"
      >
        <Icon icon={mdiCircleOutline} size="14" />
        <span>Radial</span>
      </button>
    </div>
  </div>

  {#if masks.length > 0}
    <ul class="flex flex-col gap-1 mb-2">
      <li>
        <button
          type="button"
          class="flex w-full items-center justify-between rounded px-2 py-1 text-xs"
          class:bg-immich-primary={selectedIndex === null}
          class:text-immich-bg={selectedIndex === null}
          class:hover:bg-immich-bg-hover={selectedIndex !== null}
          onclick={() => adjustManager.selectMask(null)}
        >
          <span>Global</span>
        </button>
      </li>
      {#each masks as mask, i (i)}
        <li class="flex items-center gap-1">
          <button
            type="button"
            class="flex flex-1 items-center justify-between rounded px-2 py-1 text-xs"
            class:bg-immich-primary={selectedIndex === i}
            class:text-immich-bg={selectedIndex === i}
            class:hover:bg-immich-bg-hover={selectedIndex !== i}
            onclick={() => adjustManager.selectMask(i)}
          >
            <span>{maskLabel(mask, i)}</span>
          </button>
          <button
            type="button"
            class="rounded p-1 text-immich-fg hover:bg-immich-bg-hover"
            onclick={() => adjustManager.removeMask(i)}
            aria-label={`Delete ${maskLabel(mask, i)}`}
          >
            <Icon icon={mdiDelete} size="14" />
          </button>
        </li>
      {/each}
    </ul>
  {/if}

  <!-- Light sliders -->
  <div class="flex h-10 w-full items-center justify-between text-sm mt-2">
    <h2>{$t('adjust_light')}{selectedIndex !== null ? ` (${maskLabel(masks[selectedIndex], selectedIndex)})` : ''}</h2>
  </div>

  {#each lightSliders as slider (slider.key)}
    <AdjustSlider
      icon={slider.icon}
      label={$t(slider.labelKey)}
      value={active[slider.key]}
      onchange={(v) => adjustManager.setValue(slider.key, v)}
    />
  {/each}

  <!-- Color sliders -->
  <div class="flex h-10 w-full items-center justify-between text-sm mt-4">
    <h2>{$t('adjust_color')}</h2>
  </div>

  {#each colorSliders as slider (slider.key)}
    <AdjustSlider
      icon={slider.icon}
      label={$t(slider.labelKey)}
      value={active[slider.key]}
      onchange={(v) => adjustManager.setValue(slider.key, v)}
    />
  {/each}
</div>
