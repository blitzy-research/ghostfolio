import { IsOptional, IsString } from 'class-validator';

/**
 * The body of `POST /api/v1/subscription/stripe/checkout-session`.
 *
 * See `RedeemCouponDto`: the class is what lets the pipe answer a body-less request
 * with a 400 instead of the handler throwing a `TypeError` and answering 500.
 *
 * `priceId` is required because the payment provider cannot be asked for a session
 * without one; `couponId` is optional because a checkout may carry no discount.
 */
export class CreateStripeCheckoutSessionDto {
  @IsOptional()
  @IsString()
  couponId?: string;

  @IsString()
  priceId: string;
}
