import { SetMetadata } from '@nestjs/common';

export const LOG_META_KEY = 'log_meta';

export const Log = (menuName: string, action: string) =>
  SetMetadata(LOG_META_KEY, { menuName, action });
