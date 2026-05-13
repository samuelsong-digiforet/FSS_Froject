import { IsIn } from 'class-validator';

export class RegenerateAssetDto {
  @IsIn(['fast', 'normal', 'precise'])
  qualityPreset: 'fast' | 'normal' | 'precise';
}
