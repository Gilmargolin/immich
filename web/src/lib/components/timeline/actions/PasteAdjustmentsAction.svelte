<script lang="ts">
  import MenuOption from '$lib/components/shared-components/context-menu/menu-option.svelte';
  import { assetMultiSelectManager } from '$lib/managers/asset-multi-select-manager.svelte';
  import { editsClipboard } from '$lib/managers/edit/edits-clipboard.svelte';
  import { editAsset } from '@immich/sdk';
  import { IconButton, toastManager } from '@immich/ui';
  import { mdiContentPaste, mdiTimerSand } from '@mdi/js';

  type Props = {
    menuItem?: boolean;
  };

  let { menuItem = false }: Props = $props();

  let loading = $state(false);

  // Cap concurrent edit-asset PUTs so we don't slam the server with hundreds
  // of parallel renders. 6 is a reasonable browser-side limit (matches the
  // typical browser's per-origin connection cap).
  const CONCURRENCY = 6;

  const handlePaste = async () => {
    if (!editsClipboard.hasContent) {
      toastManager.warning('No adjustments copied yet — open an image, tweak sliders, then click Copy.');
      return;
    }

    const assets = assetMultiSelectManager.getOwnedAssets();
    const targetIds = assets.map((a) => a.id).filter((id) => id !== editsClipboard.sourceAssetId);
    if (targetIds.length === 0) {
      toastManager.warning('Select at least one image to paste into.');
      return;
    }

    // Default: include masks. Future: a confirm modal with a checkbox.
    const edits = editsClipboard.getEdits(true);
    if (!edits) {
      return;
    }

    loading = true;
    let succeeded = 0;
    let failed = 0;

    // Simple worker-pool: kick off CONCURRENCY in flight, replace each as it
    // finishes. Keeps the loop bounded without needing an external library.
    let nextIndex = 0;
    const runOne = async (): Promise<void> => {
      while (nextIndex < targetIds.length) {
        const i = nextIndex++;
        try {
          await editAsset({ id: targetIds[i], assetEditsCreateDto: { edits } });
          succeeded++;
        } catch (err) {
          console.error('Failed to paste adjustments to', targetIds[i], err);
          failed++;
        }
      }
    };
    const workers = Array.from({ length: Math.min(CONCURRENCY, targetIds.length) }, () => runOne());
    await Promise.all(workers);

    loading = false;
    assetMultiSelectManager.clear();

    if (failed === 0) {
      toastManager.primary(`Adjustments pasted to ${succeeded} image${succeeded === 1 ? '' : 's'}.`);
    } else {
      toastManager.warning(`Pasted to ${succeeded}, ${failed} failed.`);
    }
  };
</script>

{#if menuItem}
  <MenuOption text="Paste adjustments" icon={mdiContentPaste} onClick={handlePaste} />
{:else if loading}
  <IconButton
    shape="round"
    color="secondary"
    variant="ghost"
    aria-label="Pasting"
    icon={mdiTimerSand}
    onclick={() => {}}
  />
{:else}
  <IconButton
    shape="round"
    color="secondary"
    variant="ghost"
    aria-label="Paste adjustments"
    title="Paste copied adjustments to selection"
    icon={mdiContentPaste}
    onclick={handlePaste}
    disabled={!editsClipboard.hasContent}
  />
{/if}
