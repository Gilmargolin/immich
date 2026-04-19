<script lang="ts" module>
  export const menuButtonId = 'top-menu-button';
</script>

<script lang="ts">
  import { clickOutside } from '$lib/actions/click-outside';
  import NotificationPanel from '$lib/components/shared-components/navigation-bar/notification-panel.svelte';
  import SearchBar from '$lib/components/shared-components/search-bar/search-bar.svelte';
  import SkipLink from '$lib/elements/SkipLink.svelte';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { featureFlagsManager } from '$lib/managers/feature-flags-manager.svelte';
  import { Route } from '$lib/route';
  import { getGlobalActions } from '$lib/services/app.service';
  import { notificationManager } from '$lib/stores/notification-manager.svelte';
  import { sidebarStore } from '$lib/stores/sidebar.svelte';
  import { user } from '$lib/stores/user.store';
  import { ActionButton, IconButton, Logo } from '@immich/ui';
  import { mdiMagnify } from '@mdi/js';
  import { onMount } from 'svelte';
  import { t } from 'svelte-i18n';
  import UserAvatar from '../user-avatar.svelte';
  import AccountInfoPanel from './account-info-panel.svelte';

  type Props = {
    onUploadClick?: () => void;
    // TODO: remove once this is only used in <AppShellHeader>
    noBorder?: boolean;
  };

  let { onUploadClick, noBorder = false }: Props = $props();

  let shouldShowAccountInfoPanel = $state(false);
  let shouldShowNotificationPanel = $state(false);
  let innerWidth: number = $state(0);
  const hasUnreadNotifications = $derived(notificationManager.notifications.length > 0);
  const notificationCount = $derived(notificationManager.notifications.length);

  onMount(async () => {
    try {
      await notificationManager.refresh();
    } catch (error) {
      console.error('Failed to load notifications on mount', error);
    }
  });

  const { Cast } = $derived(getGlobalActions($t));
</script>

<svelte:window bind:innerWidth />

<nav id="dashboard-navbar" class="max-md:h-(--navbar-height-md) h-(--navbar-height) w-dvw text-sm">
  <SkipLink text={$t('skip_to_content')} />
  <div
    class="grid h-full grid-cols-[--spacing(32)_auto] items-center py-2 {sidebarStore.isOpen
      ? 'sidebar:grid-cols-[--spacing(64)_auto]'
      : ''} {noBorder ? '' : 'border-b'}"
  >
    <div class="flex flex-row gap-1 mx-4 items-center">
      <button
        id={menuButtonId}
        type="button"
        aria-label={$t('main_menu')}
        class="flex items-center rounded-full p-1 hover:bg-immich-primary/10 dark:hover:bg-immich-dark-primary/10 transition-colors cursor-pointer"
        onclick={() => {
          sidebarStore.toggle();
        }}
        onmousedown={(event: MouseEvent) => {
          if (sidebarStore.isOpen) {
            // stops event from reaching the default handler when clicking outside of the sidebar
            event.stopPropagation();
          }
        }}
      >
        <Logo variant="icon" class="max-md:h-12" />
      </button>
    </div>
    <div class="flex justify-between gap-4 lg:gap-8 pe-6">
      <div class="hidden w-full max-w-5xl flex-1 tall:ps-0 sm:block">
        {#if featureFlagsManager.value.search}
          <SearchBar grayTheme={true} />
        {/if}
      </div>

      <section class="flex place-items-center justify-end gap-1 md:gap-2 w-full sm:w-auto">
        {#if featureFlagsManager.value.search}
          <IconButton
            color="secondary"
            shape="round"
            variant="ghost"
            size="medium"
            icon={mdiMagnify}
            href={Route.search()}
            id="search-button"
            class="sm:hidden"
            aria-label={$t('go_to_search')}
          />
        {/if}

        <ActionButton action={Cast} />

        <div
          use:clickOutside={{
            onOutclick: () => (shouldShowNotificationPanel = false),
            onEscape: () => (shouldShowNotificationPanel = false),
          }}
        >
          {#if shouldShowNotificationPanel}
            <NotificationPanel />
          {/if}
        </div>

        <div
          use:clickOutside={{
            onOutclick: () => (shouldShowAccountInfoPanel = false),
            onEscape: () => (shouldShowAccountInfoPanel = false),
          }}
        >
          <button
            type="button"
            class="flex ps-2 relative"
            onclick={() => (shouldShowAccountInfoPanel = !shouldShowAccountInfoPanel)}
            title={`${$user.name} (${$user.email})`}
          >
            {#key $user}
              <UserAvatar user={$user} size="md" noTitle interactive />
            {/key}
            {#if hasUnreadNotifications}
              <span
                class="pointer-events-none absolute top-0 end-0 h-3 w-3 rounded-full bg-primary border-2 border-light dark:border-immich-dark-bg"
                aria-hidden="true"
              ></span>
            {/if}
          </button>

          {#if shouldShowAccountInfoPanel}
            <AccountInfoPanel
              {onUploadClick}
              {hasUnreadNotifications}
              {notificationCount}
              onShowNotifications={() => (shouldShowNotificationPanel = true)}
              onLogout={() => authManager.logout()}
              onClose={() => (shouldShowAccountInfoPanel = false)}
            />
          {/if}
        </div>
      </section>
    </div>
  </div>
</nav>
