<script lang="ts">
  import { notificationBar } from '$lib/stores/notification-bar.svelte';
  import { fly } from 'svelte/transition';

  const classByType = (type: string) => {
    switch (type) {
      case 'success': {
        return 'bg-green-600';
      }
      case 'danger': {
        return 'bg-red-600';
      }
      case 'warning': {
        return 'bg-amber-600';
      }
      default: {
        return 'bg-gray-700';
      }
    }
  };
</script>

{#if notificationBar.current}
  {@const n = notificationBar.current}
  <div
    class="fixed bottom-4 left-4 z-[9999] max-w-[calc(100vw-2rem)] pointer-events-none"
    transition:fly={{ y: 10, duration: 150 }}
  >
    <div
      class="pointer-events-auto inline-flex items-center gap-3 px-3 py-1.5 rounded-md text-sm text-white shadow-lg {classByType(
        n.type,
      )}"
    >
      <span class="truncate max-w-xl">{n.message}</span>
      {#if n.action}
        <button
          type="button"
          class="font-semibold underline underline-offset-2 cursor-pointer hover:opacity-80"
          onclick={() => {
            n.action?.onClick();
            notificationBar.dismiss();
          }}
        >
          {n.action.label}
        </button>
      {/if}
    </div>
  </div>
{/if}
