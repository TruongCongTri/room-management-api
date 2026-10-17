/**
 * Khai báo metadata bypass xác thực JWT cho các route mở:   
 * 
 * */ 

import { SetMetadata, CustomDecorator } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';
export const Public = (): CustomDecorator<string> =>
  SetMetadata(IS_PUBLIC_KEY, true);