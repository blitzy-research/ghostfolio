import { Transform, TransformFnParams } from 'class-transformer';
import { IsNotEmpty, IsString } from 'class-validator';
import { isString } from 'lodash';

/**
 * The body of `POST /api/v1/subscription/redeem-coupon`.
 *
 * Declared as a class rather than destructured inline, and that is what makes a
 * body-less request answerable. The global `ValidationPipe` substitutes an empty
 * object for a missing body before validating, so an absent `couponCode` is
 * reported as a 400 with the field named; destructuring an undefined body instead
 * threw a `TypeError` inside the handler and the caller received a 500 for what is
 * plainly a malformed request.
 */
export class RedeemCouponDto {
  // Trimmed before validation, so a code pasted with surrounding whitespace is
  // compared as the operator entered it, and a value consisting only of whitespace
  // is rejected rather than looked up and reported as unknown.
  @IsString()
  @IsNotEmpty()
  @Transform(({ value }: TransformFnParams) =>
    isString(value) ? value.trim() : value
  )
  couponCode: string;
}
