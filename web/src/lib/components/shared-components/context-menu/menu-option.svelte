<script lang="ts">
  import type { Shortcut } from '$lib/actions/shortcut';
  import { shortcut as bindShortcut, shortcutLabel as computeShortcutLabel } from '$lib/actions/shortcut';
  import { optionClickCallbackStore, selectedIdStore } from '$lib/stores/context-menu.store';
  import { generateId } from '$lib/utils/generate-id';
  import { Icon, type IconLike } from '@immich/ui';
  import { getContext } from 'svelte';

  interface Props {
    text: string;
    subtitle?: string;
    icon?: IconLike;
    activeColor?: string;
    textColor?: string;
    onClick: () => void;
    shortcut?: Shortcut | null;
    shortcutLabel?: string;
  }

  let {
    text,
    subtitle = '',
    icon,
    activeColor = 'bg-slate-300',
    textColor = 'text-immich-fg dark:text-immich-dark-bg',
    onClick,
    shortcut = null,
    shortcutLabel = '',
  }: Props = $props();

  // Compact mode: opt-in via Svelte context (set by ButtonContextMenu's
  // `compact` prop). Hides icons, shrinks the font, tightens padding so the
  // whole menu reads as a dense, keyboard-driven list. Inherited by every
  // MenuOption inside the menu (including ones rendered by custom action
  // wrappers like ArchiveAction, RestoreAction, etc. — no per-component
  // changes needed).
  const compact = getContext<boolean>('menuOptionCompact') === true;

  let id: string = generateId();

  let isActive = $derived($selectedIdStore === id);

  const handleClick = () => {
    $optionClickCallbackStore?.();
    onClick();
  };

  if (shortcut && !shortcutLabel) {
    shortcutLabel = computeShortcutLabel(shortcut);
  }
  const bindShortcutIfSet = shortcut
    ? (n: HTMLElement) => bindShortcut(n, { shortcut, onShortcut: onClick })
    : () => {};
</script>

<svelte:document use:bindShortcutIfSet />

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_mouse_events_have_key_events -->
<li
  {id}
  onclick={handleClick}
  onmouseover={() => ($selectedIdStore = id)}
  onmouseleave={() => ($selectedIdStore = undefined)}
  class="w-full text-start font-medium {textColor} focus:outline-none focus:ring-2 focus:ring-inset cursor-pointer border-gray-200 flex gap-2 items-center {compact
    ? 'px-3 py-1.5 text-xs'
    : 'p-4 text-sm'} {isActive ? activeColor : 'bg-slate-100'}"
  role="menuitem"
>
  {#if icon && !compact}
    <Icon {icon} aria-hidden size="18" />
  {/if}
  <div class="w-full">
    <div class="flex justify-between">
      {text}
      {#if shortcutLabel}
        <span class="text-gray-500 ps-4">
          {shortcutLabel}
        </span>
      {/if}
    </div>
    {#if subtitle}
      <p class="text-xs text-gray-500">
        {subtitle}
      </p>
    {/if}
  </div>
</li>
