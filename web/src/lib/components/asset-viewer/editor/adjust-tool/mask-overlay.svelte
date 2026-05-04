<script lang="ts">
  import { adjustManager } from '$lib/managers/edit/adjust-manager.svelte';
  import type { LinearMask, LocalMask, RadialMask } from '$lib/managers/edit/adjust-webgl';
  import { onDestroy } from 'svelte';
  import BrushOverlay from './brush-overlay.svelte';

  // Interactive SVG overlay over the adjust canvas. Three modes:
  //   - Idle: render mask gizmos for existing masks. Selected mask gets full
  //     handles + affected-area gradient overlay; others render dim outlines.
  //   - Draw: pendingMaskKind is set. Cursor becomes crosshair. Pointerdown
  //     records the start, pointermove draws a preview, pointerup commits a
  //     new mask via adjustManager.commitDrawnXxxMask.
  //
  // Coordinate system: SVG fills the same area as the canvas underneath.
  // Mask DTOs use normalized [0,1] (cx/ax/etc. to image W/H; radial rx/ry to
  // min(W,H)). We multiply by SVG dims for rendering and divide pointer
  // coords by SVG dims to update geometry.

  let svg = $state<SVGSVGElement | null>(null);
  let svgWidth = $state(0);
  let svgHeight = $state(0);

  let masks = $derived(adjustManager.masks);
  let selectedIndex = $derived(adjustManager.selectedMaskIndex);
  let editingIndex = $derived(adjustManager.editingMaskIndex);
  let pendingKind = $derived(adjustManager.pendingMaskKind);

  // Live preview of the in-progress drawn mask (during pointer drag).
  // null when not drawing or no point captured yet.
  let drawStart = $state<{ nx: number; ny: number } | null>(null);
  let drawCurrent = $state<{ nx: number; ny: number } | null>(null);

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

  // ---------- Linear mask handle drag ----------

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

  // Drag the 50% line / its handle along AB to bias the falloff curve. We
  // project the cursor onto AB in pixel space (svgWidth/svgHeight match the
  // canvas, which has the image's aspect ratio, so the projection is the
  // same the shader will see).
  const dragLinearMid = (e: PointerEvent, idx: number, mask: LinearMask) => {
    adjustManager.selectMask(idx);
    const ax = mask.ax * svgWidth;
    const ay = mask.ay * svgHeight;
    const bx = mask.bx * svgWidth;
    const by = mask.by * svgHeight;
    const vx = bx - ax;
    const vy = by - ay;
    const lenSq = vx * vx + vy * vy;
    if (lenSq < 1) {
      return;
    }
    startDrag(e, ({ nx, ny }) => {
      const px = nx * svgWidth;
      const py = ny * svgHeight;
      const t = ((px - ax) * vx + (py - ay) * vy) / lenSq;
      const newMid = Math.max(0.1, Math.min(0.9, t));
      adjustManager.updateMask(idx, { ...mask, mid: newMid });
    });
  };

  // ---------- Radial mask handle drag ----------

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

  // Schema bound on RadialMask.feather (server: editing.dto.ts).
  const FEATHER_MAX = 100;
  // Knob travel along the upward y-axis, in units of ry (semi-axis):
  //   D ∈ [ry, ry · (1 + KNOB_MAX_OFFSET)]
  const KNOB_MAX_OFFSET = 3;
  // Logarithmic mapping so the knob stays reachable across the huge
  // [0, FEATHER_MAX] range:
  //   D = ry · (1 + ln(1 + feather) / ln(1 + FEATHER_MAX) · KNOB_MAX_OFFSET)
  //   feather=0   → D = ry        (main top, sharp)
  //   feather=1   → D ≈ 1.45·ry
  //   feather=10  → D ≈ 2.56·ry
  //   feather=100 → D = 4·ry      (knob limit; covers full schema range)
  // Drag inverse: t = (D/ry - 1) / KNOB_MAX_OFFSET; feather = (1+MAX)^t - 1.
  // The actual outer-halo ellipse is drawn at the true (1+feather)·r and
  // can extend far past the knob — that gap intentionally shows how broad
  // the falloff is.
  const FEATHER_LOG_BASE = Math.log(1 + FEATHER_MAX);
  const dragRadialFeather = (e: PointerEvent, idx: number, mask: RadialMask) => {
    adjustManager.selectMask(idx);
    const ryPx = Math.max(1, mask.ry * Math.min(svgWidth, svgHeight));
    const cyPx = mask.cy * svgHeight;
    startDrag(e, ({ ny }) => {
      // Distance ABOVE center along the y-axis (negative drags clamp to 0).
      const distFromCenter = Math.max(0, cyPx - ny * svgHeight);
      const t = Math.min(1, Math.max(0, distFromCenter / ryPx - 1) / KNOB_MAX_OFFSET);
      const feather = Math.max(0, Math.min(FEATHER_MAX, Math.exp(t * FEATHER_LOG_BASE) - 1));
      adjustManager.updateMask(idx, { ...mask, feather });
    });
  };

  // Mid knob: biases where weight = 0.5 lands within the falloff band.
  // Lives on the y-axis between main top and the feather knob, with a small
  // horizontal offset so it doesn't overlap the feather knob's drag axis.
  // y position interpolates linearly from main top (mid → 0) to feather knob
  // (mid → 1). Drag inverse: project cursor's y back onto that line.
  const MID_MIN = 0.05;
  const MID_MAX = 0.95;
  const dragRadialMid = (e: PointerEvent, idx: number, mask: RadialMask) => {
    adjustManager.selectMask(idx);
    const ryPx = Math.max(1, mask.ry * Math.min(svgWidth, svgHeight));
    const cyPx = mask.cy * svgHeight;
    // y of main top in SVG coords:
    const mainTopY = cyPx - ryPx;
    // y of the (log-mapped) feather knob:
    const featherKnobY = cyPx - ryPx * (1 + (Math.log(1 + mask.feather) / FEATHER_LOG_BASE) * KNOB_MAX_OFFSET);
    const span = mainTopY - featherKnobY; // > 0 for any feather > 0
    if (span < 1) {
      return; // no visible band — feather is 0; mid has no effect
    }
    startDrag(e, ({ ny }) => {
      const cursorY = ny * svgHeight;
      const t = (mainTopY - cursorY) / span;
      const mid = Math.max(MID_MIN, Math.min(MID_MAX, t));
      adjustManager.updateMask(idx, { ...mask, mid });
    });
  };

  // Uniform-size knob: drag scales rx and ry by the same ratio, preserving
  // aspect (so a circle stays a circle). Lives at the 4:30 position on the
  // main ellipse so it's distinct from the rx (3 o'clock) and ry (6 o'clock)
  // handles.
  const dragRadialSize = (e: PointerEvent, idx: number, mask: RadialMask) => {
    adjustManager.selectMask(idx);
    const minDim = Math.min(svgWidth, svgHeight);
    if (minDim < 1) {
      return;
    }
    const cxPx = mask.cx * svgWidth;
    const cyPx = mask.cy * svgHeight;
    // Capture the initial size + grab vector so we can scale relative to
    // them. The knob nominally sits on the ellipse at 45°; a drag changes
    // rx and ry by the same ratio.
    const initialRx = mask.rx;
    const initialRy = mask.ry;
    const startRxPx = initialRx * minDim;
    const startRyPx = initialRy * minDim;
    const startHandleX = startRxPx * Math.SQRT1_2;
    const startHandleY = startRyPx * Math.SQRT1_2;
    const startDistFromCenter = Math.hypot(startHandleX, startHandleY) || 1;
    startDrag(e, ({ nx, ny }) => {
      const dx = nx * svgWidth - cxPx;
      const dy = ny * svgHeight - cyPx;
      const newDist = Math.hypot(dx, dy);
      const scale = newDist / startDistFromCenter;
      const newRx = Math.max(0.02, initialRx * scale);
      const newRy = Math.max(0.02, initialRy * scale);
      adjustManager.updateMask(idx, { ...mask, rx: newRx, ry: newRy });
    });
  };

  // ---------- Draw-mode pointer handlers ----------

  const onDrawPointerDown = (e: PointerEvent) => {
    if (!pendingKind) {
      return;
    }
    // Brush draw events are owned by the BrushOverlay sibling — the SVG
    // doesn't intercept clicks in that mode.
    if (pendingKind === 'brush') {
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    const target = e.currentTarget as Element;
    target.setPointerCapture(e.pointerId);
    const start = eventToNormalized(e);
    drawStart = start;
    drawCurrent = start;

    const handleMove = (ev: Event) => {
      drawCurrent = eventToNormalized(ev as PointerEvent);
    };
    const handleUp = (ev: Event) => {
      const pe = ev as PointerEvent;
      target.releasePointerCapture(pe.pointerId);
      target.removeEventListener('pointermove', handleMove);
      target.removeEventListener('pointerup', handleUp);
      target.removeEventListener('pointercancel', handleUp);
      commitDrawn();
    };
    target.addEventListener('pointermove', handleMove);
    target.addEventListener('pointerup', handleUp);
    target.addEventListener('pointercancel', handleUp);
  };

  const commitDrawn = () => {
    const start = drawStart;
    const cur = drawCurrent;
    drawStart = null;
    drawCurrent = null;
    if (!start || !cur || !pendingKind) {
      adjustManager.cancelDrawingMask();
      return;
    }
    const dx = cur.nx - start.nx;
    const dy = cur.ny - start.ny;
    // Click without drag → ignore (user probably clicked a handle target).
    if (Math.abs(dx) < 0.005 && Math.abs(dy) < 0.005) {
      adjustManager.cancelDrawingMask();
      return;
    }
    // The synthetic 'click' event that fires after this pointerup would
    // otherwise reach onSvgClick and immediately deselect the freshly drawn
    // mask (because pointerdown was on the SVG background). Suppress one
    // click. Reset on a short timer in case the click never arrives (e.g.
    // pointercancel path).
    suppressNextSvgClick = true;
    setTimeout(() => {
      suppressNextSvgClick = false;
    }, 250);
    if (pendingKind === 'linear') {
      adjustManager.commitDrawnLinearMask(start.nx, start.ny, cur.nx, cur.ny);
    } else {
      // Convert pixel-space radius from drag → DTO's min(W,H)-relative units.
      const minDim = Math.min(svgWidth, svgHeight);
      if (minDim < 1) {
        adjustManager.cancelDrawingMask();
        return;
      }
      const pxDx = dx * svgWidth;
      const pxDy = dy * svgHeight;
      const pxRadius = Math.hypot(pxDx, pxDy);
      const r = pxRadius / minDim;
      adjustManager.commitDrawnRadialMask(start.nx, start.ny, r, r);
    }
  };

  // ---------- Background click deselects (idle mode only) ----------

  let suppressNextSvgClick = false;

  const onSvgClick = (e: MouseEvent) => {
    if (suppressNextSvgClick) {
      suppressNextSvgClick = false;
      return;
    }
    if (pendingKind) {
      return;
    }
    if (e.target === svg) {
      adjustManager.selectMask(null);
    }
  };

  // ---------- Pixel-space helpers ----------

  let minDim = $derived(Math.min(svgWidth, svgHeight));

  const linearPx = (m: LinearMask) => ({
    ax: m.ax * svgWidth,
    ay: m.ay * svgHeight,
    bx: m.bx * svgWidth,
    by: m.by * svgHeight,
  });

  // Lightroom-style guides: three parallel lines perpendicular to AB at the
  // 100% / 50% / 0% effect positions. Iso-strength of the linear mask is
  // perpendicular to AB (see maskWeight in adjust-shader.ts), so these lines
  // visually communicate exactly where each level of effect lands. Lines are
  // extended far past the canvas; the SVG's overflow:hidden clips them.
  const linearGuides = (m: LinearMask) => {
    const ax = m.ax * svgWidth;
    const ay = m.ay * svgHeight;
    const bx = m.bx * svgWidth;
    const by = m.by * svgHeight;
    const dx = bx - ax;
    const dy = by - ay;
    const len = Math.hypot(dx, dy);
    if (len < 1) {
      return null;
    }
    // Unit perpendicular to AB.
    const nx = -dy / len;
    const ny = dx / len;
    const ext = Math.max(svgWidth, svgHeight) * 2;
    // 50%-effect line is at A + mid*(B-A) (NOT the literal midpoint), so the
    // user can pull the soft falloff toward A or B and see the band shift.
    const midT = m.mid ?? 0.5;
    const midPx = ax + dx * midT;
    const midPy = ay + dy * midT;
    // Translate-handle stays at the literal midpoint of A/B so the user has
    // a stable grip for moving the whole gradient even when the falloff is
    // biased away from center.
    const transPx = (ax + bx) / 2;
    const transPy = (ay + by) / 2;
    // The visible mid-knob sits offset PERPENDICULAR to AB by `knobOffset` px
    // so it never overlaps the translate dot (otherwise z-order makes the
    // translate dot eat the click on the mid knob, and dragging the diamond
    // appears to do nothing). Cap the offset against |AB|/3 for very short
    // gradients.
    const knobOffset = Math.min(22, len / 3);
    const knobX = midPx + nx * knobOffset;
    const knobY = midPy + ny * knobOffset;
    return {
      // Full-effect line (at A, perpendicular to AB).
      full: { x1: ax - nx * ext, y1: ay - ny * ext, x2: ax + nx * ext, y2: ay + ny * ext },
      // 50% effect line (perpendicular through A + mid*(B-A)).
      mid: { x1: midPx - nx * ext, y1: midPy - ny * ext, x2: midPx + nx * ext, y2: midPy + ny * ext },
      // Zero-effect line (at B).
      zero: { x1: bx - nx * ext, y1: by - ny * ext, x2: bx + nx * ext, y2: by + ny * ext },
      // Label anchor offset along the perpendicular so the text doesn't sit
      // on top of the guide line.
      labelOffset: { dx: nx * 14, dy: ny * 14 },
      ax,
      ay,
      bx,
      by,
      midPx,
      midPy,
      knobX,
      knobY,
      transPx,
      transPy,
    };
  };

  const radialPx = (m: RadialMask) => ({
    cx: m.cx * svgWidth,
    cy: m.cy * svgHeight,
    rx: m.rx * minDim,
    ry: m.ry * minDim,
  });

  // Preview shape during draw (shown at pointer position before commit).
  let previewLinear = $derived.by(() => {
    if (pendingKind !== 'linear' || !drawStart || !drawCurrent) {
      return null;
    }
    return {
      ax: drawStart.nx * svgWidth,
      ay: drawStart.ny * svgHeight,
      bx: drawCurrent.nx * svgWidth,
      by: drawCurrent.ny * svgHeight,
    };
  });

  let previewRadial = $derived.by(() => {
    if (pendingKind !== 'radial' || !drawStart || !drawCurrent) {
      return null;
    }
    const cx = drawStart.nx * svgWidth;
    const cy = drawStart.ny * svgHeight;
    const dxPx = (drawCurrent.nx - drawStart.nx) * svgWidth;
    const dyPx = (drawCurrent.ny - drawStart.ny) * svgHeight;
    const r = Math.hypot(dxPx, dyPx);
    return { cx, cy, rx: r, ry: r };
  });
</script>

<div class="pointer-events-none absolute inset-0">
  <svg
    bind:this={svg}
    class="absolute inset-0 h-full w-full pointer-events-auto"
    style="cursor: {pendingKind && pendingKind !== 'brush' ? 'crosshair' : 'default'}; touch-action: none;"
    onclick={onSvgClick}
    onpointerdown={onDrawPointerDown}
    role="presentation"
  >
    <!--
    Per-mask gradient defs for the affected-area overlay. Only rendered when
    the user is actively editing that mask's geometry (clicked the pencil)
    so a freshly-committed mask doesn't keep a red tint forever.
  -->
    <defs>
      {#each masks as mask, i (i)}
        {#if i === editingIndex}
          {#if mask.kind === 'linear'}
            {@const lp = linearPx(mask)}
            {@const linMid = Math.max(0.05, Math.min(0.95, mask.mid ?? 0.5))}
            <linearGradient
              id="mask-overlay-grad-{i}"
              x1={lp.ax}
              y1={lp.ay}
              x2={lp.bx}
              y2={lp.by}
              gradientUnits="userSpaceOnUse"
            >
              <!-- Stops match the shader's piecewise mid remap: weight = 1 at
                 offset 0, weight = 0.5 at offset = mid, weight = 0 at offset 1.
                 Without the mid stop the red tint stays a pure linear ramp
                 even when the falloff curve is biased, which makes the visual
                 lie about where the effect actually peaks. -->
              <stop offset="0" stop-color="#ef4444" stop-opacity="0.3" />
              <stop offset={linMid} stop-color="#ef4444" stop-opacity="0.15" />
              <stop offset="1" stop-color="#ef4444" stop-opacity="0" />
            </linearGradient>
          {:else if mask.kind === 'radial'}
            {@const featherEnd = 1 + mask.feather}
            {@const radMid = Math.min(0.95, Math.max(0.05, mask.mid ?? 0.5))}
            {@const innerOffset = 1 / featherEnd}
            {@const midOffset = innerOffset + radMid * (1 - innerOffset)}
            <radialGradient
              id="mask-overlay-grad-{i}"
              cx={mask.cx * svgWidth}
              cy={mask.cy * svgHeight}
              r={Math.max(mask.rx, mask.ry) * minDim * featherEnd}
              fx={mask.cx * svgWidth}
              fy={mask.cy * svgHeight}
              gradientUnits="userSpaceOnUse"
            >
              <stop offset="0" stop-color="#ef4444" stop-opacity="0.3" />
              <stop offset={innerOffset} stop-color="#ef4444" stop-opacity="0.3" />
              <stop offset={midOffset} stop-color="#ef4444" stop-opacity="0.15" />
              <stop offset="1" stop-color="#ef4444" stop-opacity="0" />
            </radialGradient>
          {/if}
        {/if}
      {/each}
    </defs>

    <!-- Affected-area overlay (editing mask only) — non-interactive tint. -->
    {#each masks as mask, i (i)}
      {#if i === editingIndex}
        {#if mask.kind === 'linear'}
          <rect
            x="0"
            y="0"
            width={svgWidth}
            height={svgHeight}
            fill="url(#mask-overlay-grad-{i})"
            pointer-events="none"
          />
        {:else if mask.kind === 'radial'}
          {@const px = radialPx(mask)}
          {@const featherEnd = 1 + mask.feather}
          <ellipse
            cx={px.cx}
            cy={px.cy}
            rx={px.rx * featherEnd}
            ry={px.ry * featherEnd}
            fill="url(#mask-overlay-grad-{i})"
            transform="rotate({mask.angle} {px.cx} {px.cy})"
            pointer-events="none"
          />
        {/if}
      {/if}
    {/each}

    <!--
    Mask gizmos. Three tiers:
      - Editing (i === editingIndex): full handles, draggable, prominent.
      - Otherwise: nothing — committed masks are invisible until the user
        clicks the pencil to enter geometry-edit mode. Keeps the photo
        clean for slider-only workflows.
  -->
    {#each masks as mask, i (i)}
      {#if i === editingIndex}
        {#if mask.kind === 'linear'}
          {@const px = linearPx(mask)}
          {@const guides = linearGuides(mask)}
          <g>
            {#if guides}
              <!-- Three parallel perpendicular lines: full / mid / zero effect. -->
              <line
                x1={guides.full.x1}
                y1={guides.full.y1}
                x2={guides.full.x2}
                y2={guides.full.y2}
                stroke="white"
                stroke-width="1.5"
                pointer-events="none"
              />
              <!-- Mid line: invisible thick hit-area for dragging, then the visible dashed line. -->
              <line
                x1={guides.mid.x1}
                y1={guides.mid.y1}
                x2={guides.mid.x2}
                y2={guides.mid.y2}
                stroke="transparent"
                stroke-width="14"
                style="cursor: grab;"
                onpointerdown={(e) => dragLinearMid(e, i, mask)}
              />
              <line
                x1={guides.mid.x1}
                y1={guides.mid.y1}
                x2={guides.mid.x2}
                y2={guides.mid.y2}
                stroke="white"
                stroke-opacity="0.7"
                stroke-width="1"
                stroke-dasharray="2 4"
                pointer-events="none"
              />
              <line
                x1={guides.zero.x1}
                y1={guides.zero.y1}
                x2={guides.zero.x2}
                y2={guides.zero.y2}
                stroke="white"
                stroke-width="1.5"
                pointer-events="none"
              />
              <text
                x={guides.ax + guides.labelOffset.dx}
                y={guides.ay + guides.labelOffset.dy}
                fill="white"
                font-size="11"
                font-family="system-ui, sans-serif"
                text-anchor="middle"
                dominant-baseline="middle"
                pointer-events="none"
                style="paint-order: stroke; stroke: rgba(0,0,0,0.6); stroke-width: 3;"
              >
                100%
              </text>
              <text
                x={guides.bx + guides.labelOffset.dx}
                y={guides.by + guides.labelOffset.dy}
                fill="white"
                font-size="11"
                font-family="system-ui, sans-serif"
                text-anchor="middle"
                dominant-baseline="middle"
                pointer-events="none"
                style="paint-order: stroke; stroke: rgba(0,0,0,0.6); stroke-width: 3;"
              >
                0%
              </text>
            {/if}
            <!-- Connecting axis from A → B (gradient direction). -->
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
            {#if guides}
              <!-- Translate handle: at the literal midpoint of AB. Rendered before
                 the mid knob so when both happen to coincide, the knob wins. -->
              <circle
                cx={guides.transPx}
                cy={guides.transPy}
                r="6"
                fill="#7dd3fc"
                fill-opacity="0.5"
                stroke="#0c4a6e"
                stroke-width="1.5"
                style="cursor: move;"
                onpointerdown={(e) => dragLinearTranslate(e, i, mask)}
              />
              <!-- Connector tick: short line from the AB axis to the offset knob,
                 so the user reads the knob as belonging to the mid line. -->
              <line
                x1={guides.midPx}
                y1={guides.midPy}
                x2={guides.knobX}
                y2={guides.knobY}
                stroke="#facc15"
                stroke-width="1.5"
                pointer-events="none"
              />
              <!-- 50% drag knob: yellow diamond, offset perpendicular from the AB
                 axis so it's clearly distinct from the translate dot and is
                 always reachable regardless of mid value. -->
              <rect
                x={guides.knobX - 6}
                y={guides.knobY - 6}
                width="12"
                height="12"
                fill="#facc15"
                stroke="#000"
                stroke-width="1"
                transform="rotate(45 {guides.knobX} {guides.knobY})"
                style="cursor: grab;"
                onpointerdown={(e) => dragLinearMid(e, i, mask)}
              />
            {/if}
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
        {:else if mask.kind === 'radial'}
          {@const px = radialPx(mask)}
          {@const featherEnd = 1 + mask.feather}
          {@const featherKnobD = px.ry * (1 + (Math.log(1 + mask.feather) / FEATHER_LOG_BASE) * KNOB_MAX_OFFSET)}
          {@const sizeHandleX = px.cx + px.rx * Math.SQRT1_2}
          {@const sizeHandleY = px.cy + px.ry * Math.SQRT1_2}
          <g style="transform: rotate({mask.angle}deg); transform-origin: {px.cx}px {px.cy}px;">
            <!-- Outer halo (where weight = 0). Only drawn when feather > 0;
               otherwise it would coincide with the main ellipse. -->
            {#if mask.feather > 0.001}
              <ellipse
                cx={px.cx}
                cy={px.cy}
                rx={px.rx * featherEnd}
                ry={px.ry * featherEnd}
                fill="none"
                stroke="#7dd3fc"
                stroke-width="1"
                stroke-dasharray="3 3"
                stroke-opacity="0.7"
                pointer-events="none"
              />
            {/if}
            <!-- Main / drawn ellipse — the solid inner boundary (everything
               inside is fully affected). -->
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
            <!-- Feather knob: yellow diamond at the top of the outer halo
               ellipse (or main top when feather = 0). Drag outward to soften,
               inward to sharpen. -->
            <rect
              x={px.cx - 6}
              y={px.cy - featherKnobD - 6}
              width="12"
              height="12"
              fill="#facc15"
              stroke="#000"
              stroke-width="1"
              transform="rotate(45 {px.cx} {px.cy - featherKnobD})"
              style="cursor: grab;"
              onpointerdown={(e) => dragRadialFeather(e, i, mask)}
            />
            <!-- Mid knob: biases the falloff curve. Only meaningful (and only
               drawn) when feather > 0. Sits on the y-axis between main top
               and the feather knob, with a small horizontal offset and
               connector tick so it reads as belonging to the falloff band. -->
            {#if mask.feather > 0.001}
              {@const midParam = Math.min(0.95, Math.max(0.05, mask.mid ?? 0.5))}
              {@const midKnobY = px.cy - px.ry - midParam * (featherKnobD - px.ry)}
              {@const midKnobX = px.cx + 18}
              <line
                x1={px.cx}
                y1={midKnobY}
                x2={midKnobX}
                y2={midKnobY}
                stroke="#facc15"
                stroke-width="1.5"
                pointer-events="none"
              />
              <rect
                x={midKnobX - 5}
                y={midKnobY - 5}
                width="10"
                height="10"
                fill="#facc15"
                stroke="#000"
                stroke-width="1"
                transform="rotate(45 {midKnobX} {midKnobY})"
                style="cursor: grab;"
                onpointerdown={(e) => dragRadialMid(e, i, mask)}
              />
            {/if}
            <!-- Size handle: scales rx and ry uniformly (preserves aspect /
               keeps a circle a circle). 4:30 position to stay clear of the
               rx (3 o'clock) and ry (6 o'clock) handles. -->
            <circle
              cx={sizeHandleX}
              cy={sizeHandleY}
              r="7"
              fill="#facc15"
              stroke="#000"
              stroke-width="1"
              style="cursor: nwse-resize;"
              onpointerdown={(e) => dragRadialSize(e, i, mask)}
            />
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
      {/if}
    {/each}

    <!-- Draw-mode preview shape (while user is dragging) -->
    {#if previewLinear}
      <line
        x1={previewLinear.ax}
        y1={previewLinear.ay}
        x2={previewLinear.bx}
        y2={previewLinear.by}
        stroke="#0ea5e9"
        stroke-width="2"
        pointer-events="none"
      />
      <circle cx={previewLinear.ax} cy={previewLinear.ay} r="6" fill="#0ea5e9" pointer-events="none" />
      <circle
        cx={previewLinear.bx}
        cy={previewLinear.by}
        r="6"
        fill="white"
        stroke="#0ea5e9"
        stroke-width="2"
        pointer-events="none"
      />
    {/if}

    {#if previewRadial}
      <ellipse
        cx={previewRadial.cx}
        cy={previewRadial.cy}
        rx={previewRadial.rx}
        ry={previewRadial.ry}
        fill="rgba(14, 165, 233, 0.1)"
        stroke="#0ea5e9"
        stroke-width="2"
        pointer-events="none"
      />
      <circle cx={previewRadial.cx} cy={previewRadial.cy} r="6" fill="#0ea5e9" pointer-events="none" />
    {/if}

    <!-- Draw-mode hint (shown before the user clicks). Brush mode owns its
       own UI (size slider) so we hide this banner there. -->
    {#if pendingKind && pendingKind !== 'brush' && !drawStart}
      <g pointer-events="none">
        <rect x={svgWidth / 2 - 140} y="20" width="280" height="32" rx="6" fill="rgba(0, 0, 0, 0.7)" />
        <text
          x={svgWidth / 2}
          y="40"
          text-anchor="middle"
          fill="white"
          font-size="13"
          font-family="system-ui, sans-serif"
        >
          {pendingKind === 'linear' ? 'Click and drag to draw the gradient' : 'Click and drag from center outward'}
        </text>
      </g>
    {/if}
  </svg>

  <!-- Brush mask overlays. Three states:
     1. pendingMaskKind === 'brush' (no committed brush mask yet) → show an
        editable brush canvas; first stroke commits a new BrushMask.
     2. editingIndex points at a brush mask → show an editable brush canvas
        bound to that mask.
     3. Any committed brush mask not currently being edited → show a
        non-interactive red tint of the painted area so the user remembers
        where the mask sits without it eating clicks. -->
  <!-- Render readonly tints first so the editing overlay (or pending paint
     surface) ends up on top in DOM order; the editing overlay has its own
     interactive canvas and accepts paint events. -->
  {#each masks as mask, i (i)}
    {#if mask.kind === 'brush' && i !== editingIndex}
      <BrushOverlay maskIndex={i} readonly />
    {/if}
  {/each}
  {#each masks as mask, i (i)}
    {#if mask.kind === 'brush' && i === editingIndex}
      <BrushOverlay maskIndex={i} />
    {/if}
  {/each}
  {#if pendingKind === 'brush'}
    <BrushOverlay maskIndex={null} />
  {/if}
</div>
