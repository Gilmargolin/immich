<script lang="ts">
  import { page } from '$app/state';
  import { focusTrap } from '$lib/actions/focus-trap';
  import AvatarEditModal from '$lib/modals/AvatarEditModal.svelte';
  import HelpAndFeedbackModal from '$lib/modals/HelpAndFeedbackModal.svelte';
  import { Route } from '$lib/route';
  import { user } from '$lib/stores/user.store';
  import { userInteraction } from '$lib/stores/user.svelte';
  import { getAboutInfo, type ServerAboutResponseDto } from '@immich/sdk';
  import { Button, Icon, IconButton, modalManager } from '@immich/ui';
  import { mdiBellBadge, mdiBellOutline, mdiCog, mdiLogout, mdiPencil, mdiTrayArrowUp, mdiWrench } from '@mdi/js';
  import { onMount } from 'svelte';
  import { t } from 'svelte-i18n';
  import { fade } from 'svelte/transition';
  import ThemeButton from '../theme-button.svelte';
  import UserAvatar from '../user-avatar.svelte';

  interface Props {
    onLogout: () => void;
    onClose?: () => void;
    onUploadClick?: () => void;
    onShowNotifications?: () => void;
    hasUnreadNotifications?: boolean;
    notificationCount?: number;
  }

  let {
    onLogout,
    onClose = () => {},
    onUploadClick,
    onShowNotifications,
    hasUnreadNotifications = false,
    notificationCount = 0,
  }: Props = $props();

  let info: ServerAboutResponseDto | undefined = $state();
  const isOnAdminRoute = $derived(page.url.pathname.includes('/admin'));

  onMount(async () => {
    info = userInteraction.aboutInfo ?? (await getAboutInfo());
  });
</script>

<div
  in:fade={{ duration: 100 }}
  out:fade={{ duration: 100 }}
  id="account-info-panel"
  class="absolute z-1 end-6 top-19 w-[min(360px,100vw-50px)] rounded-3xl bg-gray-200 shadow-lg dark:border dark:border-immich-dark-gray dark:bg-immich-dark-gray"
  use:focusTrap
>
  <div
    class="mx-4 mt-4 flex flex-col items-center justify-center gap-4 rounded-t-3xl bg-white p-4 dark:bg-immich-dark-primary/10"
  >
    <div class="relative">
      <UserAvatar user={$user} size="xl" />
      <div class="absolute bottom-0 end-0 rounded-full w-6 h-6">
        <IconButton
          color="primary"
          icon={mdiPencil}
          aria-label={$t('edit_avatar')}
          size="tiny"
          shape="round"
          onclick={async () => {
            onClose();
            await modalManager.show(AvatarEditModal);
          }}
        />
      </div>
    </div>
    <div>
      <p class="text-center text-lg font-medium text-primary">
        {$user.name}
      </p>
      <p class="text-sm text-gray-500 dark:text-immich-dark-fg">{$user.email}</p>
    </div>

    <div class="flex flex-col gap-1">
      <Button
        href={Route.userSettings()}
        onclick={onClose}
        size="small"
        color="secondary"
        variant="ghost"
        shape="round"
        class="border dark:border-immich-dark-gray dark:bg-gray-500 dark:hover:bg-immich-dark-primary/50 hover:bg-immich-primary/10 dark:text-white"
      >
        <div class="flex place-content-center place-items-center text-center gap-2 px-2">
          <Icon icon={mdiCog} size="18" aria-hidden />
          {$t('account_settings')}
        </div>
      </Button>
      {#if $user.isAdmin}
        <Button
          href={Route.systemSettings()}
          onclick={onClose}
          shape="round"
          variant="ghost"
          size="small"
          color="secondary"
          aria-current={isOnAdminRoute ? 'page' : undefined}
          class="border dark:border-immich-dark-gray dark:bg-gray-500 dark:hover:bg-immich-dark-primary/50 hover:bg-immich-primary/10 dark:text-white"
        >
          <div class="flex place-content-center place-items-center text-center gap-2 px-2">
            <Icon icon={mdiWrench} size="18" aria-hidden />
            {$t('administration')}
          </div>
        </Button>
      {/if}
    </div>
  </div>

  <div class="mx-4 mt-2 flex flex-col rounded-xl overflow-hidden">
    {#if onUploadClick && !isOnAdminRoute}
      <button
        type="button"
        class="flex items-center gap-3 px-4 py-3 bg-white dark:bg-immich-dark-primary/10 hover:bg-immich-primary/10 dark:hover:bg-immich-dark-primary/30 text-sm text-primary text-start cursor-pointer"
        onclick={() => {
          onClose();
          onUploadClick?.();
        }}
      >
        <Icon icon={mdiTrayArrowUp} size="20" aria-hidden />
        <span>{$t('upload')}</span>
      </button>
    {/if}

    <div
      class="flex items-center justify-between gap-3 px-4 py-2 bg-white dark:bg-immich-dark-primary/10 text-sm text-primary"
    >
      <span>{$t('theme')}</span>
      <ThemeButton />
    </div>

    {#if onShowNotifications}
      <button
        type="button"
        class="flex items-center gap-3 px-4 py-3 bg-white dark:bg-immich-dark-primary/10 hover:bg-immich-primary/10 dark:hover:bg-immich-dark-primary/30 text-sm text-primary text-start cursor-pointer"
        onclick={() => {
          onClose();
          onShowNotifications?.();
        }}
      >
        <Icon icon={hasUnreadNotifications ? mdiBellBadge : mdiBellOutline} size="20" aria-hidden />
        <span class="flex-1">{$t('notifications')}</span>
        {#if hasUnreadNotifications}
          <span
            class="flex h-5 min-w-5 items-center justify-center rounded-full bg-primary px-1.5 text-[10px] font-bold text-light"
          >
            {notificationCount}
          </span>
        {/if}
      </button>
    {/if}
  </div>

  <div class="mb-4 flex flex-col">
    <Button
      class="m-1 mx-4 rounded-none rounded-b-3xl bg-white p-3 dark:bg-immich-dark-primary/10"
      onclick={onLogout}
      leadingIcon={mdiLogout}
      variant="ghost"
      color="secondary">{$t('sign_out')}</Button
    >

    <button
      type="button"
      class="text-center mt-4 underline text-xs text-primary"
      onclick={async () => {
        onClose();
        if (info) {
          await modalManager.show(HelpAndFeedbackModal, { info });
        }
      }}
    >
      {$t('support_and_feedback')}
    </button>
  </div>
</div>
