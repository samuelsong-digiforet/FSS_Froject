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
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { AssetStatus } from '../entities/asset.entity';

class GdtAnnotationDto {
  @IsString()
  id: string;

  @IsArray()
  @ArrayMinSize(3)
  @ArrayMaxSize(3)
  @IsNumber({}, { each: true })
  @Type(() => Number)
  position: [number, number, number];

  @IsString()
  type: string;

  @IsString()
  tolerance: string;
}

class VraPointDto {
  @IsNumber()
  @Type(() => Number)
  measured: number;

  @IsString()
  actual: string;

  @IsOptional()
  @IsArray()
  p1?: [number, number, number];

  @IsOptional()
  @IsArray()
  p2?: [number, number, number];
}

export class UpdateAssetDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsEnum(AssetStatus)
  status?: AssetStatus;

  @IsOptional()
  @IsString()
  previewObject?: string;

  @IsOptional()
  @IsString()
  outputObject?: string;

  @IsOptional()
  @IsString()
  errorMessage?: string;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsInt()
  @Type(() => Number)
  categoryId?: number | null;

  @IsOptional()
  @IsBoolean()
  approved?: boolean;

  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  calibrationScale?: number;

  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  calibrationReferenceLength?: number;

  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  calibrationMeasuredLength?: number;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  representativeSceneObject?: string | null;

  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  volumeRenderingAccuracy?: number;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => GdtAnnotationDto)
  gdtAnnotations?: GdtAnnotationDto[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => VraPointDto)
  vraPoints?: VraPointDto[];
}
