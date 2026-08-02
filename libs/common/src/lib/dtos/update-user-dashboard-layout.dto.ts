import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsOptional,
  ValidateNested
} from 'class-validator';

import { DashboardModuleLayoutItemDto } from './dashboard-module-layout-item.dto';

export class UpdateUserDashboardLayoutDto {
  // 300 is the canvas capacity: a 12-column by 100-row grid holds 1200 cells
  // and the smallest legal module occupies 4 of them. Without a ceiling the
  // body parser's 10 MiB allowance alone governs this array, so a single
  // request could persist hundreds of thousands of items into one JSONB
  // document. There is deliberately no lower bound — an empty array is the
  // valid, meaningful state of a user who removed their last module.
  @ArrayMaxSize(300)
  @IsArray()
  @Type(() => DashboardModuleLayoutItemDto)
  @ValidateNested({ each: true })
  modules: DashboardModuleLayoutItemDto[];

  @IsIn([1])
  @IsOptional()
  version?: number;
}
