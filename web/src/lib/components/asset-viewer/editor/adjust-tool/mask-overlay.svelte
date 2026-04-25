<script lang="ts">
  import { adjustManager } from '$lib/managers/edit/adjust-manager.svelte';
  import type { LinearMask, LocalMask, RadialMask } from '$lib/managers/edit/adjust-webgl';
  import { onDestroy } from 'svelte';

  // Interactive SVG overlay that renders mask gizmos on top of the adjust
  // canvas. Selected mask gets full draggable handles; unselected masks
  // render as dimmed outlines so the user can still locate them.
  //
  // Coordinate system: SVG fills the same area as the underlying canvas.
  // Mask geometry is stored normalized [0,1]; we multiply by SVG dims for
  // rendering and divide pointer coords by SVG dims to update geometry.

  let svg = $state<SVGSVGElement | null>(null);
  let svgWidth = $state(0);
  let svgHeight = $state(0);

  let masks = $derived(adjustManager.masks);
  let selectedIndex = $derived(adjustManager.selectedMaskIndex);

  let resizeObserver: ResizeObserver | null = null;

  $effect(() => {
    if (!svg) {
      return;
    }
    const rect = svg.getBoundingClientRect();
    svgWidth = rect.width;
    svgHeight = rect.height;
    resizeObserver?.disconnect();
    resizeObserver = new ResizeObserver(() => {
      if (svg) {
        const r = svg.getBoundingClientRect();
        svgWidth = r.width;
        svgHeight = r.height;
      }
    });
    resizeObserver.observe(svg);
    return () => resizeObserver?.disconnect();
  });

  onDestroy(() => {
    resizeObserver?.disconnect();
    resizeObserver = null;
  });

  const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

  // Convert pointer event → normalized [0,1] coordinates relative to SVG.
  const eventToNormalized = (e: PointerEvent) => {
    if (!svg) {
      return { nx: 0, ny: 0 };
    }
    const rect = svg.getBoundingClientRect();
    return {
      nx: clamp01((e.clientX - rect.left) / Math.max(1, rect.width)),
      ny: clamp01((e.clientY - rect.top) / Math.max(1, rect.height)),
    };
  };

  // Generic drag helper. Captures pointer, fires onMove on each pointermove
  // with cumulative delta in normalized coords (and the initial position).
  // Releases on pointerup or pointercancel.
  const startDrag = (
    e: PointerEvent,
    onMove: (state: { nx: number; ny: number; dnx: number; dny: number; startNx: number; startNy: number }) => void,
  ) => {
    e.preventDefault();
    e.stopPropagation();
    const target = e.currentTarget as Element;
    target.setPointerCapture(e.pointerId);
    const start = eventToNormalized(e);

    const handleMove = (ev: Event) => {
      const cur = eventToNormalized(ev as PointerEvent);
      onMove({
        nx: cur.nx,
        ny: cur.ny,
        dnx: cur.nx - start.nx,
        dny: cur.ny - start.ny,
        startNx: start.nx,
        startNy: start.ny,
      });
    };
    const handleUp = (ev: Event) => {
      const pe = ev as PointerEvent;
      target.releasePointerCapture(pe.pointerId);
      target.removeEventListener('pointermove', handleMove);
      target.removeEventListener('pointerup', handleUp);
      target.removeEventListener('pointercancel', handleUp);
    };

    target.addEventListener('pointermove', handleMove);
    target.addEventListener('pointerup', handleUp);
    target.addEventListener('pointercancel', handleUp);
  };

  // ---------- Linear mask drag handlers ----------

  const dragLinearA = (e: PointerEvent, idx: number, mask: LinearMask) => {
    adjustManager.selectMask(idx);
    startDrag(e, ({ nx, ny }) => {
      adjustManager.updateMask(idx, { ...mask, ax: nx, ay: ny });
    });
  };

  const dragLinearB = (e: PointerEvent, idx: number, mask: LinearMask) => {
    adjustManager.selectMask(idx);
    startDrag(e, ({ nx, ny }) => {
      adjustManager.updateMask(idx, { ...mask, bx: nx, by: ny });
    });
  };

  const dragLinearTranslate = (e: PointerEvent, idx: number, mask: LinearMask) => {
    adjustManager.selectMask(idx);
    const { ax, ay, bx, by } = mask;
    startDrag(e, ({ dnx, dny }) => {
      adjustManager.updateMask(idx, {
        ...mask,
        ax: clamp01(ax + dnx),
        ay: clamp01(ay + dny),
        bx: clamp01(bx + dnx),
        by: clamp01(by + dny),
      });
    });
  };

  // ---------- Radial mask drag handlers ----------

  const dragRadialCenter = (e: PointerEvent, idx: number, mask: RadialMask) => {
    adjustManager.selectMask(idx);
    const { cx, cy } = mask;
    startDrag(e, ({ dnx, dny }) => {
      adjustManager.updateMask(idx, {
        ...mask,
        cx: clamp01(cx + dnx),
        cy: clamp01(cy + dny),
      });
    });
  };

  const dragRadialRx = (e: PointerEvent, idx: number, mask: RadialMask) => {
    adjustManager.selectMask(idx);
    // rx is normalized to min(W, H). Convert pixel delta from center → rx.
    const minDim = Math.min(svgWidth, svgHeight);
    if (minDim < 1) {
      return;
    }
    const cxPx = mask.cx * svgWidth;
    startDrag(e, ({ nx }) => {
      const newRx = Math.max(0.02, Math.abs((nx * svgWidth - cxPx) / minDim));
      adjustManager.updateMask(idx, { ...mask, rx: newRx });
    });
  };

  const dragRadialRy = (e: PointerEvent, idx: number, mask: RadialMask) => {
    adjustManager.selectMask(idx);
    const minDim = Math.min(svgWidth, svgHeight);
    if (minDim < 1) {
      return;
    }
    const cyPx = mask.cy * svgHeight;
    startDrag(e, ({ ny }) => {
      const newRy = Math.max(0.02, Math.abs((ny * svgHeight - cyPx) / minDim));
      adjustManager.updateMask(idx, { ...mask, ry: newRy });
    });
  };

  // ---------- Click on background to deselect ----------

  const onSvgClick = (e: MouseEvent) => {
    if (e.target === svg) {
      adjustManager.selectMask(null);
    }
  };

  // Pixel-space helpers for rendering
  let minDim = $derived(Math.min(svgWidth, svgHeight));

  const linearPx = (m: LinearMask) => ({
    ax: m.ax * svgWidth,
    ay: m.ay * svgHeight,
    bx: m.bx * svgWidth,
    by: m.by * svgHeight,
  });

  const linearMid = (m: LinearMask) => ({
    mx: ((m.ax + m.bx) / 2) * svgWidth,
    my: ((m.ay + m.by) / 2) * svgHeight,
  });

  const radialPx = (m: RadialMask) => ({
    cx: m.cx * svgWidth,
    cy: m.cy * svgHeight,
    rx: m.rx * minDim,
    ry: m.ry * minDim,
  });
