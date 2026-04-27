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
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { IsAxisAlignedRotation, IsUniqueEditActions, ValidateEnum, ValidateUUID } from 'src/validation';

export enum AssetEditAction {
  Crop = 'crop',
  Rotate = 'rotate',
  Mirror = 'mirror',
  Adjust = 'adjust',
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
}

// Linear gradient mask. Point A = weight 1, Point B = weight 0; smooth falloff
// in between. Coordinates are normalized to the post-crop output: x divided by
// output width, y divided by output height (both in [0, 1]).
export class LinearMask {
  @IsEnum(LocalMaskKind)
  @ApiProperty({ enum: LocalMaskKind, enumName: 'LocalMaskKind', description: 'Mask kind discriminator' })
  kind!: LocalMaskKind.Linear;

  @IsNumber() @Min(0) @Max(1) @ApiProperty({ description: 'Normalized x of point A (weight=1)' })
  ax!: number;
  @IsNumber() @Min(0) @Max(1) @ApiProperty({ description: 'Normalized y of point A (weight=1)' })
  ay!: number;
  @IsNumber() @Min(0) @Max(1) @ApiProperty({ description: 'Normalized x of point B (weight=0)' })
  bx!: number;
  @IsNumber() @Min(0) @Max(1) @ApiProperty({ description: 'Normalized y of point B (weight=0)' })
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

  @IsNumber() @Min(0) @Max(1) @ApiProperty({ description: 'Normalized x of ellipse center' })
  cx!: number;
  @IsNumber() @Min(0) @Max(1) @ApiProperty({ description: 'Normalized y of ellipse center' })
  cy!: number;
  @IsNumber() @Min(0) @Max(2) @ApiProperty({ description: 'Normalized x-semi-axis (to min(W,H))' })
  rx!: number;
  @IsNumber() @Min(0) @Max(2) @ApiProperty({ description: 'Normalized y-semi-axis (to min(W,H))' })
  ry!: number;
  @IsNumber() @Min(-360) @Max(360) @ApiProperty({ description: 'Ellipse rotation in degrees' })
  angle!: number;
  @IsNumber() @Min(0) @Max(1) @ApiProperty({ description: 'Edge feather as fraction of semi-axis' })
  feather!: number;
  @IsBoolean()
  @ApiProperty({ description: 'False = weight 1 inside ellipse; true = weight 1 outside' })
  invert!: boolean;

  @ValidateNested()
  @Type(() => AdjustmentSliders)
  @ApiProperty({ description: 'Adjustments to apply where this mask has weight > 0' })
  params!: AdjustmentSliders;
}

export type LocalMask = LinearMask | RadialMask;

@ApiExtraModels(LinearMask, RadialMask)
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
      ],
    },
    keepDiscriminatorProperty: true,
  })
  @ApiProperty({
    description: 'Optional local-adjustment masks (up to 8). Stack in order; later masks layer on top.',
    isArray: true,
    anyOf: [LinearMask, RadialMask].map((type) => ({ $ref: getSchemaPath(type) })),
  })
  masks?: LocalMask[];
}

export type AssetEditParameters = CropParameters | RotateParameters | MirrorParameters | AdjustParameters;
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
    };

@ApiExtraModels(CropParameters, RotateParameters, MirrorParameters, AdjustParameters)
export class AssetEditActionItemDto {
  @ValidateEnum({ name: 'AssetEditAction', enum: AssetEditAction, description: 'Type of edit action to perform' })
  action!: AssetEditAction;

  @ApiProperty({
    description: 'List of edit actions to apply (crop, rotate, mirror, or adjust)',
    anyOf: [CropParameters, RotateParameters, MirrorParameters, AdjustParameters].map((type) => ({
      $ref: getSchemaPath(type),
    })),
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
};

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
