import { IsString, IsOptional, IsObject, MaxLength } from 'class-validator';

export class UpdateSceneDto {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @IsOptional()
  @IsObject()
  data?: Record<string, unknown>;
}
