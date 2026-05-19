import { ApiExtraModels, ApiProperty, getSchemaPath } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import {
  IsAxisAlignedRotation,
  IsLumHighGteLow,
  IsUniqueEditActions,
  ValidateEnum,
  ValidateUUID,
} from 'src/validation';

export enum AssetEditAction {
  Crop = 'crop',
  Rotate = 'rotate',
  Mirror = 'mirror',
  Adjust = 'adjust',
  // Fork-custom: lens-distortion + keystone correction. Auto-resolved
  // coefficients come from the client's lens-profile lookup; the server just
  // runs the inverse remap.
  LensCorrection = 'lensCorrection',
}

export enum MirrorAxis {
  Horizontal = 'horizontal',
  Vertical = 'vertical',
}

export class CropParameters {
  @IsInt()
  @Min(0)
  @ApiProperty({ description: 'Top-Left X coordinate of crop' })
  x!: number;

  @IsInt()
  @Min(0)
  @ApiProperty({ description: 'Top-Left Y coordinate of crop' })
  y!: number;

  @IsInt()
  @Min(1)
  @ApiProperty({ description: 'Width of the crop' })
  width!: number;

  @IsInt()
  @Min(1)
  @ApiProperty({ description: 'Height of the crop' })
  height!: number;
}

export class RotateParameters {
  @IsAxisAlignedRotation()
  @ApiProperty({ description: 'Rotation angle in degrees (0-360, supports fractional values for free rotation)' })
  angle!: number;
}

export class MirrorParameters {
  @IsEnum(MirrorAxis)
  @ApiProperty({ enum: MirrorAxis, enumName: 'MirrorAxis', description: 'Axis to mirror along' })
  axis!: MirrorAxis;
}

// The nine tonal/color sliders — used both for the global Adjust action and
// for each local mask (so masks don't recursively contain more masks).
export class AdjustmentSliders {
  @IsNumber()
  @Min(-1)
  @Max(1)
  @ApiProperty({ description: 'Brightness adjustment (-1 to 1, 0 = no change)' })
  brightness!: number;

  @IsNumber()
  @Min(-1)
  @Max(1)
  @ApiProperty({ description: 'Contrast adjustment (-1 to 1, 0 = no change)' })
  contrast!: number;

  @IsNumber()
  @Min(-1)
  @Max(1)
  @ApiProperty({ description: 'Saturation adjustment (-1 to 1, 0 = no change)' })
  saturation!: number;

  @IsNumber()
  @Min(-1)
  @Max(1)
  @ApiProperty({ description: 'Warmth / color temperature adjustment (-1 to 1, 0 = no change)' })
  warmth!: number;

  @IsNumber()
  @Min(-1)
  @Max(1)
  @ApiProperty({ description: 'Tint adjustment, green vs magenta (-1 to 1, 0 = no change)' })
  tint!: number;

  @IsNumber()
  @Min(-1)
  @Max(1)
  @ApiProperty({ description: 'Highlights adjustment (-1 to 1, 0 = no change)' })
  highlights!: number;

  @IsNumber()
  @Min(-1)
  @Max(1)
  @ApiProperty({ description: 'Shadows adjustment (-1 to 1, 0 = no change)' })
  shadows!: number;

  @IsNumber()
  @Min(-1)
  @Max(1)
  @ApiProperty({ description: 'White point adjustment (-1 to 1, 0 = no change)' })
  whitePoint!: number;

  @IsNumber()
  @Min(-1)
  @Max(1)
  @ApiProperty({ description: 'Black point adjustment (-1 to 1, 0 = no change)' })
  blackPoint!: number;
}

export enum LocalMaskKind {
  Linear = 'linear',
  Radial = 'radial',
  Brush = 'brush',
}

// Hard cap on the brush mask payload. A 512×512 grayscale PNG with deflate
// typically lands in 30–80 KB; the 300 KB cap leaves comfortable headroom for
// noisy brush patterns that compress poorly while still keeping a single
// adjust action well under typical DB row size budgets even with the
// MAX_MASKS=8 limit (worst case: ~2.4 MB of brush data per asset).
export const BRUSH_MASK_MAX_BYTES = 300_000;
// Fixed canvas resolution for the brush mask, in pixels. Must match the
// resolution the web overlay rasterizes to (see brush-overlay.svelte) and the
// resolution the server decodes to (see precomputeMask in media.repository.ts).
export const BRUSH_MASK_RESOLUTION = 512;

