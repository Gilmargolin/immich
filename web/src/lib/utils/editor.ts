import type { EditActions } from '$lib/managers/edit/edit-manager.svelte';
import type { MirrorParameters, RotateParameters } from '@immich/sdk';
import { compose, flipX, flipY, identity, rotate } from 'transformation-matrix';

const isCloseToZero = (x: number, epsilon: number = 1e-15) => Math.abs(x) < epsilon;

export const normalizeTransformEdits = (
  edits: EditActions,
): {
  rotation: number;
  mirrorHorizontal: boolean;
  mirrorVertical: boolean;
} => {
  const { a, b, c, d } = buildAffineFromEdits(edits);

  // Recover the stored angle that buildAffineFromEdits encoded as
  // rotate(-angle*π/180). The library matrix has b=sin, c=-sin, so
  // matrix_angle = atan2(b, a) and stored_angle = -matrix_angle = atan2(c, a).
  const rotation = (Math.atan2(c, a) * 180) / Math.PI;
  const normalizedRotation = rotation < 0 ? 360 + rotation : rotation;

  // Detect mirroring by checking if the determinant is negative
  const det = a * d - b * c;
  const isMirrored = det < 0;

  return {
    rotation: normalizedRotation,
    mirrorHorizontal: false,
    mirrorVertical: isMirrored,
  };
};

export const buildAffineFromEdits = (edits: EditActions) =>
  compose(
    identity(),
    ...edits.map((edit) => {
      switch (edit.action) {
        case 'rotate': {
          const parameters = edit.parameters as RotateParameters;
          const angleInRadians = (-parameters.angle * Math.PI) / 180;
          return rotate(angleInRadians);
        }
        case 'mirror': {
          const parameters = edit.parameters as MirrorParameters;
          return parameters.axis === 'horizontal' ? flipY() : flipX();
        }
        default: {
          return identity();
        }
      }
    }),
  );
