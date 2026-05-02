<script lang="ts">
  import { shortcuts } from '$lib/actions/shortcut';
  import { editManager, EditToolType } from '$lib/managers/edit/edit-manager.svelte';
  import { adjustManager, type AdjustmentValues } from '$lib/managers/edit/adjust-manager.svelte';
  import { editsClipboard } from '$lib/managers/edit/edits-clipboard.svelte';
  import { transformManager } from '$lib/managers/edit/transform-manager.svelte';
  import { websocketEvents } from '$lib/stores/websocket';
  import { getAssetEdits, type AssetResponseDto } from '@immich/sdk';
  import { Button, HStack, Icon, IconButton, toastManager } from '@immich/ui';
  import {
    mdiClose,
    mdiContentCopy,
    mdiCrop,
    mdiDelete,
    mdiEye,
    mdiFlipHorizontal,
    mdiFlipVertical,
    mdiGradientHorizontal,
    mdiInvertColors,
    mdiPencilOutline,
    mdiRotateLeft,
    mdiRotateRight,
  } from '@mdi/js';
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
  import { onDestroy, onMount } from 'svelte';
  import { t } from 'svelte-i18n';
  import AdjustSlider from './adjust-tool/adjust-slider.svelte';

  onMount(() => {
    return websocketEvents.on('on_asset_update', (assetUpdate) => {
      if (assetUpdate.id === asset.id) {
        asset = assetUpdate;
      }
    });
  });

  interface Props {
    asset: AssetResponseDto;
    onClose: () => void;
  }

  onMount(async () => {
    const editsData = await getAssetEdits({ id: asset.id });
    await editManager.initializeAllTools(asset, editsData);
    // Always open in crop mode so the CropArea viewer is visible. CropArea
    // renders the photo with both the crop frame overlay AND the live SVG
    // filter for color/light adjustments, so nothing is lost by staying
    // here while the user moves sliders.
    editManager.isCropMode = true;
  });

  onDestroy(() => {
    editManager.cleanup();
  });

  async function applyEdits() {
    const success = await editManager.applyEdits();
    if (success) {
      onClose();
    }
  }

  function copyAdjustments() {
    editsClipboard.copy(asset.id, adjustManager.edits);
    toastManager.primary('Adjustments copied — multi-select photos to paste them.');
  }

  const maskLabel = (mask: { kind: 'linear' | 'radial' }, i: number): string =>
    `${mask.kind === 'linear' ? 'Linear' : 'Radial'} mask ${i + 1}`;

  async function closeEditor() {
    if (await editManager.closeConfirm()) {
      onClose();
    }
  }

  let { asset = $bindable(), onClose }: Props = $props();

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
    { key: 'whitePoint', icon: mdiCircle, labelKey: 'adjust_white_point' },
    { key: 'blackPoint', icon: mdiCircleOutline, labelKey: 'adjust_black_point' },
  ];

  const colorSliders: SliderConfig[] = [
    { key: 'saturation', icon: mdiWaterOutline, labelKey: 'adjust_saturation' },
    { key: 'warmth', icon: mdiThermometer, labelKey: 'adjust_warmth' },
    { key: 'tint', icon: mdiPalette, labelKey: 'adjust_tint' },
  ];

  let isRotated = $derived(transformManager.normalizedRotation % 180 !== 0);

  interface AspectRatioOption {
    label: string;
    value: string;
    width?: number;
    height?: number;
    isFree?: boolean;
  }

  const aspectRatiosRow1: AspectRatioOption[] = [
    { label: $t('crop_aspect_ratio_free'), value: 'free', isFree: true },
    { label: '16:9', value: '16:9' },
    { label: '3:2', value: '3:2' },
    { label: '4:3', value: '4:3' },
    { label: '5:4', value: '5:4' },
  ];

  const aspectRatiosRow2: AspectRatioOption[] = [
    { label: $t('crop_aspect_ratio_original'), value: 'original' },
    { label: '9:16', value: '9:16' },
    { label: '2:3', value: '2:3' },
    { label: '3:4', value: '3:4' },
    { label: '4:5', value: '4:5' },
  ];

  const squareRatio: AspectRatioOption = { label: $t('crop_aspect_ratio_square'), value: '1:1' };

  function rotatedRatio(ratio: AspectRatioOption): string {
    if (ratio.value === 'free') return ratio.value;
    if (isRotated) {
      let [w, h] = ratio.value.split(':');
      return `${h}:${w}`;
    }
    return ratio.value;
  }

  function ratioSelected(ratio: AspectRatioOption): boolean {
    return transformManager.cropAspectRatio === rotatedRatio(ratio);
  }

  function selectAspectRatio(ratio: AspectRatioOption) {
    let appliedRatio;
    if (ratio.value === 'original') {
      const { width, height } = transformManager.cropImageSize;
      appliedRatio = `${width}:${height}`;
    } else {
      appliedRatio = rotatedRatio(ratio);
    }
    transformManager.setAspectRatio(appliedRatio);
  }

  function enterCropMode() {
    editManager.isCropMode = true;
  }

  function exitCropMode() {
    editManager.isCropMode = false;
  }

  async function rotateImage(degrees: number) {
    enterCropMode();
    await transformManager.rotate(degrees);
  }

  function mirrorImage(axis: 'horizontal' | 'vertical') {
    enterCropMode();
    transformManager.mirror(axis);
  }

  function selectAspectRatioAndCrop(ratio: AspectRatioOption) {
    enterCropMode();
    selectAspectRatio(ratio);
  }