// Linear gradient mask. Point A = weight 1, Point B = weight 0; smooth falloff
// in between. Coordinates are normalized to the post-crop output: x divided by
// output width, y divided by output height (both in [0, 1]).
export class LinearMask {
  @IsEnum(LocalMaskKind)
  @ApiProperty({ enum: LocalMaskKind, enumName: 'LocalMaskKind', description: 'Mask kind discriminator' })
  kind!: LocalMaskKind.Linear;

  @IsNumber()
  @Min(0)
  @Max(1)
  @ApiProperty({ description: 'Normalized x of point A (weight=1)' })
  ax!: number;
  @IsNumber()
  @Min(0)
  @Max(1)
  @ApiProperty({ description: 'Normalized y of point A (weight=1)' })
  ay!: number;
  @IsNumber()
  @Min(0)
  @Max(1)
  @ApiProperty({ description: 'Normalized x of point B (weight=0)' })
  bx!: number;
  @IsNumber()
  @Min(0)
  @Max(1)
  @ApiProperty({ description: 'Normalized y of point B (weight=0)' })
  by!: number;

  @IsOptional()
  @IsNumber()
  @Min(0.05)
  @Max(0.95)
  @ApiProperty({
    required: false,
    description:
      'Position along AB where weight = 0.5 (0..1, default 0.5). Move toward A or B to bias the falloff curve away from a pure linear ramp.',
  })
  mid?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1)
  @ApiProperty({
    required: false,
    description:
      'Luminance gate lower bound (0..1, default 0). Pixels with Rec.709 ' +
      'luminance below lumLow receive less mask weight, smoothly falling to ' +
      'zero over a fixed band. Use together with lumHigh to limit a mask to ' +
      'a luminance range (e.g. only the dark feathers of a bird).',
  })
  lumLow?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1)
  @IsLumHighGteLow()
  @ApiProperty({
    required: false,
    description:
      'Luminance gate upper bound (0..1, default 1). Pixels with luminance ' +
      'above lumHigh receive less mask weight, smoothly falling to zero. ' +
      'Must satisfy lumLow ≤ lumHigh.',
  })
  lumHigh?: number;

  @IsOptional()
  @IsNumber()
  @Min(0.01)
  @Max(0.5)
  @ApiProperty({
    required: false,
    description:
      'Width of the feather band on each side of the luminance gate (0.01..0.5, default 0.05). ' +
      'Larger values produce a wider, softer transition at the lumLow and lumHigh boundaries.',
  })
  lumFeather?: number;

  @ValidateNested()
  @Type(() => AdjustmentSliders)
  @ApiProperty({ description: 'Adjustments to apply where this mask has weight > 0' })
  params!: AdjustmentSliders;
}

// Radial (ellipse) mask. Center + semi-axes + rotation; soft feather band at
// the edge. cx/cy normalized to output width/height; rx/ry normalized to the
// shorter image side (so rx=ry=0.5 is a circle of diameter min(W, H)).
export class RadialMask {
  @IsEnum(LocalMaskKind)
  @ApiProperty({ enum: LocalMaskKind, enumName: 'LocalMaskKind', description: 'Mask kind discriminator' })
  kind!: LocalMaskKind.Radial;

  @IsNumber()
  @Min(0)
  @Max(1)
  @ApiProperty({ description: 'Normalized x of ellipse center' })
  cx!: number;
  @IsNumber()
  @Min(0)
  @Max(1)
  @ApiProperty({ description: 'Normalized y of ellipse center' })
  cy!: number;
  @IsNumber()
  @Min(0)
  @Max(2)
  @ApiProperty({ description: 'Normalized x-semi-axis (to min(W,H))' })
  rx!: number;
  @IsNumber()
  @Min(0)
  @Max(2)
  @ApiProperty({ description: 'Normalized y-semi-axis (to min(W,H))' })
  ry!: number;
  @IsNumber()
  @Min(-360)
  @Max(360)
  @ApiProperty({ description: 'Ellipse rotation in degrees' })
  angle!: number;
  @IsNumber()
  @Min(0)
  @Max(100)
  @ApiProperty({
    description:
      'Width of the outer falloff halo, as a fraction of the semi-axis. ' +
      'The drawn ellipse is always the solid inner boundary (weight = 1 ' +
      'anywhere inside). Weight transitions from 1 at the ellipse to 0 at ' +
      '(1 + feather)·r outside. 0 = sharp edge. The wide upper bound (100) ' +
      'lets users feather a small "focus spot" out across an entire image.',
  })
  feather!: number;
  @IsBoolean()
  @ApiProperty({ description: 'False = weight 1 inside ellipse; true = weight 1 outside' })
  invert!: boolean;

