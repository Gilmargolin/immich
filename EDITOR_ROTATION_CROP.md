# Editor: rotation, crop, view-sizing, save

Reference for the rotate / crop / free-rotation-dial / save pipeline in
the web editor. This area has eaten many debugging sessions. Read this
before touching any of the files listed below.

Last working fix:  `f4af41ea6` — "stop Svelte style= blob from wiping
cropArea width/height" (2026-04-23).


## 1. Files that own this behavior

    Path                                                               Role
    -----------------------------------------------------------------  ----------------------------
    web/src/lib/components/asset-viewer/editor/editor-panel.svelte      Sidebar + orchestration
    web/src/lib/components/asset-viewer/editor/transform-tool/
        crop-area.svelte                                                Crop viewport + rotation dial
    web/src/lib/managers/edit/transform-manager.svelte.ts               Transform state + geometry
    web/src/lib/managers/edit/adjust-manager.svelte.ts                  Light/color sliders (filter)
    web/src/lib/managers/edit/edit-manager.svelte.ts                    Tool orchestration + save
    server/src/utils/transform.ts                                       getOutputDimensions math
    server/src/repositories/media.repository.ts                         applyEdits (server pipeline)


## 2. Mental model

The DOM hierarchy inside the crop tool:

    .canvas-container
      .crop-viewport                    (overflow:hidden, flex-center)
        button.crop-area                (overflow:hidden, contain:paint)
          <img>                         (the preview image)
          .crop-frame                   (white border + corner handles)
          .overlay                      (dim mask with clipPath hole)
      .rotation-dial-wrapper            (±45° dial)

Two independent CSS transforms stack:

    img.transform          = scale(imageScale) rotate(freeRotation deg)
                               * optional scaleX(-1) / scaleY(-1) for mirror
    cropArea.transform     = translate(tx,ty) rotate(imageRotation) scale(cropZoom)

`imageScale` is the cover-scale formula, computed in crop-area.svelte:

    scale = max(cosθ + (H/W)·sinθ, (W/H)·sinθ + cosθ)

At θ = 0 → 1.00. At θ = 7° on a 3:4 portrait → ~1.17. At θ = 45° → ~1.77.
This exists so the rotated image still fully covers its unrotated layout
box — without it, four transparent triangular wedges appear at the
corners of the crop frame, and every user who has seen that has called
it "rotation is broken".

`imageRotation` is the axis-aligned component (multiples of 90° from the
orientation buttons). `freeRotation` is the ±45° dial value.
`normalizedRotation` and `totalRotation` are derived sums used for save.

`cropZoom` is a Google-Photos-style "zoom into the crop after you resize
it" — only applied when freeRotation == 0 (see invariant #2 below).


## 3. Load-time invariants (state that must hold for the UI to work)

    Invariant                                                   Enforced by
    ----------------------------------------------------------  -----------------------------------
    cropArea inline width/height == displayedImageWidth/Height  applyImageSize (called from
                                                                onImageLoad, resizeCanvas)
    domImg inline width/height   == displayedImageWidth/Height  applyImageSize
    region is always inside displayedImage bounds               onImageLoad, moveCrop, resizeCrop
    cropZoom stays at 1 whenever freeRotation != 0              zoomToFillCrop early-return +
                                                                cropAreaStyle fallback
    cropImageSize = imgElement's intrinsic dims                 onImageLoad
    cropImageScale = min(viewportW/imgW, viewportH/imgH)        calculateScale


## 4. Save pipeline (client → server)

Client `transformManager.getEdits()`:
  1. If crop region differs from full display → emit Crop edit.
  2. Convert region: display-coords → preview-coords → original-coords.
  3. Apply mirror unmirror if mirror is active (crop is in *unmirrored*
     original image space on the server).
  4. Emit Mirror and Rotate edits (rotation includes normalized 90°
     increment plus freeRotation).

Server `applyEdits` (media.repository.ts) runs in a fixed order:
  extract crop → mirror → axis-aligned rotate (0/90/180/270) →
  free rotation → inscribed extract.

