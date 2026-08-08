import { ConfigurationService } from '@ghostfolio/api/services/configuration/configuration.service';
import { PrismaService } from '@ghostfolio/api/services/prisma/prisma.service';
import { PropertyService } from '@ghostfolio/api/services/property/property.service';
import {
  DEFAULT_LANGUAGE_CODE,
  PROPERTY_STRIPE_CONFIG
} from '@ghostfolio/common/config';
import { SubscriptionType } from '@ghostfolio/common/enums';
import { parseDate } from '@ghostfolio/common/helper';
import {
  CreateStripeCheckoutSessionResponse,
  SubscriptionOffer
} from '@ghostfolio/common/interfaces';
import {
  SubscriptionOfferKey,
  UserWithSettings
} from '@ghostfolio/common/types';

import { Injectable, Logger } from '@nestjs/common';
import { Prisma, Subscription } from '@prisma/client';
import { addMilliseconds, isBefore } from 'date-fns';
import ms, { StringValue } from 'ms';
import Stripe from 'stripe';

/**
 * The stable event identifiers this service reports a refused or failed
 * provisioning under.
 *
 * Fixed strings, because a log line is read by everyone who can read the log, is
 * captured verbatim by log shipping, and outlives the payment it describes. An
 * identifier is what makes the event searchable; the reason beside it is what
 * makes it actionable. Neither names the payer or the payment session.
 */
const SUBSCRIPTION_PROVISIONING_REFUSED_EVENT =
  'GF-SUBSCRIPTION-PROVISIONING-REFUSED';

const SUBSCRIPTION_PROVISIONING_FAILED_EVENT =
  'GF-SUBSCRIPTION-PROVISIONING-FAILED';

/**
 * Why a checkout session was refused, as a closed vocabulary.
 *
 * Every one of these is a condition that must hold before an entitlement is
 * granted, and each is checked against the session as the provider reports it
 * rather than against anything the caller supplied. The callback that reaches
 * this code is a public GET whose only input is a session identifier, so a
 * session the caller merely *knows about* - including one they created and never
 * paid for - arrives here indistinguishable from a paid one until these checks
 * separate them.
 *
 * The vocabulary is closed on purpose: it carries the whole of the decision an
 * operator needs while naming neither the payer, the session, the price, nor
 * anything the provider's own error text would have volunteered about the
 * account or the request.
 */
const SUBSCRIPTION_REFUSAL_REASONS = {
  /** The session was already turned into a subscription; this is a replay. */
  alreadyProvisioned: 'ALREADY_PROVISIONED',
  /** `amount_total` was absent, so no price could be recorded. */
  amountMissing: 'AMOUNT_MISSING',
  /** The paid amount disagrees with the allowlisted offer's own price. */
  amountMismatch: 'AMOUNT_MISMATCH',
  /** The session settled in no currency, or in more than one. */
  currencyInconsistent: 'CURRENCY_INCONSISTENT',
  /** The session was not created by this application's checkout flow. */
  modeUnexpected: 'MODE_UNEXPECTED',
  /** No line item resolved to an offer this deployment actually sells. */
  offerNotAllowlisted: 'OFFER_NOT_ALLOWLISTED',
  /** The session carries no payment, or one that never completed. */
  paymentNotSettled: 'PAYMENT_NOT_SETTLED',
  /** The session names no account to grant the entitlement to. */
  referenceMissing: 'REFERENCE_MISSING',
  /** Checkout was abandoned or expired rather than completed. */
  sessionIncomplete: 'SESSION_INCOMPLETE'
} as const;

type SubscriptionRefusalReason =
  (typeof SUBSCRIPTION_REFUSAL_REASONS)[keyof typeof SUBSCRIPTION_REFUSAL_REASONS];

/**
 * The payment states that represent money actually settled.
 *
 * `no_payment_required` is included because it is the state a fully discounted
 * session settles in - this flow supports coupons, so a legitimately free
 * checkout reports no payment rather than a paid one. `unpaid` is the state an
 * unpaid session sits in and is what the refusal exists for.
 */