  @IsOptional()
  @IsNumber()
  @Min(0.05)
  @Max(0.95)
  @ApiProperty({
    required: false,
    description:
      'Position within the outer falloff band where weight = 0.5 (0..1, default 0.5). ' +
      'Bias toward 0 to keep the falloff sharp near the inner edge; toward 1 to keep it sharp near the outer edge.',
  })
  mid?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1)
  @ApiProperty({
    required: false,
    description:
      'Luminance gate lower bound (0..1, default 0). Pixels with Rec.709 ' +
      'luminance below lumLow receive less mask weight, smoothly falling to ' +
      'zero over a fixed band. Use together with lumHigh to limit a mask to ' +
      'a luminance range (e.g. only the dark feathers of a bird).',
  })
  lumLow?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1)
  @IsLumHighGteLow()
  @ApiProperty({
    required: false,
    description:
      'Luminance gate upper bound (0..1, default 1). Pixels with luminance ' +
      'above lumHigh receive less mask weight, smoothly falling to zero. ' +
      'Must satisfy lumLow ≤ lumHigh.',
  })
  lumHigh?: number;

  @IsOptional()
  @IsNumber()
  @Min(0.01)
  @Max(0.5)
  @ApiProperty({
    required: false,
    description:
      'Width of the feather band on each side of the luminance gate (0.01..0.5, default 0.05). ' +
      'Larger values produce a wider, softer transition at the lumLow and lumHigh boundaries.',
  })
  lumFeather?: number;

  @ValidateNested()
  @Type(() => AdjustmentSliders)
  @ApiProperty({ description: 'Adjustments to apply where this mask has weight > 0' })
  params!: AdjustmentSliders;
}

// Freehand brush mask. The user paints directly onto the photo; the painted
// region (and only that region) gets `params` applied.
//
// Storage format: a base64-encoded grayscale PNG of fixed resolution
// (BRUSH_MASK_RESOLUTION × BRUSH_MASK_RESOLUTION). The string field carries
// either a raw base64 payload OR a `data:image/png;base64,...` data URL —
// the server strips the prefix when decoding. Pixel value 255 = fully painted
// (weight 1.0); 0 = unpainted (weight 0.0); intermediate bytes give soft
// edges. The mask is sampled bilinearly in image-space coordinates, so it
// always covers the whole image regardless of the image's aspect ratio
// (square mask stretched to fit) — no extra geometry fields are needed.
export class BrushMask {
  @IsEnum(LocalMaskKind)
  @ApiProperty({ enum: LocalMaskKind, enumName: 'LocalMaskKind', description: 'Mask kind discriminator' })
  kind!: LocalMaskKind.Brush;

