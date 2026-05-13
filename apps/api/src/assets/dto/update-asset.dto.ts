import { IsString, IsEnum, IsOptional, IsInt, IsBoolean, ValidateIf, IsNumber } from 'class-validator';
import { Type } from 'class-transformer';
import { AssetStatus } from '../entities/asset.entity';

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
}
