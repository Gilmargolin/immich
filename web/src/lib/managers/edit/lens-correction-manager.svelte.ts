import type { EditAction, EditActions, EditToolManager } from '$lib/managers/edit/edit-manager.svelte';
import { AssetEditAction, getAssetLensProfile, type AssetResponseDto } from '@immich/sdk';

export interface LensCorrectionState {
  // 0..1, scales the auto-resolved coefficients. Defaults to 1 when a profile
  // matched (full auto-correction) and 0 when no profile matched (no-op).
  distortionStrength: number;
  // -1..1, purely manual user input (no auto component).
  keystoneH: number;
  keystoneV: number;
}

export interface ResolvedLensProfile {
  hasProfile: boolean;
  k1: number;
  k2: number;
  k3: number;
  displayName: string | null;
  cameraMake: string | null;
  cameraModel: string | null;
  lensModel: string | null;
  focalLength: number | null;
}

const defaultState: LensCorrectionState = {
  distortionStrength: 0,
  keystoneH: 0,
  keystoneV: 0,
};

const isDefault = (s: LensCorrectionState): boolean =>
  s.distortionStrength === 0 && s.keystoneH === 0 && s.keystoneV === 0;

const emptyProfile = (): ResolvedLensProfile => ({
  hasProfile: false,
  k1: 0,
  k2: 0,
  k3: 0,
  displayName: null,
  cameraMake: null,
  cameraModel: null,
  lensModel: null,
  focalLength: null,
});

export class LensCorrectionManager implements EditToolManager {
  state = $state<LensCorrectionState>({ ...defaultState });
  profile = $state<ResolvedLensProfile>(emptyProfile());
  private initialState = $state<LensCorrectionState>({ ...defaultState });

  hasChanges = $derived(
    this.state.distortionStrength !== this.initialState.distortionStrength ||
      this.state.keystoneH !== this.initialState.keystoneH ||
      this.state.keystoneV !== this.initialState.keystoneV,
  );

  canReset = $derived(!isDefault(this.state));

  // Shader-friendly view of the coefficients. The fragment shader multiplies
  // by distortionStrength to keep itself simple; this matches what the server
  // does when applying the edit on save.
  shaderUniforms = $derived({
    k1: this.profile.k1,
    k2: this.profile.k2,
    k3: this.profile.k3,
    distortionStrength: this.state.distortionStrength,
    keystoneH: this.state.keystoneH,
    keystoneV: this.state.keystoneV,
  });

  edits = $derived.by((): EditAction[] => {
    if (isDefault(this.state)) {
      return [];
    }
    return [
      {
        action: AssetEditAction.LensCorrection,
        parameters: {
          distortionStrength: this.state.distortionStrength,
          k1: this.profile.k1,
          k2: this.profile.k2,
          k3: this.profile.k3,
          keystoneH: this.state.keystoneH,
          keystoneV: this.state.keystoneV,
        },
      },
    ];
  });

  async onActivate(asset: AssetResponseDto, edits: EditActions): Promise<void> {
    // Fetch the resolved profile fresh on every activation — EXIF can't change
    // mid-session, but a fork could change the on-disk profile DB so we keep
    // server as the source of truth rather than caching across sessions.
    try {
      const dto = await getAssetLensProfile({ id: asset.id });
      this.profile = {
        hasProfile: dto.hasProfile,
        k1: dto.k1,
        k2: dto.k2,
        k3: dto.k3,
        displayName: dto.displayName ?? null,
        cameraMake: dto.cameraMake ?? null,
        cameraModel: dto.cameraModel ?? null,
        lensModel: dto.lensModel ?? null,
        focalLength: dto.focalLength ?? null,
      };
    } catch {
      // Network error or endpoint missing — fall back to "no profile". The
      // keystone sliders still work, just the distortion slider stays disabled.
      this.profile = emptyProfile();
    }

    const existing = edits.find((e) => e.action === AssetEditAction.LensCorrection);
    if (existing) {
      // Re-hydrate from a previously-saved edit; coefficients in the saved
      // edit are trusted as-is so the round-trip stays byte-stable even if
      // the profile DB changes between sessions.
      const p = existing.parameters as {
        distortionStrength: number;
        k1: number;
        k2: number;
        k3: number;
        keystoneH: number;
        keystoneV: number;
      };
      this.state = {
        distortionStrength: p.distortionStrength,
        keystoneH: p.keystoneH,
        keystoneV: p.keystoneV,
      };
      // Reuse the saved coefficients so the live preview matches the saved
      // render even if the on-disk profile DB has drifted.
      this.profile = { ...this.profile, k1: p.k1, k2: p.k2, k3: p.k3 };
      this.initialState = { ...this.state };
    } else {
      // No prior edit. Default the strength to "full" if we matched a profile
      // (auto-correct as a useful baseline); otherwise 0 (no-op).
      const strength = this.profile.hasProfile ? 1 : 0;
      this.state = { ...defaultState, distortionStrength: strength };
      this.initialState = { ...this.state };
    }
  }

  onDeactivate(): void {
    // no cleanup
  }

  async resetAllChanges(): Promise<void> {
    const strength = this.profile.hasProfile ? 1 : 0;
    this.state = { ...defaultState, distortionStrength: strength };
    this.initialState = { ...this.state };
  }

  setDistortionStrength(value: number): void {
    this.state = { ...this.state, distortionStrength: Math.min(1, Math.max(0, value)) };
  }

  setKeystoneH(value: number): void {
    this.state = { ...this.state, keystoneH: Math.min(1, Math.max(-1, value)) };
  }

  setKeystoneV(value: number): void {
    this.state = { ...this.state, keystoneV: Math.min(1, Math.max(-1, value)) };
  }
}

export const lensCorrectionManager = new LensCorrectionManager();
