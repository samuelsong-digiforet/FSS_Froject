import { IsString, IsEnum, IsOptional, IsInt, MaxLength, IsIn } from 'class-validator';
import { Type } from 'class-transformer';
import { AssetType } from '../entities/asset.entity';

export class CreateAssetDto {
  @IsString()
  @MaxLength(100)
  name: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @IsEnum(AssetType)
  type: AssetType;

  @IsString()
  sourceObject: string;

  @IsOptional()
  @IsString()
  outputProfile?: string;

  @IsOptional()
  @IsIn(['direct', 'convert'])
  uploadMode?: 'direct' | 'convert';

  @IsOptional()
  @IsInt()
  @Type(() => Number)
  categoryId?: number;
}