  @IsString()
  @MinLength(1)
  @MaxLength(BRUSH_MASK_MAX_BYTES)
  @ApiProperty({
    description:
      'Base64-encoded grayscale PNG of the painted alpha mask. ' +
      'Either a raw base64 string or a `data:image/png;base64,...` data URL is accepted. ' +
      `Resolution is fixed at ${BRUSH_MASK_RESOLUTION}×${BRUSH_MASK_RESOLUTION} ` +
      `and the encoded payload must be ≤ ${BRUSH_MASK_MAX_BYTES} characters.`,
  })
  mask!: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1)
  @ApiProperty({
    required: false,
    description:
      'Luminance gate lower bound (0..1, default 0). Combine with lumHigh to ' +
      'restrict the brush effect to a luminance range — e.g. paint a region ' +
      'and only affect the dark feathers within it.',
  })
  lumLow?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1)
  @IsLumHighGteLow()
  @ApiProperty({
    required: false,
    description: 'Luminance gate upper bound (0..1, default 1). Must satisfy lumLow ≤ lumHigh.',
  })
  lumHigh?: number;

  @IsOptional()
  @IsNumber()
  @Min(0.01)
  @Max(0.5)
  @ApiProperty({
    required: false,
    description:
      'Width of the feather band on each side of the luminance gate (0.01..0.5, default 0.05). ' +
      'Larger values produce a wider, softer transition at the lumLow and lumHigh boundaries.',
  })
  lumFeather?: number;

  @ValidateNested()
  @Type(() => AdjustmentSliders)
  @ApiProperty({ description: 'Adjustments to apply where this mask has weight > 0' })
  params!: AdjustmentSliders;
}

export type LocalMask = LinearMask | RadialMask | BrushMask;

@ApiExtraModels(LinearMask, RadialMask, BrushMask)
export class AdjustParameters extends AdjustmentSliders {
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(8)
  @ValidateNested({ each: true })
  @Type(() => Object, {
    discriminator: {
      property: 'kind',
      subTypes: [
        { value: LinearMask, name: LocalMaskKind.Linear },
        { value: RadialMask, name: LocalMaskKind.Radial },
        { value: BrushMask, name: LocalMaskKind.Brush },
      ],
    },
    keepDiscriminatorProperty: true,
  })
  @ApiProperty({
    description: 'Optional local-adjustment masks (up to 8). Stack in order; later masks layer on top.',
    isArray: true,
    anyOf: [LinearMask, RadialMask, BrushMask].map((type) => ({ $ref: getSchemaPath(type) })),
  })
  masks?: LocalMask[];
}

// Fork-custom: combined radial-distortion + perspective-keystone correction.
// The client resolves (k1, k2, k3) from a lens-profile lookup before sending
// — the server just runs the inverse remap with whatever coefficients arrive,
// so the lens-profile DB lives in one place (server JSON) but the apply path
// stays stateless w.r.t. EXIF.
export class LensCorrectionParameters {
  @IsNumber()
  @Min(0)
  @Max(1)
  @ApiProperty({
    description:
      'Strength multiplier applied to the auto-resolved profile coefficients (0 = bypass, 1 = full correction). ' +
      'Does not affect keystone — keystone always uses its own values directly.',
  })
  distortionStrength!: number;

  // Radial distortion polynomial coefficients, normalized so that r = 1 is
  // half the image diagonal. r' = r * (1 + k1·r² + k2·r⁴ + k3·r⁶). These
  // come from the resolved lens profile on the client; if the lens has no
  // profile match, all three are zero and the radial pass is a no-op.
  @IsNumber()
  @Min(-1)
  @Max(1)
  @ApiProperty({ description: 'Radial distortion coefficient k1 (r² term). 0 disables this term.' })
  k1!: number;

  @IsNumber()
  @Min(-1)
  @Max(1)
  @ApiProperty({ description: 'Radial distortion coefficient k2 (r⁴ term). 0 disables this term.' })
  k2!: number;

  @IsNumber()
  @Min(-1)
  @Max(1)
  @ApiProperty({ description: 'Radial distortion coefficient k3 (r⁶ term). 0 disables this term.' })
  k3!: number;

  @IsNumber()
  @Min(-1)
  @Max(1)
  @ApiProperty({
    description:
      'Horizontal keystone (-1 = lean left, 0 = none, 1 = lean right). Applied as a projective transform; ' +
      'no auto-resolved component — purely user input.',
  })
  keystoneH!: number;

  @IsNumber()
  @Min(-1)
  @Max(1)
  @ApiProperty({
    description:
      'Vertical keystone (-1 = lean up, 0 = none, 1 = lean down). Applied as a projective transform; ' +
      'no auto-resolved component — purely user input.',
  })
  keystoneV!: number;
}

export type AssetEditParameters =
  | CropParameters
  | RotateParameters
  | MirrorParameters
  | AdjustParameters
  | LensCorrectionParameters;