</script>

<svg
  bind:this={svg}
  class="absolute inset-0 h-full w-full"
  onclick={onSvgClick}
  role="presentation"
>
  {#each masks as mask, i (i)}
    {@const isSelected = i === selectedIndex}
    {@const opacity = isSelected ? 1 : 0.45}

    {#if mask.kind === 'linear'}
      {@const px = linearPx(mask)}
      {@const mid = linearMid(mask)}
      <g style="opacity: {opacity};">
        <!-- Connecting line A→B -->
        <line
          x1={px.ax}
          y1={px.ay}
          x2={px.bx}
          y2={px.by}
          stroke="#7dd3fc"
          stroke-width="2"
          stroke-dasharray="6 4"
          pointer-events="none"
        />
        <!-- Translate handle on the midpoint -->
        <circle
          cx={mid.mx}
          cy={mid.my}
          r="6"
          fill="#7dd3fc"
          fill-opacity="0.5"
          stroke="#0c4a6e"
          stroke-width="1.5"
          style="cursor: move;"
          onpointerdown={(e) => dragLinearTranslate(e, i, mask)}
        />
        <!-- A handle (filled = weight 1) -->
        <circle
          cx={px.ax}
          cy={px.ay}
          r="9"
          fill="#0ea5e9"
          stroke="white"
          stroke-width="2"
          style="cursor: grab;"
          onpointerdown={(e) => dragLinearA(e, i, mask)}
        />
        <!-- B handle (outline = weight 0) -->
        <circle
          cx={px.bx}
          cy={px.by}
          r="9"
          fill="white"
          stroke="#0ea5e9"
          stroke-width="2.5"
          style="cursor: grab;"
          onpointerdown={(e) => dragLinearB(e, i, mask)}
        />
      </g>
    {:else}
      {@const px = radialPx(mask)}
      {@const featherInner = Math.max(0.001, 1 - mask.feather)}
      <g
        style="opacity: {opacity}; transform: rotate({mask.angle}deg); transform-origin: {px.cx}px {px.cy}px;"
      >
        <!-- Outer ellipse (weight=0 boundary) -->
        <ellipse
          cx={px.cx}
          cy={px.cy}
          rx={px.rx}
          ry={px.ry}
          fill="none"
          stroke="#7dd3fc"
          stroke-width="2"
          stroke-dasharray="6 4"
          pointer-events="none"
        />
        <!-- Inner ellipse (weight=1 boundary, feather edge) -->
        <ellipse
          cx={px.cx}
          cy={px.cy}
          rx={px.rx * featherInner}
          ry={px.ry * featherInner}
          fill="none"
          stroke="#7dd3fc"
          stroke-width="1"
          stroke-dasharray="3 3"
          pointer-events="none"
        />
        <!-- Center handle (translate) -->
        <circle
          cx={px.cx}
          cy={px.cy}
          r="9"
          fill="#0ea5e9"
          stroke="white"
          stroke-width="2"
          style="cursor: move;"
          onpointerdown={(e) => dragRadialCenter(e, i, mask)}
        />
        <!-- Right edge handle (rx) -->
        <circle
          cx={px.cx + px.rx}
          cy={px.cy}
          r="7"
          fill="white"
          stroke="#0ea5e9"
          stroke-width="2"
          style="cursor: ew-resize;"
          onpointerdown={(e) => dragRadialRx(e, i, mask)}
        />
        <!-- Bottom edge handle (ry) -->
        <circle
          cx={px.cx}
          cy={px.cy + px.ry}
          r="7"
          fill="white"
          stroke="#0ea5e9"
          stroke-width="2"
          style="cursor: ns-resize;"
          onpointerdown={(e) => dragRadialRy(e, i, mask)}
        />
      </g>
    {/if}
  {/each}
</svg>
