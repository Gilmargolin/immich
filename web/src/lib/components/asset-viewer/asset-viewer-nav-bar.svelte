<script lang="ts">
  import { goto } from '$app/navigation';
  import ActionMenuItem from '$lib/components/ActionMenuItem.svelte';
  import type { OnAction, PreAction } from '$lib/components/asset-viewer/actions/action';
  import AddToStackAction from '$lib/components/asset-viewer/actions/add-to-stack-action.svelte';
  import ArchiveAction from '$lib/components/asset-viewer/actions/archive-action.svelte';
  import DeleteAction from '$lib/components/asset-viewer/actions/delete-action.svelte';
  import KeepThisDeleteOthersAction from '$lib/components/asset-viewer/actions/keep-this-delete-others.svelte';
  import PasteAdjustmentsToAssetAction from '$lib/components/asset-viewer/actions/paste-adjustments-to-asset-action.svelte';
  import RatingAction from '$lib/components/asset-viewer/actions/rating-action.svelte';
  import RemoveAssetFromStack from '$lib/components/asset-viewer/actions/remove-asset-from-stack.svelte';
  import RemoveMotionAction from '$lib/components/asset-viewer/actions/remove-motion-action.svelte';
  import RemoveFromAlbumAction from '$lib/components/timeline/actions/RemoveFromAlbumAction.svelte';
  import RestoreAction from '$lib/components/asset-viewer/actions/restore-action.svelte';
  import SetAlbumCoverAction from '$lib/components/asset-viewer/actions/set-album-cover-action.svelte';
  import SetFeaturedPhotoAction from '$lib/components/asset-viewer/actions/set-person-featured-action.svelte';
  import SetProfilePictureAction from '$lib/components/asset-viewer/actions/set-profile-picture-action.svelte';
  import SetStackPrimaryAsset from '$lib/components/asset-viewer/actions/set-stack-primary-asset.svelte';
  import SetVisibilityAction from '$lib/components/asset-viewer/actions/set-visibility-action.svelte';
  import UnstackAction from '$lib/components/asset-viewer/actions/unstack-action.svelte';
  import LoadingDots from '$lib/components/LoadingDots.svelte';
  import ButtonContextMenu from '$lib/components/shared-components/context-menu/button-context-menu.svelte';
  import MenuOption from '$lib/components/shared-components/context-menu/menu-option.svelte';
  import { assetViewerManager } from '$lib/managers/asset-viewer-manager.svelte';
  import { featureFlagsManager } from '$lib/managers/feature-flags-manager.svelte';
  import { languageManager } from '$lib/managers/language-manager.svelte';
  import { Route } from '$lib/route';
  import { getGlobalActions } from '$lib/services/app.service';
  import { getAssetActions } from '$lib/services/asset.service';
  import { user } from '$lib/stores/user.store';
  import { getSharedLink, withoutIcons } from '$lib/utils';
  import type { OnUndoDelete } from '$lib/utils/actions';
  import { toTimelineAsset } from '$lib/utils/timeline-util';
  import {
    AssetTypeEnum,
    AssetVisibility,
    type AlbumResponseDto,
    type AssetResponseDto,
    type PersonResponseDto,
    type StackResponseDto,
  } from '@immich/sdk';
  import { ActionButton, CommandPaletteDefaultProvider, Tooltip, type ActionItem } from '@immich/ui';
  import { mdiArrowLeft, mdiArrowRight, mdiDotsVertical } from '@mdi/js';
  import { t } from 'svelte-i18n';

  interface Props {
    asset: AssetResponseDto;
    album?: AlbumResponseDto | null;
    person?: PersonResponseDto | null;
    stack?: StackResponseDto | null;
    showSlideshow?: boolean;
    preAction: PreAction;
    onAction: OnAction;
    onUndoDelete?: OnUndoDelete;
    onPlaySlideshow: () => void;
    onClose?: () => void;
    onRemoveFromAlbum?: (assetIds: string[]) => void;
    playOriginalVideo: boolean;
    setPlayOriginalVideo: (value: boolean) => void;
  }

  let {
    asset,
    album = null,
    person = null,
    stack = null,
    showSlideshow = false,
    preAction,
    onAction,
    onUndoDelete = undefined,
    onPlaySlideshow,
    onClose,
    onRemoveFromAlbum,
    playOriginalVideo = false,
    setPlayOriginalVideo,
  }: Props = $props();

  const isOwner = $derived($user && asset.ownerId === $user?.id);
  const isAlbumOwner = $derived($user && album?.ownerId === $user?.id);
  const isLocked = $derived(asset.visibility === AssetVisibility.Locked);
  const smartSearchEnabled = $derived(featureFlagsManager.value.smartSearch);

  const { Cast } = $derived(getGlobalActions($t));

  const Close: ActionItem = $derived({
    title: $t('go_back'),
    type: $t('assets'),
    icon: languageManager.rtl ? mdiArrowRight : mdiArrowLeft,
    $if: () => !!onClose && !assetViewerManager.isFaceEditMode,
    onAction: () => onClose?.(),
    shortcuts: [{ key: 'Escape' }],
  });

  const Actions = $derived(getAssetActions($t, asset));
  const sharedLink = getSharedLink();