export type AssetEditActionItem =
  | {
      action: AssetEditAction.Crop;
      parameters: CropParameters;
    }
  | {
      action: AssetEditAction.Rotate;
      parameters: RotateParameters;
    }
  | {
      action: AssetEditAction.Mirror;
      parameters: MirrorParameters;
    }
  | {
      action: AssetEditAction.Adjust;
      parameters: AdjustParameters;
    }
  | {
      action: AssetEditAction.LensCorrection;
      parameters: LensCorrectionParameters;
    };

@ApiExtraModels(CropParameters, RotateParameters, MirrorParameters, AdjustParameters, LensCorrectionParameters)
export class AssetEditActionItemDto {
  @ValidateEnum({ name: 'AssetEditAction', enum: AssetEditAction, description: 'Type of edit action to perform' })
  action!: AssetEditAction;

  @ApiProperty({
    description: 'List of edit actions to apply (crop, rotate, mirror, adjust, or lens correction)',
    anyOf: [CropParameters, RotateParameters, MirrorParameters, AdjustParameters, LensCorrectionParameters].map(
      (type) => ({
        $ref: getSchemaPath(type),
      }),
    ),
  })
  @ValidateNested()
  @Type((options) => actionParameterMap[options?.object.action as keyof AssetEditActionParameter])
  parameters!: AssetEditActionItem['parameters'];
}

export class AssetEditActionItemResponseDto extends AssetEditActionItemDto {
  @ValidateUUID()
  id!: string;
}

export type AssetEditActionParameter = typeof actionParameterMap;
const actionParameterMap = {
  [AssetEditAction.Crop]: CropParameters,
  [AssetEditAction.Rotate]: RotateParameters,
  [AssetEditAction.Mirror]: MirrorParameters,
  [AssetEditAction.Adjust]: AdjustParameters,
  [AssetEditAction.LensCorrection]: LensCorrectionParameters,
};

// Response for GET /assets/:id/lens-profile. Echoes back the EXIF lens info
// so the client doesn't need a second roundtrip for the caption, plus the
// resolved polynomial coefficients the client then uses both for live preview
// (shader uniforms) and for the save payload (LensCorrectionParameters).
export class AssetLensProfileResponseDto {
  @IsOptional()
  @IsString()
  @ApiProperty({ required: false, description: 'Camera make from EXIF (Sony, Canon, …).' })
  cameraMake?: string | null;

  @IsOptional()
  @IsString()
  @ApiProperty({ required: false, description: 'Camera model from EXIF.' })
  cameraModel?: string | null;

  @IsOptional()
  @IsString()
  @ApiProperty({ required: false, description: 'Lens model from EXIF.' })
  lensModel?: string | null;

  @IsOptional()
  @IsNumber()
  @ApiProperty({ required: false, description: 'Focal length in mm from EXIF.' })
  focalLength?: number | null;

  @IsOptional()
  @IsString()
  @ApiProperty({
    required: false,
    description: 'Display name of the matched lens profile. Null when no profile matched.',
  })
  displayName?: string | null;

  @IsBoolean()
  @ApiProperty({ description: 'True when a matching profile exists for this lens.' })
  hasProfile!: boolean;

  @IsNumber()
  @ApiProperty({ description: 'Radial coefficient k1 (r² term). Zero when hasProfile is false.' })
  k1!: number;

  @IsNumber()
  @ApiProperty({ description: 'Radial coefficient k2 (r⁴ term). Zero when hasProfile is false.' })
  k2!: number;

  @IsNumber()
  @ApiProperty({ description: 'Radial coefficient k3 (r⁶ term). Zero when hasProfile is false.' })
  k3!: number;
}

export class AssetEditsCreateDto {
  @ArrayMinSize(1)
  @IsUniqueEditActions()
  @ValidateNested({ each: true })
  @Type(() => AssetEditActionItemDto)
  @ApiProperty({ description: 'List of edit actions to apply (crop, rotate, or mirror)' })
  edits!: AssetEditActionItemDto[];
}

export class AssetEditsResponseDto {
  @ValidateUUID({ description: 'Asset ID these edits belong to' })
  assetId!: string;

  @ApiProperty({
    description: 'List of edit actions applied to the asset',
  })
  edits!: AssetEditActionItemResponseDto[];
}
