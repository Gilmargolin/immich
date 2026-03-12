<script lang="ts">
  import { Icon } from '@immich/ui';

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
</div>