</script>

<CommandPaletteDefaultProvider name={$t('assets')} actions={withoutIcons([Close, Cast, ...Object.values(Actions)])} />

<div
  class="flex h-16 place-items-center justify-between bg-linear-to-b from-black/40 px-3 transition-transform duration-200 drop-shadow-[0_0_1px_rgba(0,0,0,0.4)]"
>
  <div class="dark">
    <ActionButton action={Close} />
  </div>

  <div
    class="flex p-1 -m-1 items-center gap-2 overflow-x-auto *:shrink-0 dark"
    data-testid="asset-viewer-navbar-actions"
  >
    {#if assetViewerManager.isImageLoading}
      <Tooltip text={$t('loading')}>
        {#snippet child({ props })}
          <div {...props} role="status" aria-label={$t('loading')}>
            <LoadingDots class="me-1" />
          </div>
        {/snippet}
      </Tooltip>
    {/if}

    <!-- The visible top-right cluster has been trimmed down to four
         everyday-use buttons + the overflow menu. Everything else is
         reachable from the menu and via single-letter shortcuts (registered
         on the action items themselves and bound by the CommandPalette
         provider just below). DeleteAction is mounted but invisible — it
         only registers the Delete-key shortcut. -->
    <ActionButton action={Actions.Edit} />
    <ActionButton action={Actions.Favorite} />
    <ActionButton action={Actions.Unfavorite} />
    <ActionButton action={Actions.Info} />

    {#if sharedLink}
      <!-- Shared-link viewers don't get the overflow menu, so keep their
           one-click download visible inline. -->
      <ActionButton action={Actions.SharedLinkDownload} />
    {/if}

    {#if isOwner}
      <div class="hidden">
        <DeleteAction {asset} {onAction} {preAction} {onUndoDelete} />
      </div>
    {/if}

    {#if !sharedLink}
      <ButtonContextMenu direction="left" align="top-right" color="secondary" title={$t('more')} icon={mdiDotsVertical} compact>
        <!-- View -->
        <li class="px-4 pt-3 pb-1 text-[10px] font-semibold uppercase tracking-wider text-gray-500 select-none">View</li>
        {#if showSlideshow && !isLocked}
          <MenuOption text={$t('slideshow')} shortcutLabel="S" onClick={onPlaySlideshow} />
        {/if}
        <ActionMenuItem action={Cast} />
        <ActionMenuItem action={Actions.ZoomIn} />
        <ActionMenuItem action={Actions.ZoomOut} />
        <ActionMenuItem action={Actions.PlayMotionPhoto} />
        <ActionMenuItem action={Actions.StopMotionPhoto} />
        {#if asset.type === AssetTypeEnum.Video}
          <MenuOption
            onClick={() => setPlayOriginalVideo(!playOriginalVideo)}
            text={playOriginalVideo ? 'Transcoded video' : 'Original video'}
          />
        {/if}

        <!-- Share -->
        <li class="px-4 pt-3 pb-1 text-[10px] font-semibold uppercase tracking-wider text-gray-500 select-none">Share</li>
        <ActionMenuItem action={Actions.Share} />
        <ActionMenuItem action={Actions.Download} />
        <ActionMenuItem action={Actions.DownloadOriginal} />

        <!-- Organize -->
        <li class="px-4 pt-3 pb-1 text-[10px] font-semibold uppercase tracking-wider text-gray-500 select-none">Organize</li>
        <ActionMenuItem action={Actions.AddToAlbum} />
        {#if album && (isOwner || isAlbumOwner)}
          <RemoveFromAlbumAction {album} onRemove={onRemoveFromAlbum} assetIds={[asset.id]} menuItem />
        {/if}
        {#if isOwner}
          <AddToStackAction {asset} {stack} {onAction} />
          {#if stack}
            <UnstackAction {stack} {onAction} />
            <KeepThisDeleteOthersAction {stack} {asset} {onAction} />
            {#if stack?.primaryAssetId !== asset.id}
              <SetStackPrimaryAsset {stack} {asset} {onAction} />
              {#if stack?.assets?.length > 2}
                <RemoveAssetFromStack {asset} {stack} {onAction} />
              {/if}
            {/if}
          {/if}
        {/if}
        {#if album}
          <SetAlbumCoverAction {asset} {album} />
        {/if}
        {#if person}
          <SetFeaturedPhotoAction {asset} {person} {onAction} />
        {/if}
        {#if asset.type === AssetTypeEnum.Image && !isLocked}
          <SetProfilePictureAction {asset} />
        {/if}
        {#if !isLocked && isOwner && !asset.isArchived && !asset.isTrashed}
          <MenuOption
            onClick={() => goto(Route.photos({ at: stack?.primaryAssetId ?? asset.id }))}
            text="In timeline"
          />
        {/if}
        {#if !isLocked && !asset.isArchived && !asset.isTrashed && smartSearchEnabled}
          <MenuOption
            onClick={() => goto(Route.search({ queryAssetId: stack?.primaryAssetId ?? asset.id }))}
            text="Similar photos"
          />
        {/if}
        {#if !isLocked && isOwner}
          <ArchiveAction {asset} {onAction} {preAction} />
        {/if}
        {#if !asset.isTrashed && isOwner}
          <SetVisibilityAction asset={toTimelineAsset(asset)} {onAction} {preAction} />
        {/if}
        {#if !isLocked && asset.isTrashed}
          <RestoreAction {asset} {onAction} />
        {/if}
        <ActionMenuItem action={Actions.Offline} />

        <!-- Edit -->
        <li class="px-4 pt-3 pb-1 text-[10px] font-semibold uppercase tracking-wider text-gray-500 select-none">Edit</li>
        <ActionMenuItem action={Actions.Copy} />
        {#if isOwner && asset.type === AssetTypeEnum.Image && !asset.isTrashed && !isLocked}
          <PasteAdjustmentsToAssetAction {asset} />
          <RemoveMotionAction {asset} />
        {/if}
        {#if isOwner}
          <RatingAction {asset} {onAction} />
        {/if}

        {#if isOwner}
          <!-- Admin -->
          <li class="px-4 pt-3 pb-1 text-[10px] font-semibold uppercase tracking-wider text-gray-500 select-none">Admin</li>
          <ActionMenuItem action={Actions.RefreshFacesJob} />
          <ActionMenuItem action={Actions.RefreshMetadataJob} />
          <ActionMenuItem action={Actions.RegenerateThumbnailJob} />
          <ActionMenuItem action={Actions.TranscodeVideoJob} />
        {/if}
      </ButtonContextMenu>
    {/if}
  </div>
</div>
