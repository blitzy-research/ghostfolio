import { IsCurrencyCode } from '@ghostfolio/common/validators/is-currency-code';

import { Transform, TransformFnParams } from 'class-transformer';
import {
  IsBoolean,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  ValidateIf
} from 'class-validator';
import { isString } from 'lodash';

// Imported from the sibling module rather than through the package barrel, which
// re-exports this very file: the barrel would close a cycle for a constant.
import { ACCOUNT_NAME_MAX_LENGTH } from './create-account.dto';

export class UpdateAccountDto {
  @IsNumber()
  balance: number;

  @IsOptional()
  @IsString()
  @Transform(({ value }: TransformFnParams) =>
    isString(value) ? value.trim() : value
  )
  comment?: string;

  @IsCurrencyCode()
  currency: string;

  @IsString()
  id: string;

  @IsBoolean()
  @IsOptional()
  isExcluded?: boolean;

  // Trimmed, required and bounded. Previously a bare `@IsString()`, which admitted
  // `""`, a string of spaces, and a name of any length at all - so the API accepted
  // accounts that render as an empty row in every table that lists them and cannot
  // be told apart, and 600-character names that break those tables' layout. The trim
  // runs before validation, so `"   "` is rejected rather than stored as whitespace.
  @IsString()
  @IsNotEmpty()
  @MaxLength(ACCOUNT_NAME_MAX_LENGTH)
  @Transform(({ value }: TransformFnParams) =>
    isString(value) ? value.trim() : value
  )
  name: string;

  @IsString()
  @ValidateIf((_object, value) => value !== null)
  platformId: string | null;
}
