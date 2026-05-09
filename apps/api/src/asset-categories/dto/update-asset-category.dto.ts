import { IsString, MaxLength, IsOptional } from 'class-validator';

export class UpdateAssetCategoryDto {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;
}