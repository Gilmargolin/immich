<script lang="ts">
  import { shortcutLabel as computeShortcutLabel } from '$lib/actions/shortcut';
  import MenuOption from '$lib/components/shared-components/context-menu/menu-option.svelte';
  import { isEnabled } from '$lib/utils';
  import { type ActionItem } from '@immich/ui';

  type Props = {
    action: ActionItem;
    /**
     * Show the action's icon. Off by default — the asset-viewer menu uses a
     * lean text-and-shortcut layout with no icons. Other call sites that
     * still want icons can opt in.
     */
    showIcon?: boolean;
  };

  const { action, showIcon = false }: Props = $props();
  const { title, icon, onAction, shortcuts } = $derived(action);
  // ActionItem.shortcuts is MaybeArray<Shortcut>. Show only the first one;
  // the actual binding is registered by CommandPaletteDefaultProvider so we
  // don't re-bind here (would fire onAction twice).
  const firstShortcut = $derived(Array.isArray(shortcuts) ? shortcuts[0] : (shortcuts ?? null));
  const label = $derived(firstShortcut ? computeShortcutLabel(firstShortcut) : '');
</script>

{#if isEnabled(action)}
  <MenuOption
    icon={showIcon ? icon : undefined}
    text={title}
    shortcutLabel={label}
    onClick={() => onAction(action)}
  />
{/if}
