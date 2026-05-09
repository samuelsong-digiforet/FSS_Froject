import { IsString, MaxLength, MinLength, IsOptional } from 'class-validator';

export class CreateAssetCategoryDto {
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;
}