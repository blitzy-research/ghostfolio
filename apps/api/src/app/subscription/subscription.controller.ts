import { HasPermissionGuard } from '@ghostfolio/api/guards/has-permission.guard';
import { ConfigurationService } from '@ghostfolio/api/services/configuration/configuration.service';
import { PropertyService } from '@ghostfolio/api/services/property/property.service';
import {
  DEFAULT_LANGUAGE_CODE,
  PROPERTY_COUPONS
} from '@ghostfolio/common/config';
import {
  Coupon,
  CreateStripeCheckoutSessionResponse
} from '@ghostfolio/common/interfaces';
import type { RequestWithUser } from '@ghostfolio/common/types';

import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpException,
  Inject,
  Logger,
  Post,
  Req,
  Res,
  UseGuards
} from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';
import { Request, Response } from 'express';
import { StatusCodes, getReasonPhrase } from 'http-status-codes';

import { SubscriptionService } from './subscription.service';

@Controller('subscription')
export class SubscriptionController {
  public constructor(
    private readonly configurationService: ConfigurationService,
    private readonly propertyService: PropertyService,
    @Inject(REQUEST) private readonly request: RequestWithUser,
    private readonly subscriptionService: SubscriptionService
  ) {}

  @Post('redeem-coupon')
  @HttpCode(StatusCodes.OK)
  @UseGuards(AuthGuard('jwt'), HasPermissionGuard)
  public async redeemCoupon(@Body() { couponCode }: { couponCode: string }) {
    if (!this.request.user) {
      throw new HttpException(
        getReasonPhrase(StatusCodes.FORBIDDEN),
        StatusCodes.FORBIDDEN
      );
    }

    let coupons =
      (await this.propertyService.getByKey<Coupon[]>(PROPERTY_COUPONS)) ?? [];

    const coupon = coupons.find((currentCoupon) => {
      return currentCoupon.code === couponCode;
    });

    if (coupon === undefined) {
      throw new HttpException(
        getReasonPhrase(StatusCodes.BAD_REQUEST),
        StatusCodes.BAD_REQUEST
      );
    }

    await this.subscriptionService.createSubscription({
      duration: coupon.duration,
      price: 0,
      userId: this.request.user.id
    });

    coupons = coupons.filter((currentCoupon) => {
      return currentCoupon.code !== couponCode;
    });
    await this.propertyService.put({
      key: PROPERTY_COUPONS,
      value: JSON.stringify(coupons)
    });

    Logger.log(
      `Subscription for user '${this.request.user.id}' has been created with a coupon for ${coupon.duration}`,
      'SubscriptionController'
    );

    return {
      message: getReasonPhrase(StatusCodes.OK),
      statusCode: StatusCodes.OK
    };
  }

  @Get('stripe/callback')
  public async stripeCallback(
    @Req() request: Request,
    @Res() response: Response
  ) {
    const userId = await this.subscriptionService.createSubscriptionViaStripe(
      request.query.checkoutSessionId as string
    );

    if (userId) {
      Logger.log(
        `Subscription for user '${userId}' has been created via Stripe`,
        'SubscriptionController'
      );
    } else {
      // The service reports a checkout session it could not turn into a
      // subscription by resolving without a user. Stating the success
      // unconditionally would tell an operator reading the log that an
      // entitlement exists when none was granted - and would interpolate a
      // literal `undefined` where the account should be - which is exactly the
      // wrong conclusion to reach while investigating a billing complaint. The
      // failure is recorded instead, without the checkout session identifier:
      // the service has already logged the underlying provider error, and the
      // identifier belongs to a payment session rather than in an operations log.
      Logger.warn(
        'A Stripe checkout session could not be turned into a subscription',
        'SubscriptionController'
      );
    }

    // Redirected either way, deliberately. Whoever has just paid is returning
    // from the payment provider in a browser, so leaving them on an API response
    // because provisioning failed would strand them; the log above is what
    // distinguishes the two outcomes.
    response.redirect(
      `${this.configurationService.get('ROOT_URL')}/${DEFAULT_LANGUAGE_CODE}/`
    );
  }

  @Post('stripe/checkout-session')
  @UseGuards(AuthGuard('jwt'), HasPermissionGuard)
  public createStripeCheckoutSession(
    @Body() { couponId, priceId }: { couponId?: string; priceId: string }
  ): Promise<CreateStripeCheckoutSessionResponse> {
    try {
      return this.subscriptionService.createStripeCheckoutSession({
        couponId,
        priceId,
        user: this.request.user
      });
    } catch (error) {
      Logger.error(error, 'SubscriptionController');

      throw new HttpException(
        getReasonPhrase(StatusCodes.BAD_REQUEST),
        StatusCodes.BAD_REQUEST
      );
    }
  }
}
