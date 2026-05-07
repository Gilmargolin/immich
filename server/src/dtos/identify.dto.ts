import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class IdentifyResultDto {
  @ApiProperty()
  scientificName!: string;

  @ApiPropertyOptional({ nullable: true, type: 'string' })
  commonName!: string | null;

  @ApiProperty()
  iconicTaxon!: string;

  @ApiPropertyOptional({ nullable: true, type: 'string' })
  wikiUrl!: string | null;

  @ApiProperty()
  score!: number;

  @ApiPropertyOptional({ nullable: true, type: 'string' })
  photoUrl!: string | null;
}

export class IdentifyResponseDto {
  @ApiProperty({ type: [IdentifyResultDto] })
  results!: IdentifyResultDto[];
}