</script>

<svelte:document
  use:shortcuts={[
    { shortcut: { key: 'Escape' }, onShortcut: onClose },
    { shortcut: { key: 'Enter' }, onShortcut: applyEdits },
  ]}
/>

<section class="relative flex flex-col h-full p-2 dark:bg-immich-dark-bg dark:text-immich-dark-fg dark pt-3">
  <HStack class="justify-between me-4">
    <HStack>
      <IconButton
        shape="round"
        variant="ghost"
        color="secondary"
        icon={mdiClose}
        aria-label={$t('close')}
        onclick={closeEditor}
      />
      <p class="text-lg text-immich-fg dark:text-immich-dark-fg capitalize">{$t('editor')}</p>
    </HStack>
    <HStack class="gap-1">
      <!-- Hold-to-compare: while pressed, the editor area shows the saved
           version of the asset (server-rendered, with previously-applied
           edits). Uses pointer capture so a release outside the button still
           toggles the overlay back off. -->
      <button
        type="button"
        class="rounded-full p-1.5 hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors {editManager.showOriginal ? 'bg-gray-300 dark:bg-gray-600' : ''}"
        aria-label="Hold to see saved version"
        title="Hold to compare against saved version"
        onpointerdown={(e) => {
          (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
          editManager.showOriginal = true;
        }}
        onpointerup={() => {
          editManager.showOriginal = false;
        }}
        onpointercancel={() => {
          editManager.showOriginal = false;
        }}
        onpointerleave={() => {
          editManager.showOriginal = false;
        }}
      >
        <Icon icon={mdiEye} size="20" />
      </button>
      <IconButton
        shape="round"
        size="small"
        variant="ghost"
        color={editManager.isCropMode ? 'primary' : 'secondary'}
        icon={mdiCrop}
        aria-label="Toggle crop mode"
        title="Crop mode"
        onclick={() => (editManager.isCropMode ? exitCropMode() : enterCropMode())}
      />
      <IconButton
        shape="round"
        size="small"
        variant="ghost"
        color="secondary"
        icon={mdiContentCopy}
        aria-label="Copy adjustments to clipboard"
        title="Copy adjustments (paste to multi-selected images)"
        onclick={copyAdjustments}
        disabled={adjustManager.edits.length === 0}
      />
      <Button shape="round" size="small" onclick={applyEdits} loading={editManager.isApplyingEdits}>{$t('save')}</Button>
    </HStack>
  </HStack>

  <div class="flex-1 overflow-y-auto px-3 mt-2">
    <!-- Orientation (compact) -->
    <h2 class="text-xs font-medium text-gray-400 uppercase tracking-wide mt-2 mb-1">{$t('editor_orientation')}</h2>
    <div class="flex gap-1">
      <IconButton
        size="tiny"
        aria-label={$t('editor_rotate_left')}
        icon={mdiRotateLeft}
        onclick={() => rotateImage(-90)}
      />
      <IconButton
        size="tiny"
        aria-label={$t('editor_rotate_right')}
        icon={mdiRotateRight}
        onclick={() => rotateImage(90)}
      />
      <IconButton
        size="tiny"
        aria-label={$t('editor_flip_horizontal')}
        icon={mdiFlipHorizontal}
        onclick={() => mirrorImage('horizontal')}
      />
      <IconButton
        size="tiny"
        aria-label={$t('editor_flip_vertical')}
        icon={mdiFlipVertical}
        onclick={() => mirrorImage('vertical')}
      />
    </div>

    <!-- Crop (compact) -->
    <h2 class="text-xs font-medium text-gray-400 uppercase tracking-wide mt-3 mb-1">{$t('crop')}</h2>
    <div class="grid grid-cols-[auto_repeat(4,1fr)_auto] grid-rows-2 gap-1 mb-3">
      {#each aspectRatiosRow1 as ratio (ratio.value)}
        <button
          class="py-1 text-xs rounded-md transition-colors text-center
            {ratio.isFree ? 'min-w-[4.5rem]' : 'px-2'}
            {ratioSelected(ratio)
            ? 'bg-immich-primary text-black'
            : 'bg-gray-700 text-gray-300 hover:bg-gray-600'}"
          onclick={() => selectAspectRatioAndCrop(ratio)}
          aria-label={ratio.label}
        >
          {ratio.label}
        </button>
      {/each}
      <button
        class="row-span-2 px-2 py-1 text-xs rounded-md transition-colors text-center aspect-square
          {ratioSelected(squareRatio)
          ? 'bg-immich-primary text-black'
          : 'bg-gray-700 text-gray-300 hover:bg-gray-600'}"
        onclick={() => selectAspectRatioAndCrop(squareRatio)}
        aria-label={squareRatio.label}
      >
        {squareRatio.label}
      </button>
      {#each aspectRatiosRow2 as ratio (ratio.value)}
        <button
          class="py-1 text-xs rounded-md transition-colors text-center
            {ratio.value === 'original' ? 'min-w-[4.5rem]' : 'px-2'}
            {ratioSelected(ratio)
            ? 'bg-immich-primary text-black'
            : 'bg-gray-700 text-gray-300 hover:bg-gray-600'}"
          onclick={() => selectAspectRatioAndCrop(ratio)}
          aria-label={ratio.label}
        >
          {ratio.label}
        </button>
      {/each}
    </div>

    <!-- Divider -->
    <hr class="border-gray-700 my-3" />

    <!-- Local masks -->
    <div class="flex items-center justify-between mb-1">
      <h2 class="text-xs font-medium text-gray-400 uppercase tracking-wide">Masks</h2>
      <div class="flex gap-1">
        <button
          type="button"
          class="flex items-center gap-1 rounded px-2 py-0.5 text-xs hover:bg-gray-700 disabled:opacity-50 disabled:cursor-not-allowed
            {adjustManager.pendingMaskKind === 'linear' ? 'bg-immich-primary text-black' : 'text-gray-300 hover:text-white'}"
          onclick={() => {
            if (adjustManager.pendingMaskKind === 'linear') {
              adjustManager.cancelDrawingMask();
            } else {
              exitCropMode();
              adjustManager.startDrawingMask('linear');
            }
          }}
          disabled={adjustManager.masks.length >= 8}
          aria-label="Draw linear gradient mask"
          title="Click, then drag on the photo to define the gradient"
        >
          <Icon icon={mdiGradientHorizontal} size="14" />
          <span>Linear</span>
        </button>
        <button
          type="button"
          class="flex items-center gap-1 rounded px-2 py-0.5 text-xs hover:bg-gray-700 disabled:opacity-50 disabled:cursor-not-allowed
            {adjustManager.pendingMaskKind === 'radial' ? 'bg-immich-primary text-black' : 'text-gray-300 hover:text-white'}"
          onclick={() => {
            if (adjustManager.pendingMaskKind === 'radial') {
              adjustManager.cancelDrawingMask();
            } else {
              exitCropMode();
              adjustManager.startDrawingMask('radial');
            }
          }}
          disabled={adjustManager.masks.length >= 8}
          aria-label="Draw radial mask"
          title="Click, then drag on the photo from center outward"
        >
          <Icon icon={mdiCircleOutline} size="14" />
          <span>Radial</span>
        </button>
      </div>
    </div>

    {#if adjustManager.masks.length > 0}
      <ul class="flex flex-col gap-0.5 mb-2">
        <li>
          <button
            type="button"
            class="flex w-full items-center justify-between rounded px-2 py-1 text-xs
              {adjustManager.selectedMaskIndex === null
                ? 'bg-immich-primary text-black'
                : 'text-gray-300 hover:bg-gray-700'}"
            onclick={() => adjustManager.selectMask(null)}
          >
            <span>Global</span>
          </button>
        </li>
        {#each adjustManager.masks as mask, i (i)}
          <li class="flex items-center gap-1">
            <button
              type="button"
              class="flex flex-1 items-center justify-between rounded px-2 py-1 text-xs
                {adjustManager.selectedMaskIndex === i
                  ? 'bg-immich-primary text-black'
                  : 'text-gray-300 hover:bg-gray-700'}"
              onclick={() => {
                exitCropMode();
                adjustManager.selectMask(i);
              }}
              title="Select for slider editing"
            >
              <span>{maskLabel(mask, i)}</span>
            </button>
            <button
              type="button"
              class="rounded p-1 hover:bg-gray-700
                {adjustManager.editingMaskIndex === i ? 'text-immich-primary' : 'text-gray-300 hover:text-white'}"
              onclick={() => {
                exitCropMode();
                adjustManager.toggleEditingMask(i);
              }}
              aria-label={`Edit geometry of ${maskLabel(mask, i)}`}
              title="Edit position / shape"
            >
              <Icon icon={mdiPencilOutline} size="14" />
            </button>
            {#if mask.kind === 'radial'}
              <button
                type="button"
                class="rounded p-1 hover:bg-gray-700
                  {mask.invert ? 'text-immich-primary' : 'text-gray-300 hover:text-white'}"
                onclick={() => adjustManager.updateMask(i, { ...mask, invert: !mask.invert })}
                aria-label={`Invert ${maskLabel(mask, i)}`}
                title={mask.invert ? 'Invert: applies outside (click to flip)' : 'Invert: applies inside (click to flip)'}
              >
                <Icon icon={mdiInvertColors} size="14" />
              </button>
            {/if}
            <button
              type="button"
              class="rounded p-1 text-gray-300 hover:text-white hover:bg-gray-700"
              onclick={() => adjustManager.removeMask(i)}
              aria-label={`Delete ${maskLabel(mask, i)}`}
            >
              <Icon icon={mdiDelete} size="14" />
            </button>
          </li>
        {/each}
      </ul>
    {/if}

    <!-- Light adjustments -->
    <h2 class="text-xs font-medium text-gray-400 uppercase tracking-wide mb-1 mt-2">
      {$t('adjust_light')}{adjustManager.selectedMaskIndex !== null
        ? ` — ${maskLabel(adjustManager.masks[adjustManager.selectedMaskIndex], adjustManager.selectedMaskIndex)}`
        : ''}
    </h2>
    {#each lightSliders as slider (slider.key)}
      <AdjustSlider
        icon={slider.icon}
        label={$t(slider.labelKey)}
        value={adjustManager.activeSliders[slider.key]}
        onchange={(v) => adjustManager.setValue(slider.key, v)}
      />
    {/each}

    <!-- Color adjustments -->
    <h2 class="text-xs font-medium text-gray-400 uppercase tracking-wide mt-3 mb-1">{$t('adjust_color')}</h2>
    {#each colorSliders as slider (slider.key)}
      <AdjustSlider
        icon={slider.icon}
        label={$t(slider.labelKey)}
        value={adjustManager.activeSliders[slider.key]}
        onchange={(v) => adjustManager.setValue(slider.key, v)}
      />
    {/each}
  </div>

  <section class="px-4 pb-3 pt-2">
    <Button
      variant="outline"
      onclick={() => editManager.resetAllChanges()}
      disabled={!editManager.canReset}
      class="self-start"
      shape="round"
      size="small"
    >
      {$t('editor_reset_all_changes')}
    </Button>
  </section>
</section>
