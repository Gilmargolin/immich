<script lang="ts">
  import { Icon } from '@immich/ui';
  import { mdiRestore } from '@mdi/js';

  interface Props {
    icon: string;
    label: string;
    value: number;
    onchange: (value: number) => void;
    min?: number;
    max?: number;
  }

  let { icon, label, value, onchange, min = -1, max = 1 }: Props = $props();

  function handleInput(event: Event) {
    const target = event.target as HTMLInputElement;
    onchange(Number.parseFloat(target.value));
  }

  function handleReset() {
    onchange(0);
  }
</script>

<div class="flex items-center gap-2 py-1.5">
  <Icon {icon} size="18" class="shrink-0 text-gray-300" />
  <button
    class="w-20 text-xs text-start text-gray-300 hover:text-white truncate"
    onclick={handleReset}
    title="Reset {label}"
  >
    {label}
  </button>
  <input
    type="range"
    {min}
    {max}
    step="0.01"
    {value}
    oninput={handleInput}
    class="flex-1 h-1 accent-immich-primary cursor-pointer"
  />
  <span class="w-8 text-xs text-gray-400 text-end tabular-nums">
    {Math.round(value * 100)}
  </span>
  <button
    type="button"
    class="shrink-0 rounded p-0.5 text-gray-400 hover:text-white hover:bg-gray-700 disabled:opacity-30 disabled:cursor-default disabled:hover:bg-transparent disabled:hover:text-gray-400"
    disabled={value === 0}
    onclick={handleReset}
    aria-label="Reset {label}"
    title="Reset {label} to default"
  >
    <Icon icon={mdiRestore} size="14" />
  </button>
</div>
