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

  // Schema bound on RadialMask.feather (0–100, stored as percentage of radius).
  // featherSpan in the math = feather / 100, so feather=100 → soft zone spans
  // one full radius beyond the ellipse edge.
  const FEATHER_MAX = 100;
  // Linear knob: the diamond sits exactly at the outer soft-zone boundary.
  //   D = ry · (1 + feather / 100)
  //   feather=0   → D = ry    (on the ellipse edge, sharp)
  //   feather=50  → D = 1.5·ry
  //   feather=100 → D = 2·ry  (outer limit, very soft)
  // Drag inverse: feather = (D/ry − 1) · 100, clamped to [0, 100].
  const dragRadialFeather = (e: PointerEvent, idx: number, mask: RadialMask) => {
    adjustManager.selectMask(idx);
    const ryPx = Math.max(1, mask.ry * Math.min(svgWidth, svgHeight));
    const cyPx = mask.cy * svgHeight;
    startDrag(e, ({ ny }) => {
      const distFromCenter = Math.max(0, cyPx - ny * svgHeight);
      const feather = Math.max(0, Math.min(FEATHER_MAX, (distFromCenter / ryPx - 1) * 100));
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
    // y of the feather knob (linear: knob sits at the outer soft-zone boundary):
    const featherKnobY = cyPx - ryPx * (1 + mask.feather / 100);
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

  // ---------- Escape key cancels draw mode ----------

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && adjustManager.pendingMaskKind) {
      drawStart = null;
      drawCurrent = null;
      adjustManager.cancelDrawingMask();
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

<svelte:window onkeydown={onKeyDown} />

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
            {@const featherEnd = 1 + mask.feather / 100}
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
          {@const featherEnd = 1 + mask.feather / 100}
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
          {@const featherEnd = 1 + mask.feather / 100}
          {@const featherKnobD = px.ry * (1 + mask.feather / 100)}
          <g style="transform: rotate({mask.angle}deg); transform-origin: {px.cx}px {px.cy}px;">
            <!-- Outer halo (feather zone boundary). Only when feather > 0. -->
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
                stroke-opacity="0.6"
                pointer-events="none"
              />
            {/if}
            <!-- Main ellipse — solid inner boundary. -->
            <ellipse
              cx={px.cx}
              cy={px.cy}
              rx={px.rx}
              ry={px.ry}
              fill="none"
              stroke="#7dd3fc"
              stroke-width="1.5"
              stroke-dasharray="6 4"
              pointer-events="none"
            />
            <!-- Feather knob: small diamond above. Drag up = more feather. -->
            <rect
              x={px.cx - 5}
              y={px.cy - featherKnobD - 5}
              width="10"
              height="10"
              fill="#facc15"
              stroke="rgba(0,0,0,0.5)"
              stroke-width="1"
              transform="rotate(45 {px.cx} {px.cy - featherKnobD})"
              style="cursor: grab;"
              onpointerdown={(e) => dragRadialFeather(e, i, mask)}
            />
            <!-- Center handle: move. -->
            <circle
              cx={px.cx}
              cy={px.cy}
              r="6"
              fill="#0ea5e9"
              stroke="white"
              stroke-width="1.5"
              style="cursor: move;"
              onpointerdown={(e) => dragRadialCenter(e, i, mask)}
            />
            <!-- Right edge handle: resize rx (E). -->
            <circle
              cx={px.cx + px.rx}
              cy={px.cy}
              r="5"
              fill="white"
              stroke="#0ea5e9"
              stroke-width="1.5"
              style="cursor: ew-resize;"
              onpointerdown={(e) => dragRadialRx(e, i, mask)}
            />
            <!-- Bottom edge handle: resize ry (S). -->
            <circle
              cx={px.cx}
              cy={px.cy + px.ry}
              r="5"
              fill="white"
              stroke="#0ea5e9"
              stroke-width="1.5"
              style="cursor: ns-resize;"
              onpointerdown={(e) => dragRadialRy(e, i, mask)}
            />
          </g>
        {/if}
      {/if}
    {/each}

    <!-- Draw-mode preview shape (while user is dragging) -->
    {#if previewLinear}
      {@const lp = previewLinear}
      {@const ldx = lp.bx - lp.ax}
      {@const ldy = lp.by - lp.ay}
      {@const llen = Math.hypot(ldx, ldy)}
      {@const lext = Math.max(svgWidth, svgHeight) * 2}
      <!-- Semi-transparent red gradient overlay along drag direction -->
      <defs>
        <linearGradient id="preview-linear-grad" x1={lp.ax} y1={lp.ay} x2={lp.bx} y2={lp.by} gradientUnits="userSpaceOnUse">
          <stop offset="0" stop-color="#ef4444" stop-opacity="0.25" />
          <stop offset="1" stop-color="#ef4444" stop-opacity="0" />
        </linearGradient>
      </defs>
      <rect x="0" y="0" width={svgWidth} height={svgHeight} fill="url(#preview-linear-grad)" pointer-events="none" />
      <!-- Perpendicular guide lines at start (full effect) and current (zero effect) -->
      {#if llen > 1}
        {@const pnx = -ldy / llen}
        {@const pny = ldx / llen}
        <line
          x1={lp.ax - pnx * lext} y1={lp.ay - pny * lext}
          x2={lp.ax + pnx * lext} y2={lp.ay + pny * lext}
          stroke="white" stroke-width="1.5" stroke-dasharray="4 4" stroke-opacity="0.8"
          style="filter: drop-shadow(0 0 2px rgba(0,0,0,0.8))"
          pointer-events="none"
        />
        <line
          x1={lp.bx - pnx * lext} y1={lp.by - pny * lext}
          x2={lp.bx + pnx * lext} y2={lp.by + pny * lext}
          stroke="white" stroke-width="1.5" stroke-dasharray="4 4" stroke-opacity="0.5"
          style="filter: drop-shadow(0 0 2px rgba(0,0,0,0.8))"
          pointer-events="none"
        />
      {/if}
      <!-- Main axis line from start to current -->
      <line
        x1={lp.ax} y1={lp.ay} x2={lp.bx} y2={lp.by}
        stroke="white" stroke-width="2" stroke-dasharray="4 4"
        style="filter: drop-shadow(0 0 2px rgba(0,0,0,0.8))"
        pointer-events="none"
      />
      <!-- Point A marker (full effect) -->
      <circle cx={lp.ax} cy={lp.ay} r="6" fill="#3b82f6" stroke="white" stroke-width="2" pointer-events="none" />
      <!-- Point B marker (zero effect) -->
      <circle cx={lp.bx} cy={lp.by} r="6" fill="transparent" stroke="white" stroke-width="2" pointer-events="none" />
    {/if}

    {#if previewRadial}
      {@const pr = previewRadial}
      <!-- Main ellipse with dashed stroke -->
      <ellipse
        cx={pr.cx} cy={pr.cy} rx={pr.rx} ry={pr.ry}
        fill="rgba(239,68,68,0.1)"
        stroke="white" stroke-width="2" stroke-dasharray="6 3"
        style="filter: drop-shadow(0 0 2px rgba(0,0,0,0.8))"
        pointer-events="none"
      />
      <!-- Feather halo (default feather ≈ 20 → 1.2× radius) -->
      <ellipse
        cx={pr.cx} cy={pr.cy} rx={pr.rx * 1.2} ry={pr.ry * 1.2}
        fill="none"
        stroke="rgba(255,255,255,0.4)" stroke-width="1" stroke-dasharray="3 3"
        pointer-events="none"
      />
      <!-- Center dot -->
      <circle cx={pr.cx} cy={pr.cy} r="4" fill="#3b82f6" stroke="white" stroke-width="1.5" pointer-events="none" />
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