Server `getOutputDimensions` (server/src/utils/transform.ts) computes
the final asset dimensions using the same inscribed-rect formula as the
client cover-scale. Critical details:
  - `Math.round(totalAngle/90)` (NOT floor) — negative angles like -5°
    normalize to 355°; floor gives quadrant 3 (=270°), round gives
    quadrant 4 (=360°, i.e. no swap) which matches applyEdits.
  - Inscribed height uses the *original* width, not the reassigned one.
  - `Math.abs(freeAngle)` before the sin — negative angles flip sin's
    sign and produce iW > W otherwise.


## 5. Gotchas — things I have broken and why (read before changing)

### 5.1. Svelte `style={stringBlob}` wipes inline styles
The bug that ate ~20 iterations. If an element has inline styles set
imperatively (e.g. `element.style.width = '600px'`) AND also has a
`style={someReactiveString}` binding, every time the derived re-runs
Svelte replaces the *entire* style attribute via setAttribute('style',
...) — wiping the imperative inline styles.

This was breaking the crop-area: applyImageSize set inline width/height,
then any cropAreaStyle re-derive (on rotation, on drag, on
isInteracting flip) wiped them. cropArea fell back to CSS max-width:
100% / max-height: 100%, ballooned to viewport, and the rotated image's
cover-scale extension that had been clipped was suddenly visible.

Fix: use per-property directives — `style:transform={...}`,
`style:transition={...}`, `style:filter={...}`. These go through
element.style.setProperty and don't clobber other properties.

**Rule:** never mix `style={blob}` with imperative `element.style.prop
= ...` on the same element. Pick one.

### 5.2. Removing cover-scale on free rotation
Rejected every time (commits 881c2d92b, d81c8a5e6, d9d773748 — all
reverted). Produces transparent triangular wedges inside the crop frame
that users call "rotation is broken". Keep imageScale.

### 5.3. Auto-shrinking the frame to the inscribed rect
Rejected (commits 76426dfb8, 614cfdb09, d9d773748 — all reverted).
Users expect the frame to stay where they drew it. Don't move it
automatically when rotation changes.

### 5.4. Compound zoom (cropZoom * imageScale) while rotated
Before the fix in commit df9ac394c/6b5b37b04, cropZoom's scale() was
applied to cropArea while imageScale's scale() was applied to <img>.
After a crop-drag-release at 7° rotation, zoomToFillCrop would set
cropZoom to 3 and the visible image became 3 × 1.17 = 3.5×. Users
reported it as "image jumps out of scale". Fix: pin cropZoom to 1
whenever freeRotation != 0 (in cropAreaStyle and in zoomToFillCrop).

### 5.5. $effect that reads and writes this.region
Svelte 5 tracks state reads across method-call boundaries. An effect
that calls a method which both reads `this.region` and writes
`this.region = { ...}` re-fires infinitely because the write always
creates a new object reference. Symptom: both the rotation dial and the
crop-frame became unresponsive (commit d9d773748, reverted).
Fix: value-equality guard before writing, or call from handlers
instead of an effect.

### 5.6. Negative free-rotation angles break server inscribed math
Three separate bugs in getOutputDimensions for negative angles — fixed
in a single commit earlier. See section 4. Any change to the server
math must preserve `Math.round` (not floor), original-width use, and
`Math.abs(freeAngle)`.

### 5.7. Cached preview race
HTMLImageElement's `load` event can fire synchronously when the src is
already in cache. If the listener is attached after `.src = url`, the
load callback may never run → transformManager stays at defaults
→ save serializes a 100×100 top-left crop.

Fix (in onActivate):
  - attach `load` listener *before* setting .src
  - after setting .src, check `img.complete && img.naturalWidth > 0`
    and invoke onImageLoad manually

### 5.8. Editor opened in adjust-mode, saved without touching crop
CropArea.svelte only mounts in crop mode. onImageLoad bails if
cropAreaEl isn't bound. If the user saves from adjust mode, getEdits()
would return state defaults — overwriting any real saved crop with a
100×100 top-left rect.

Fix: store `initialEdits` at onActivate; `isImageLoaded` flag; in
getEdits() pass through initialEdits if !isImageLoaded; rehydrate
from CropArea's onMount via rehydrateIfReady().

