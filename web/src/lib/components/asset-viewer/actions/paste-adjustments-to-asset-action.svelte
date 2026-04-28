<script lang="ts">
  import MenuOption from '$lib/components/shared-components/context-menu/menu-option.svelte';
  import { editsClipboard } from '$lib/managers/edit/edits-clipboard.svelte';
  import { editAsset, type AssetResponseDto } from '@immich/sdk';
  import { toastManager } from '@immich/ui';
  import { mdiContentPaste } from '@mdi/js';

  // Single-asset version of PasteAdjustmentsAction (which lives in the
  // multi-select toolbar). Mounted inside the asset viewer's overflow menu
  // so the user can paste copied adjustments to the currently-open photo
  // without having to multi-select first.

  interface Props {
    asset: AssetResponseDto;
  }

  let { asset }: Props = $props();

  const handlePaste = async () => {
    if (!editsClipboard.hasContent) {
      toastManager.warning('No adjustments copied yet — open an image, tweak sliders, then click Copy.');
      return;
    }
    if (asset.id === editsClipboard.sourceAssetId) {
      toastManager.warning('This is the source image — nothing to paste.');
      return;
    }
    const edits = editsClipboard.getEdits(true);
    if (!edits) {
      return;
    }
    try {
      await editAsset({ id: asset.id, assetEditsCreateDto: { edits } });
      toastManager.primary('Adjustments pasted.');
    } catch (err) {
      console.error('Failed to paste adjustments', err);
      toastManager.danger('Failed to paste adjustments.');
    }
  };
</script>

{#if editsClipboard.hasContent && asset.id !== editsClipboard.sourceAssetId}
  <MenuOption icon={mdiContentPaste} text="Paste adjustments" onClick={handlePaste} />
{/if}
