import { IsString, IsBoolean, IsOptional, IsArray, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

export class UpdatePermissionDto {
  @IsString()
  menuKey: string;

  @IsOptional()
  @IsBoolean()
  use?: boolean;

  @IsOptional()
  @IsBoolean()
  view?: boolean;

  @IsOptional()
  @IsBoolean()
  detail?: boolean;

  @IsOptional()
  @IsBoolean()
  create?: boolean;

  @IsOptional()
  @IsBoolean()
  update?: boolean;

  @IsOptional()
  @IsBoolean()
  delete?: boolean;

  @IsOptional()
  @IsBoolean()
  approve?: boolean;

  @IsOptional()
  @IsBoolean()
  editor?: boolean;

  @IsOptional()
  @IsBoolean()
  excel?: boolean;
}

export class SavePermissionsDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => UpdatePermissionDto)
  permissions: UpdatePermissionDto[];
}