### 5.9. ResizeObserver on the <img>
Creates a feedback loop because JS drives img size via applyImageSize.
Observe the outer canvasContainer instead.

### 5.10. calculateScale for 90°/270° (orientationChanged)
Needs to swap img.width and img.height when computing scale — the
rotated content's bounding box is the *swapped* dims. Without this, a
rotated portrait extends past the viewport horizontally.

### 5.11a. Saved output narrower than drawn — inscribed-extract shrink
Server pipeline is `crop → mirror → axis-align rotate → free rotate →
inscribed extract`. The final step shrinks a W×H crop to
`((W cosθ − H sinθ)/cos 2θ) × ((H cosθ − W sinθ)/cos 2θ)`. Without
compensation the editor shows W×H (via imageScale cover-up of the
rotated image) but the saved file is the *inscribed* output — always
narrower and at a different aspect ratio.

Fix: in `TransformManager.getEdits()` expand the Crop before sending,
applying the cover-scale inverse:
`W' = W cosθ + H sinθ`, `H' = H cosθ + W sinθ`. Server inscribes
W'×H' back to exactly W×H. Formula is symmetric in W,H so it works
regardless of 90°/270° axis-align rotation. Clamp to original image
bounds after expansion in case it exceeds the image edge.

### 5.11. Reading non-reactive DOM properties in a $derived
HTMLImageElement's `.width` / `.height` / `.naturalWidth` / `.complete`
are plain native properties, not Svelte state. Reading them inside a
`$derived.by(...)` does NOT subscribe the derived to their changes —
so the derived only re-runs when *other* tracked deps change.

Concrete trap: on re-opening an asset with a pre-existing free
rotation, onActivate sets `freeRotation` before the preview finishes
loading. If `imageScale` is computed as
`$derived.by(() => ...img.width...)`, the derived runs once with
img.width = 0, returns 1 (no cover-scale), and never re-runs when
the image finally loads. Result: black triangular wedges appear at
the crop-frame corners in the editor.

Fix: read a $state field that IS updated on image load. For this
editor, use `transformManager.cropImageSize` (set in onImageLoad)
instead of `img.width` / `img.height`.

Last working fix: commit for the "rotate → save → edit again"
bug. Search `reading cropImageSize` in crop-area.svelte.


## 6. Regression checklist (run manually before shipping changes here)

Before pushing any change to the files in section 1:

  - [ ] Open an untouched photo. Rotate dial to +7°. Image stays the
        same visual size, no wedges visible in the frame. Frame stays
        full-size.
  - [ ] Release dial. Image stays as it was (no snap).
  - [ ] Drag a crop-frame corner inward while rotated. Image must NOT
        stretch, zoom, or shift. Frame shrinks normally. [This is the
        regression gate — the old style-blob bug failed here.]
  - [ ] Release the corner. No sudden zoom. Frame stays where dragged.
  - [ ] Return rotation to 0°. Drag a frame corner. Frame shrinks,
        then on release the image zooms in to fit the crop
        (Google-Photos style). This is intentional behavior at 0°.
  - [ ] Rotate 90° via the orientation button. Image orients correctly
        and fits the viewport.
  - [ ] Save a rotated+cropped edit. Re-open. The editor shows the
        saved state with the same framing; aspect ratio did not drift.
  - [ ] Save an adjust-only edit (don't enter crop mode). The saved
        output preserves any pre-existing crop/rotation.
  - [ ] Save a rotated crop. Close the editor. Re-open on the SAME
        asset. The crop frame shows cover-scaled rotated content with
        NO black/transparent wedges at the frame corners. [Gate for
        the non-reactive img.width trap in §5.11.]


## 7. Where to add new logging

For diagnostics without reverting, add console.info lines tagged
`[editor-debug]` inside:
  - transformManager.zoomToFillCrop (start + early-return branches)
  - transformManager.onImageLoad (after state set)
  - crop-area.svelte's cropTransform derived (log computed tx/ty/zoom)
  - crop-area.svelte's imageScale derived (log theta, scale)

Always remove after debugging — the user has asked that debug logs not
ship in deploys.
