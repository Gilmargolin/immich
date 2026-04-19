<script lang="ts">
  import { user } from '$lib/stores/user.store';
  import { userInteraction } from '$lib/stores/user.svelte';
  import { requestServerInfo } from '$lib/utils/auth';
  import { onMount } from 'svelte';
  import { t } from 'svelte-i18n';

  let hasQuota = $derived($user?.quotaSizeInBytes !== null);
  let availableBytes = $derived((hasQuota ? $user?.quotaSizeInBytes : userInteraction.serverInfo?.diskSizeRaw) || 0);
  let usedBytes = $derived((hasQuota ? $user?.quotaUsageInBytes : userInteraction.serverInfo?.diskUseRaw) || 0);

  const toGB = (bytes: number) => Math.round(bytes / 1024 ** 3);

  onMount(async () => {
    if (userInteraction.serverInfo && $user) {
      return;
    }
    await requestServerInfo();
  });
</script>

{#if userInteraction.serverInfo && availableBytes > 0}
  <p class="text-sm ps-5 pe-1 dark:text-immich-dark-fg">
    {$t('storage')}
    {toGB(usedBytes)}/{toGB(availableBytes)}GB
  </p>
{/if}
