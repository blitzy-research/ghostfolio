import { Type } from 'class-transformer';
import { IsArray, IsIn, IsOptional, ValidateNested } from 'class-validator';

import { DashboardModuleLayoutItemDto } from './dashboard-module-layout-item.dto';

export class UpdateUserDashboardLayoutDto {
  @IsArray()
  @Type(() => DashboardModuleLayoutItemDto)
  @ValidateNested({ each: true })
  modules: DashboardModuleLayoutItemDto[];

  @IsIn([1])
  @IsOptional()
  version?: number;
}
