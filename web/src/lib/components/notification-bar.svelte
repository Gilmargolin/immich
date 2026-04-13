<script lang="ts">
  import { notificationBar } from '$lib/stores/notification-bar.svelte';
  import { fly } from 'svelte/transition';

  const typeColor = (type: string) => {
    if (type === 'danger') return 'rgba(127, 29, 29, 0.75)';
    if (type === 'warning') return 'rgba(113, 63, 18, 0.75)';
    return 'rgba(0, 0, 0, 0.55)';
  };

  const actionColor = (type: string) => {
    if (type === 'danger') return '#fecaca';
    if (type === 'warning') return '#fef08a';
    return '#93c5fd';
  };
</script>

{#if notificationBar.current}
  {@const n = notificationBar.current}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    style="position:fixed; bottom:24px; left:0; right:0; display:flex; justify-content:center; z-index:9999; pointer-events:none;"
    transition:fly={{ y: 20, duration: 200 }}
  >
    <div
      style="pointer-events:auto; display:inline-flex; align-items:center; gap:12px; padding:8px 20px;
             border-radius:9999px; font-size:14px; color:white; backdrop-filter:blur(12px);
             background:{typeColor(n.type)}; white-space:nowrap;"
    >
      <span style="max-width:500px; overflow:hidden; text-overflow:ellipsis;">{n.message}</span>

      {#if n.action}
        <button
          style="font-weight:600; color:{actionColor(n.type)}; background:none; border:none; cursor:pointer; text-decoration:underline; text-underline-offset:2px; font-size:14px;"
          onclick={() => {
            n.action?.onClick();
            notificationBar.dismiss();
          }}
        >
          {n.action.label}
        </button>
      {/if}

      <button
        style="background:none; border:none; cursor:pointer; color:white; opacity:0.5; padding:0; line-height:1; font-size:14px;"
        aria-label="Dismiss"
        onclick={() => notificationBar.dismiss()}
      >
        ✕
      </button>
    </div>
  </div>
{/if}