const SETTLED_PAYMENT_STATUSES: ReadonlySet<Stripe.Checkout.Session.PaymentStatus> =
  new Set(['no_payment_required', 'paid']);

@Injectable()
export class SubscriptionService {
  private stripe: Stripe;

  public constructor(
    private readonly configurationService: ConfigurationService,
    private readonly prismaService: PrismaService,
    private readonly propertyService: PropertyService
  ) {
    if (this.configurationService.get('ENABLE_FEATURE_SUBSCRIPTION')) {
      this.stripe = new Stripe(
        this.configurationService.get('STRIPE_SECRET_KEY'),
        {
          apiVersion: '2026-02-25.clover'
        }
      );
    }
  }

  public async createStripeCheckoutSession({
    couponId,
    priceId,
    user
  }: {
    couponId?: string;
    priceId: string;
    user: UserWithSettings;
  }): Promise<CreateStripeCheckoutSessionResponse> {
    const subscriptionOffers: {
      [offer in SubscriptionOfferKey]: SubscriptionOffer;
    } =
      (await this.propertyService.getByKey<any>(PROPERTY_STRIPE_CONFIG)) ?? {};

    const subscriptionOffer = Object.values(subscriptionOffers).find(
      (subscriptionOffer) => {
        return subscriptionOffer.priceId === priceId;
      }
    );

    const stripeCheckoutSessionCreateParams: Stripe.Checkout.SessionCreateParams =
      {
        // The locale root, because `/<language>/account` no longer resolves: the
        // membership screen is a canvas module now, not a route, and a cancelled
        // checkout would have landed on a URL that the wildcard redirects away
        // from - an avoidable extra navigation on the one path a user takes after
        // deciding not to pay.
        //
        // The viewer's own language is kept, unlike the success callback, which
        // has no authenticated request to read it from and therefore falls back to
        // the default. Here `user` is in hand, so the viewer returns to the locale
        // they left rather than to the deployment's default one.
        cancel_url: `${this.configurationService.get('ROOT_URL')}/${
          user.settings.settings.language ?? DEFAULT_LANGUAGE_CODE
        }/`,
        client_reference_id: user.id,
        line_items: [
          {
            price: priceId,
            quantity: 1
          }
        ],
        locale:
          (user.settings?.settings
            ?.language as Stripe.Checkout.SessionCreateParams.Locale) ??
          DEFAULT_LANGUAGE_CODE,
        metadata: subscriptionOffer
          ? { subscriptionOffer: JSON.stringify(subscriptionOffer) }
          : {},
        mode: 'payment',
        payment_method_types: ['card'],
        success_url: `${this.configurationService.get(
          'ROOT_URL'
        )}/api/v1/subscription/stripe/callback?checkoutSessionId={CHECKOUT_SESSION_ID}`
      };

    if (couponId) {
      stripeCheckoutSessionCreateParams.discounts = [
        {
          coupon: couponId
        }
      ];
    }

    const session = await this.stripe.checkout.sessions.create(
      stripeCheckoutSessionCreateParams
    );

    return {
      sessionUrl: session.url
    };
  }

  public async createSubscription({
    duration = '1 year',
    durationExtension,
    price,
    stripeCheckoutSessionId,
    userId
  }: {
    duration?: StringValue;
    durationExtension?: StringValue;
    price: number;
    stripeCheckoutSessionId?: string;
    userId: string;
  }) {
    let expiresAt = addMilliseconds(new Date(), ms(duration));

    if (durationExtension) {
      expiresAt = addMilliseconds(expiresAt, ms(durationExtension));
    }

    await this.prismaService.subscription.create({
      data: {
        expiresAt,
        price,
        // Written through to the unique column, so the database is what refuses a
        // second entitlement for the same payment rather than a prior read this
        // code performed. A coupon redemption passes nothing and stays null,
        // which the unique index permits any number of times.
        stripeCheckoutSessionId,
        user: {
          connect: {
            id: userId
          }
        }
      }
    });
  }

