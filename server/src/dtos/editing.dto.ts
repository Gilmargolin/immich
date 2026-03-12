import { ApiExtraModels, ApiProperty, getSchemaPath } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMinSize, IsEnum, IsInt, IsNumber, Min, Max, ValidateNested } from 'class-validator';
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

export class AdjustParameters {
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
