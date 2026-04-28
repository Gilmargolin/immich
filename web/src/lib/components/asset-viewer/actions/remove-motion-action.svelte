<script lang="ts">
  import MenuOption from '$lib/components/shared-components/context-menu/menu-option.svelte';
  import { deleteAssets, updateAsset, type AssetResponseDto } from '@immich/sdk';
  import { ConfirmModal, modalManager, toastManager } from '@immich/ui';
  import { mdiVideoOffOutline } from '@mdi/js';

  // Strips the motion video off a Live Photo. Sequence:
  //   1. updateAsset({ livePhotoVideoId: null })
  //      Server's onBeforeUnlink restores motion visibility to its previous
  //      state, then update sets the link to null. The still asset survives
  //      with no motion attached.
  //   2. deleteAssets({ ids: [motionId] })
  //      Soft-delete (move to trash) the now-orphaned motion video so it
  //      stops eating storage. Recoverable via trash for ~30 days.
  //
  // Asset state refresh comes via the asset-viewer's websocket on_asset_update
  // listener, so we don't have to thread a callback through.

  interface Props {
    asset: AssetResponseDto;
  }

  let { asset }: Props = $props();

  const handleRemove = async () => {
    if (!asset.livePhotoVideoId) {
      return;
    }
    const confirmed = await modalManager.show(ConfirmModal, {
      title: 'Remove motion video?',
      prompt: 'The motion video will be moved to trash and the photo will become a still. You can restore it from trash if you change your mind.',
      confirmText: 'Remove',
    });
    if (!confirmed) {
      return;
    }
    const motionId = asset.livePhotoVideoId;
    try {
      await updateAsset({ id: asset.id, updateAssetDto: { livePhotoVideoId: null } });
      await deleteAssets({ assetBulkDeleteDto: { ids: [motionId] } });
      toastManager.primary('Motion video moved to trash.');
    } catch (err) {
      console.error('Failed to remove motion video', err);
      toastManager.danger('Failed to remove motion video.');
    }
  };
</script>

{#if asset.livePhotoVideoId}
  <MenuOption icon={mdiVideoOffOutline} text="Remove motion video" onClick={handleRemove} />
{/if}
