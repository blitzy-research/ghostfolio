import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  ValidateIf,
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

  // Gated on ABSENCE rather than with `@IsOptional()`, and the distinction is
  // the whole point. `@IsOptional()` skips every remaining validator for `null`
  // as well as for `undefined`, so `@IsIn([1])` never saw an explicit
  // `"version": null` — it was accepted, stored verbatim, and then refused on
  // every subsequent read by the parser, which correctly treats a declared but
  // unsupported version as a document this build cannot interpret. The result was
  // a write that succeeded and a layout that could never be read again.
  //
  // `@ValidateIf` narrows the exemption to the one case it exists for: a client
  // that omits the discriminator entirely, which older clients legitimately do.
  // Anything actually present is now measured against `@IsIn([1])`, so `null`
  // joins `0`, `2` and `"1"` in being rejected with a 400 instead of persisting
  // an unreadable envelope. An empty `modules: []` remains valid — that is the
  // meaningful state of a viewer who removed their last module.
  @IsIn([1])
  @ValidateIf((o: UpdateUserDashboardLayoutDto) => o.version !== undefined)
  version?: number;
}
