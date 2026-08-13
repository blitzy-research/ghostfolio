import { MAX_USER_DASHBOARD_LAYOUT_ITEMS } from '@ghostfolio/common/config';

import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsISO8601,
  IsObject,
  ValidateIf,
  ValidateNested
} from 'class-validator';

import { DashboardModuleLayoutItemDto } from './dashboard-module-layout-item.dto';

export class UpdateUserDashboardLayoutDto {
  // The ceiling is the canvas capacity: a 12-column by 100-row grid holds 1200
  // cells and the smallest legal module occupies 4 of them. Without a ceiling the
  // body parser's 10 MiB allowance alone governs this array, so a single
  // request could persist hundreds of thousands of items into one JSONB
  // document. There is deliberately no lower bound — an empty array is the
  // valid, meaningful state of a user who removed their last module.
  //
  // The value is shared with the read path rather than written out here, so the
  // request that may be accepted and the document that may be returned cannot
  // come to disagree about how large a layout is.
  //
  // `@IsObject` is what makes every rule below it reachable, and it is not
  // redundant with `@ValidateNested`. Nested validation treats an element as
  // "object OR array" - its own failure message says so - and for an array
  // element it descends into that array's MEMBERS rather than refusing the
  // element itself. An element that is an array therefore has no rule applied to
  // it at all beyond whatever its members happen to fail: `[[]]` has no members,
  // so every per-field bound, every declared-minimum rule and even
  // `forbidNonWhitelisted` were skipped and the element was stored as written.
  // `[[{ … a well-formed item … }]]` was admitted for the same reason - its one
  // member is valid - which is how a nested array could reach the column while
  // every declared bound still appeared to hold.
  //
  // What that cost was a document the reader then could not use: the five-field
  // projection drops an entry it cannot interpret, so the same row answered a
  // write with an array element and a read without it. Requiring each element to
  // be an object closes the write side, and the reader's projection - now applied
  // to the write response too - is what keeps the two answers identical.
  @ArrayMaxSize(MAX_USER_DASHBOARD_LAYOUT_ITEMS)
  @IsArray()
  @IsObject({ each: true })
  @Type(() => DashboardModuleLayoutItemDto)
  @ValidateNested({ each: true })
  modules: DashboardModuleLayoutItemDto[];

  // The concurrency token the client read with the layout it is editing, echoed
  // back so the server can refuse a write built on a revision the row has since
  // moved past. See `UserDashboardLayout.revision` for why the shape
  // discriminator below cannot serve this purpose.
  //
  // Gated on absence for the same reason as `version`: it is legitimately absent
  // for a first-ever save, for a client that has never read a layout, and for a
  // deliberate overwrite after a conflict - all three of which are unconditional
  // writes. Anything actually present is measured, so a malformed token is a 400
  // rather than a silently unconditional write.
  //
  // `@IsISO8601` because the token is the row's `updatedAt` serialized, and the
  // server parses it back into a date to compare. Rejecting an unparseable value
  // at the pipe keeps `new Date(...)` downstream from producing an Invalid Date,
  // which would never match any row and would surface as a spurious conflict.
  @IsISO8601()
  @ValidateIf((o: UpdateUserDashboardLayoutDto) => o.revision !== undefined)
  revision?: string;

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
