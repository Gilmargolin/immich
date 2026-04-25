import type { EditAction } from '$lib/managers/edit/edit-manager.svelte';

// In-memory clipboard for "copy adjustments" → "paste to selection". Lives
// for the duration of the page session; not persisted across reloads (the
// expected workflow is dial in adjustments on one photo, then apply to a
// fresh batch immediately).
//
// Only the `adjust` action is stored. Crop/rotate/mirror are inherently
// image-specific (a crop centered on a face won't land right on another
// photo) so they aren't included even if the source image had them — the
// caller filters before copy.
class EditsClipboard {
  private state = $state<{ sourceAssetId: string; edits: EditAction[] } | null>(null);

  hasContent = $derived(this.state !== null);
  sourceAssetId = $derived(this.state?.sourceAssetId ?? null);

  // Returns the edits to paste, optionally with local masks stripped.
  getEdits(includeMasks: boolean): EditAction[] | null {
    if (!this.state) {
      return null;
    }
    if (includeMasks) {
      return this.state.edits;
    }
    return this.state.edits.map((edit) => {
      if (edit.action !== 'adjust') {
        return edit;
      }
      // Strip masks from adjust parameters when the user opted to skip them
      // (e.g. mask geometry won't align across different framings).
      const { masks: _masks, ...rest } = edit.parameters as { masks?: unknown };
      return { ...edit, parameters: rest } as EditAction;
    });
  }

  copy(sourceAssetId: string, edits: EditAction[]): void {
    // Only batch-paste-able edits: keep adjust, drop the rest.
    const filtered = edits.filter((e) => e.action === 'adjust');
    if (filtered.length === 0) {
      this.state = null;
      return;
    }
    this.state = { sourceAssetId, edits: filtered };
  }

  clear(): void {
    this.state = null;
  }
}

export const editsClipboard = new EditsClipboard();