  /**
   * Turns a completed Stripe checkout session into an entitlement, or refuses it.
   *
   * The endpoint that reaches this method is a **public** `GET` carrying nothing
   * but a session identifier, because that is where the payment provider returns
   * the payer's browser. Two consequences follow, and they are what the whole of
   * the validation below exists for:
   *
   * - Retrieving a session proves only that the session exists. It does not prove
   *   that it was paid, that it completed, that it belongs to this application's
   *   checkout flow, or that the offer it names is one this deployment sells. A
   *   caller who creates a checkout session through the authenticated endpoint and
   *   then simply abandons it can present its identifier here; nothing but
   *   `payment_status` and `status` distinguishes that from a paid session.
   * - A session identifier stays retrievable indefinitely, so the same paid
   *   session can be presented again and again. Without an idempotency record one
   *   payment yields unlimited entitlement extensions.
   *
   * The offer is re-derived from the deployment's own allowlist by the session's
   * line-item price, and deliberately NOT read from `session.metadata`. Metadata
   * is written when the session is created and is therefore only as trustworthy
   * as whoever created it; the allowlist is server state. This is what stops
   * `durationExtension` - which directly lengthens the entitlement - from being
   * chosen by the caller.
   *
   * Provisioning is idempotent through the unique `stripeCheckoutSessionId`
   * column: the check and the create are one statement, so two concurrent
   * callbacks for the same session cannot both pass a check and both insert.
   *
   * @param aCheckoutSessionId the session identifier the provider put in the
   * return URL. Untrusted.
   * @returns the account the entitlement was granted to, or `undefined` when the
   * session was refused - which is what the caller reports as a failure.
   */
  public async createSubscriptionViaStripe(
    aCheckoutSessionId: string
  ): Promise<string> {
    try {
      // Expanded on retrieval, because the price the payer was actually charged
      // for lives on the line items and is the only thing that can be matched
      // against the allowlist. Without the expansion `line_items` is absent and
      // there would be nothing to match but caller-written metadata.
      const session = await this.stripe.checkout.sessions.retrieve(
        aCheckoutSessionId,
        { expand: ['line_items'] }
      );

      if (session.status !== 'complete') {
        this.refuseCheckoutSession(
          SUBSCRIPTION_REFUSAL_REASONS.sessionIncomplete
        );

        return;
      }

      if (!SETTLED_PAYMENT_STATUSES.has(session.payment_status)) {
        this.refuseCheckoutSession(
          SUBSCRIPTION_REFUSAL_REASONS.paymentNotSettled
        );

        return;
      }

      // The only mode this application creates. A session in any other mode was
      // not produced by its checkout flow, so its amount and its line items carry
      // no meaning that can be checked here.
      if (session.mode !== 'payment') {
        this.refuseCheckoutSession(SUBSCRIPTION_REFUSAL_REASONS.modeUnexpected);

        return;
      }

      const userId = session.client_reference_id;

      if (!userId) {
        this.refuseCheckoutSession(
          SUBSCRIPTION_REFUSAL_REASONS.referenceMissing
        );

        return;
      }

      const subscriptionOffer =
        await this.getAllowlistedSubscriptionOffer(session);

      if (!subscriptionOffer) {
        this.refuseCheckoutSession(
          SUBSCRIPTION_REFUSAL_REASONS.offerNotAllowlisted
        );

        return;
      }

      // An amount only means something alongside the currency it was settled in,
      // so a session that names none - or that mixes currencies across its line
      // items - carries no total the comparison below could be made against.
      if (!this.hasConsistentCurrency(session)) {
        this.refuseCheckoutSession(
          SUBSCRIPTION_REFUSAL_REASONS.currencyInconsistent
        );

        return;
      }

      if (!Number.isFinite(session.amount_total)) {
        this.refuseCheckoutSession(SUBSCRIPTION_REFUSAL_REASONS.amountMissing);

        return;
      }

      const price = session.amount_total / 100;

      // The allowlisted offer states what this deployment charges, so a settled
      // amount that disagrees with it did not come from that offer however the
      // price identifier matched. Compared against the discounted total when a
      // coupon applies, because that is what the offer itself advertises.
      if (!this.isExpectedAmount({ price, subscriptionOffer })) {
        this.refuseCheckoutSession(SUBSCRIPTION_REFUSAL_REASONS.amountMismatch);

        return;
      }

      await this.createSubscription({
        price,
        durationExtension: subscriptionOffer.durationExtension,
        stripeCheckoutSessionId: session.id,
        userId
      });

      return userId;
    } catch (error) {
      // A unique-constraint violation is not a fault: it is the database
      // reporting that this exact payment has already been turned into an
      // entitlement. Reported as a refusal so a replay is visible in the log,
      // and resolved without a user so the caller does not announce a second
      // entitlement that was never granted.
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        this.refuseCheckoutSession(
          SUBSCRIPTION_REFUSAL_REASONS.alreadyProvisioned
        );

        return;
      }

      // The event and nothing else. The provider's own error object names the
      // request it was raised for, carries request and account identifiers, and
      // maps out this application through its stack - none of which helps an
      // operator decide what to do, and all of which is disclosure in a log that
      // outlives the payment.
      Logger.error(
        SUBSCRIPTION_PROVISIONING_FAILED_EVENT,
        'SubscriptionService'
      );
    }
  }

  public async getSubscription({
    createdAt,
    subscriptions
  }: {
    createdAt: UserWithSettings['createdAt'];
    subscriptions: Subscription[];
  }): Promise<UserWithSettings['subscription']> {
    if (subscriptions.length > 0) {
      const { expiresAt, price } = subscriptions.reduce((a, b) => {
        return new Date(a.expiresAt) > new Date(b.expiresAt) ? a : b;
      });

      let offerKey: SubscriptionOfferKey = price ? 'renewal' : 'default';

      if (isBefore(createdAt, parseDate('2023-01-01'))) {
        offerKey = 'renewal-early-bird-2023';
      } else if (isBefore(createdAt, parseDate('2024-01-01'))) {
        offerKey = 'renewal-early-bird-2024';
      } else if (isBefore(createdAt, parseDate('2025-12-01'))) {
        offerKey = 'renewal-early-bird-2025';
      }

      const offer = await this.getSubscriptionOffer({
        key: offerKey
      });

      return {
        offer,
        expiresAt: isBefore(new Date(), expiresAt) ? expiresAt : undefined,
        type: isBefore(new Date(), expiresAt)
          ? SubscriptionType.Premium
          : SubscriptionType.Basic
      };
    } else {
      const offer = await this.getSubscriptionOffer({
        key: 'default'
      });

      return {
        offer,
        type: SubscriptionType.Basic
      };
    }
  }

  public async getSubscriptionOffer({
    key
  }: {
    key: SubscriptionOfferKey;
  }): Promise<SubscriptionOffer> {
    if (!this.configurationService.get('ENABLE_FEATURE_SUBSCRIPTION')) {
      return undefined;
    }

    const offers: {
      [offer in SubscriptionOfferKey]: SubscriptionOffer;
    } =
      (await this.propertyService.getByKey<any>(PROPERTY_STRIPE_CONFIG)) ?? {};

    return {
      ...offers[key],
      isRenewal: key.startsWith('renewal')
    };
  }

  /**
   * Resolves the session's line item to an offer this deployment actually sells.
   *
   * The allowlist is `PROPERTY_STRIPE_CONFIG`, the same server-side property the
   * checkout flow reads when it creates a session. Matching against it is what
   * makes the entitlement a function of deployment configuration rather than of
   * the session presented, and it is the reason `session.metadata` is not
   * consulted: metadata is written at session-creation time and would let whoever
   * created the session choose its own `durationExtension`.
   *
   * @param aSession a completed session retrieved with `line_items` expanded.
   * @returns the matching offer, or `undefined` when no line item names a price
   * this deployment offers.
   */
  private async getAllowlistedSubscriptionOffer(
    aSession: Stripe.Checkout.Session
  ): Promise<SubscriptionOffer> {
    // Typed against the offer shape rather than through `any`, because everything
    // downstream - the price comparison and the duration extension - is decided
    // from these values, and an untyped read would let a renamed member reach the
    // entitlement silently.
    const subscriptionOffers =
      (await this.propertyService.getByKey<
        Partial<Record<SubscriptionOfferKey, SubscriptionOffer>>
      >(PROPERTY_STRIPE_CONFIG)) ?? {};

    const allowlistedPriceIds = new Set(
      Object.values(subscriptionOffers)
        .map((subscriptionOffer) => {
          return subscriptionOffer?.priceId;
        })
        .filter((priceId): priceId is string => {
          return !!priceId;
        })
    );

    const priceIds = (aSession.line_items?.data ?? [])
      .map((lineItem) => {
        return lineItem.price?.id;
      })
      .filter((priceId): priceId is string => {
        return !!priceId;
      });

    const matchedPriceId = priceIds.find((priceId) => {
      return allowlistedPriceIds.has(priceId);
    });

    if (!matchedPriceId) {
      return undefined;
    }

    // Every line item must be allowlisted, not merely one of them. A session
    // combining an offered price with an arbitrary second one would otherwise
    // match on the first and be provisioned as though it were that offer alone.
    const hasOnlyAllowlistedPriceIds =
      priceIds.length > 0 &&
      priceIds.every((priceId) => {
        return allowlistedPriceIds.has(priceId);
      });

    if (!hasOnlyAllowlistedPriceIds) {
      return undefined;
    }

    return Object.values(subscriptionOffers).find((subscriptionOffer) => {
      return subscriptionOffer?.priceId === matchedPriceId;
    });
  }

  /**
   * Whether the session settled in exactly one, named currency.
   *
   * The amount check below compares a number against a configured price, and that
   * comparison is only sound if both sides are in the same currency. This
   * application's own checkout flow never mixes currencies - the currency follows
   * from the price object - so a session that does was not produced by it, and one
   * that names no currency at all offers nothing to compare against.
   */
  private hasConsistentCurrency(aSession: Stripe.Checkout.Session) {
    if (!aSession.currency) {
      return false;
    }

    return (aSession.line_items?.data ?? []).every((lineItem) => {
      return (
        !lineItem.price?.currency ||
        lineItem.price.currency === aSession.currency
      );
    });
  }

  /**
   * Whether the settled amount is one the matched offer can legitimately produce.
   *
   * An offer advertises `price`, and where a coupon applies the application itself
   * presents `price - coupon` as what is charged. Both are therefore legitimate
   * settled totals and nothing else is, which is what keeps out a session that
   * matched an allowlisted price identifier but settled for some other amount -
   * the case a caller-supplied discount would produce.
   *
   * An offer whose `price` this deployment has not configured is treated as
   * unverifiable rather than as agreeing with anything: there is no reference
   * amount to compare against, so no amount can be shown to be the expected one.
   *
   * Compared with a half-minor-unit tolerance because both sides are currency
   * amounts reconstructed from integer minor units, and an offer configured as
   * `19.99` cannot be expected to equal `1999 / 100` exactly in binary floating
   * point.
   */
  private isExpectedAmount({
    price,
    subscriptionOffer
  }: {
    price: number;
    subscriptionOffer: SubscriptionOffer;
  }) {
    if (!Number.isFinite(subscriptionOffer.price)) {
      return false;
    }

    const expectedPrices = [subscriptionOffer.price];

    if (Number.isFinite(subscriptionOffer.coupon)) {
      expectedPrices.push(subscriptionOffer.price - subscriptionOffer.coupon);
    }

    return expectedPrices.some((expectedPrice) => {
      return Math.abs(expectedPrice - price) < 0.005;
    });
  }

  /**
   * Records a refused checkout session and resolves without an account.
   *
   * The reason is reported; the session identifier and the payer are not. The
   * caller reads the absent account as "not provisioned" and reports that, which
   * is what keeps a refusal from being logged as a granted entitlement.
   *
   * @param aReason one member of the closed refusal vocabulary.
   */
  private refuseCheckoutSession(aReason: SubscriptionRefusalReason): void {
    Logger.warn(
      `${SUBSCRIPTION_PROVISIONING_REFUSED_EVENT} (reason ${aReason})`,
      'SubscriptionService'
    );
  }
}
