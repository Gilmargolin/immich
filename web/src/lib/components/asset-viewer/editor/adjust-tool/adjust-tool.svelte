<script lang="ts">
  import { adjustManager, type AdjustmentValues } from '$lib/managers/edit/adjust-manager.svelte';
  import { t } from 'svelte-i18n';
  import {
    mdiBrightness6,
    mdiContrastCircle,
    mdiWaterOutline,
    mdiThermometer,
    mdiPalette,
    mdiWhiteBalanceSunny,
    mdiWeatherNight,
    mdiCircleOutline,
    mdiCircle,
  } from '@mdi/js';
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
</script>

<div class="mt-3 px-4 overflow-y-auto max-h-[calc(100vh-200px)]">
  <div class="flex h-10 w-full items-center justify-between text-sm mt-2">
    <h2>{$t('adjust_light')}</h2>
  </div>

  {#each lightSliders as slider (slider.key)}
    <AdjustSlider
      icon={slider.icon}
      label={$t(slider.labelKey)}
      value={adjustManager.values[slider.key]}
      onchange={(v) => adjustManager.setValue(slider.key, v)}
    />
  {/each}

  <div class="flex h-10 w-full items-center justify-between text-sm mt-4">
    <h2>{$t('adjust_color')}</h2>
  </div>

  {#each colorSliders as slider (slider.key)}
    <AdjustSlider
      icon={slider.icon}
      label={$t(slider.labelKey)}
      value={adjustManager.values[slider.key]}
      onchange={(v) => adjustManager.setValue(slider.key, v)}
    />
  {/each}
</div>
