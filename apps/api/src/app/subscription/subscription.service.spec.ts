import { ConfigurationService } from '@ghostfolio/api/services/configuration/configuration.service';
import { PrismaService } from '@ghostfolio/api/services/prisma/prisma.service';
import { PropertyService } from '@ghostfolio/api/services/property/property.service';
import { PROPERTY_STRIPE_CONFIG } from '@ghostfolio/common/config';

import { Logger } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import { inspect } from 'node:util';
import Stripe from 'stripe';

import { SubscriptionService } from './subscription.service';

/**
 * What has to be true of a Stripe checkout session before it becomes an
 * entitlement.
 *
 * The handler that reaches this service is a **public** `GET` whose only input is
 * a session identifier, because that is where the payment provider returns the
 * payer's browser. Retrieving a session therefore proves only that the session
 * exists - not that it was paid, not that it completed, not that it came from this
 * application's own checkout flow, and not that the offer it names is one this
 * deployment sells. Every assertion below is one of those gaps closed, and each is
 * written from the attacker's side rather than the payer's: the interesting input
 * is a session the caller created and never paid for, or a paid session presented
 * a second time.
 *
 * Stripe is stubbed at the client boundary rather than mocked through a helper,
 * so each test states the exact session shape it is about and nothing else is
 * implied. The stub is installed onto the private client the constructor built,
 * which is the same seam the real code calls through.
 */
describe('SubscriptionService', () => {
  const checkoutSessionId = 'cs_test_a1b2c3';
  const userId = 'c0a8012e-4f7b-4d1a-9f3e-2b6d8c5a1e44';

  /** The price this deployment sells, as configured server-side. */
  const allowlistedPriceId = 'price_allowlisted';

  let create: jest.Mock;
  let loggerError: jest.SpyInstance;
  let loggerWarn: jest.SpyInstance;
  let retrieve: jest.Mock;
  let subscriptionService: SubscriptionService;

  /**
   * The budget the constructed client will actually enforce, captured before the
   * stub replaces the client.
   *
   * Read after construction rather than asserted against the options object,
   * because the library validates each option and quietly substitutes its own
   * default for anything that is not an integer. Asserting what was passed would
   * therefore pass while an 80-second default was in force; this reads what will
   * be enforced.
   */
  let stripeApiBounds: { maxNetworkRetries: number; timeout: number };

  /**
   * A one-field view of the private client, rather than a cast to `any`: it names
   * exactly what is read, so renaming the field breaks this file instead of
   * silently reading `undefined`.
   */
  const readStripeApiBounds = (service: SubscriptionService) => {
    return (
      service as unknown as {
        stripe: { _api: { maxNetworkRetries: number; timeout: number } };
      }
    ).stripe._api;
  };

  /**
   * A settled session for the allowlisted offer: what the legitimate return leg
   * looks like. Every refusal test below is this object with one property changed,
   * so what each test is about is exactly the difference.
   */
  const createSession = (
    overrides: Partial<Stripe.Checkout.Session> = {}
  ): Stripe.Checkout.Session => {
    return {
      amount_total: 1999,
      client_reference_id: userId,
      currency: 'usd',
      id: checkoutSessionId,
      line_items: {
        data: [{ price: { id: allowlistedPriceId } }]
      },
      metadata: {},
      mode: 'payment',
      payment_status: 'paid',
      status: 'complete',
      ...overrides
    } as unknown as Stripe.Checkout.Session;
  };

  const configure = async ({
    subscriptionOffers = {
      default: {
        durationExtension: '3 days',
        label: 'Premium',
        price: 19.99,
        priceId: allowlistedPriceId
      }
    }
  }: { subscriptionOffers?: Record<string, unknown> } = {}) => {
    create = jest.fn().mockResolvedValue({ id: 'subscription-1' });
    retrieve = jest.fn().mockResolvedValue(createSession());

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SubscriptionService,
        {
          provide: ConfigurationService,
          useValue: {
            // Switched on, so the constructor builds a Stripe client for the stub
            // below to replace. With the feature off there is no client at all and
            // none of this code path exists.
            //
            // `REQUEST_TIMEOUT` answers with a real number because the constructor
            // now passes it to the client as its per-attempt budget. A string here
            // would not fail: the library validates the option and silently falls
            // back to its own 80-second default, which is the very wait the bound
            // exists to prevent - so the suite would go green over an unbounded
            // client. The bound itself is asserted below.
            get: (key: string) => {
              if (key === 'ENABLE_FEATURE_SUBSCRIPTION') {
                return true;
              }

              return key === 'REQUEST_TIMEOUT' ? 3000 : 'unused';
            }
          }
        },
        { provide: PrismaService, useValue: { subscription: { create } } },
        {
          provide: PropertyService,
          useValue: {
            getByKey: jest.fn((key: string) =>
              key === PROPERTY_STRIPE_CONFIG
                ? Promise.resolve(subscriptionOffers)
                : Promise.resolve(undefined)
            )
          }
        }
      ]
    }).compile();

    subscriptionService = module.get(SubscriptionService);

    stripeApiBounds = readStripeApiBounds(subscriptionService);

    // Installed over the client the constructor created, so the code under test
    // reaches the stub through exactly the call it makes in production. Written
    // with `Object.assign` rather than a cast, because the field is private and a
    // cast wide enough to reach it would also be wide enough to hide a renamed
    // method behind `any`.
    Object.assign(subscriptionService, {
      stripe: { checkout: { sessions: { retrieve } } }
    });
  };

  beforeEach(async () => {
    loggerError = jest
      .spyOn(Logger, 'error')
      .mockImplementation(() => undefined);
    loggerWarn = jest.spyOn(Logger, 'warn').mockImplementation(() => undefined);

    await configure();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  /**
   * How long somebody can be made to wait on the payment provider.
   *
   * Both calls this client makes happen while a person waits: one behind a button,
   * and one - the checkout callback - while the payer's browser sits on a blank
   * redirect returning from payment. The library's defaults are 80 seconds per
   * attempt with two retries, so an unresponsive provider held that browser for
   * over a minute. Neither number is visible in any signature, and a regression
   * here reappears only as a slow page nobody can attribute, which is why they are
   * pinned.
   */
  describe('the budget the payment provider is given', () => {
    it('bounds each attempt by the deployment request timeout', () => {
      expect(stripeApiBounds.timeout).toBe(3000);
    });

    it('retries once, so a dropped connection does not cost a paid entitlement', () => {
      // One rather than the library's two: the answer decides whether an
      // entitlement somebody paid for is granted, so a single retry is worth the
      // wait it adds - a second is not.
      expect(stripeApiBounds.maxNetworkRetries).toBe(1);
    });

    it('is far below the library default the wait used to come from', () => {
      // Stated as a relation rather than a second literal: what matters is that
      // this deployment no longer inherits the 80-second default, whatever the
      // configured timeout happens to be.
      expect(stripeApiBounds.timeout).toBeLessThan(80000);
    });
  });

  describe('createSubscriptionViaStripe', () => {
    it('provisions the entitlement for a settled session', async () => {
      const result =
        await subscriptionService.createSubscriptionViaStripe(
          checkoutSessionId
        );

      expect(result).toBe(userId);
      expect(create).toHaveBeenCalledTimes(1);

      const [{ data }] = create.mock.calls[0] as [
        { data: Record<string, unknown> }
      ];

      expect(data.price).toBeCloseTo(19.99, 5);
      expect(data.user).toEqual({ connect: { id: userId } });
    });

    it('reads the line items, because the price is what the allowlist is matched against', async () => {
      await subscriptionService.createSubscriptionViaStripe(checkoutSessionId);

      // Without the expansion `line_items` is absent from the retrieved session
      // and the only thing left to derive the offer from would be metadata the
      // session's creator wrote.
      expect(retrieve).toHaveBeenCalledWith(checkoutSessionId, {
        expand: ['line_items']
      });
    });

    it('records the session it provisioned from, so the same payment cannot be redeemed twice', async () => {
      await subscriptionService.createSubscriptionViaStripe(checkoutSessionId);

      const [{ data }] = create.mock.calls[0] as [
        { data: Record<string, unknown> }
      ];

      // The unique column is the whole of the idempotency guarantee: the check and
      // the insert are one statement, so two concurrent callbacks for one session
      // cannot both pass a check and both write.
      expect(data.stripeCheckoutSessionId).toBe(checkoutSessionId);
    });

    it('takes the duration extension from the allowlisted offer rather than from session metadata', async () => {
      retrieve.mockResolvedValue(
        createSession({
          metadata: {
            subscriptionOffer: JSON.stringify({
              durationExtension: '10 years',
              price: 19.99,
              priceId: allowlistedPriceId
            })
          }
        })
      );

      await subscriptionService.createSubscriptionViaStripe(checkoutSessionId);

      const [{ data }] = create.mock.calls[0] as [
        { data: { expiresAt: Date } }
      ];

      // Metadata is written when the session is created, so trusting it would let
      // whoever created the session choose how long their own entitlement lasts.
      // A ten-year extension would put the expiry far beyond one year plus the
      // three days the configured offer grants.
      const oneYearAndAMonth = new Date();

      oneYearAndAMonth.setFullYear(oneYearAndAMonth.getFullYear() + 1);
      oneYearAndAMonth.setMonth(oneYearAndAMonth.getMonth() + 1);

      expect(data.expiresAt.getTime()).toBeLessThan(oneYearAndAMonth.getTime());
    });

    describe('sessions that must be refused', () => {
      it.each([
        {
          description: 'checkout was never completed',
          overrides: { status: 'open' as const }
        },
        {
          description: 'checkout expired',
          overrides: { status: 'expired' as const }
        },
        {
          description: 'the session was never paid',
          overrides: { payment_status: 'unpaid' as const }
        },
        {
          description:
            'the session is not in the mode this application creates',
          overrides: { mode: 'setup' as const }
        },
        {
          description: 'the session names no account',
          overrides: { client_reference_id: null }
        },
        {
          description: 'no amount settled',
          overrides: { amount_total: null }
        },
        {
          description: 'the amount disagrees with the allowlisted offer',
          overrides: { amount_total: 100 }
        },
        {
          description: 'the price is not one this deployment sells',
          overrides: {
            line_items: { data: [{ price: { id: 'price_elsewhere' } }] }
          }
        },
        {
          description: 'an allowlisted price is bundled with an arbitrary one',
          overrides: {
            line_items: {
              data: [
                { price: { id: allowlistedPriceId } },
                { price: { id: 'price_elsewhere' } }
              ]
            }
          }
        },
        {
          description: 'the session carries no line items at all',
          overrides: { line_items: { data: [] } }
        },
        {
          description: 'the session names no currency',
          overrides: { currency: null }
        },
        {
          description: 'the line item settled in a different currency',
          overrides: {
            line_items: {
              data: [{ price: { currency: 'jpy', id: allowlistedPriceId } }]
            }
          }
        }
      ])('grants nothing when $description', async ({ overrides }) => {
        retrieve.mockResolvedValue(
          createSession(overrides as Partial<Stripe.Checkout.Session>)
        );

        const result =
          await subscriptionService.createSubscriptionViaStripe(
            checkoutSessionId
          );

        // Both halves matter. Resolving without an account is what makes the
        // caller report a failure rather than announce an entitlement, and the
        // absent write is the entitlement itself not existing.
        expect(result).toBeUndefined();
        expect(create).not.toHaveBeenCalled();
      });

      it('accepts a fully discounted session, which settles as requiring no payment', async () => {
        await configure({
          subscriptionOffers: {
            default: {
              coupon: 19.99,
              price: 19.99,
              priceId: allowlistedPriceId
            }
          }
        });

        retrieve.mockResolvedValue(
          createSession({
            amount_total: 0,
            payment_status: 'no_payment_required'
          })
        );

        // The one settled state that is not `paid`. Refusing it would break the
        // coupon path this application supports, so it is admitted deliberately
        // rather than by omission.
        expect(
          await subscriptionService.createSubscriptionViaStripe(
            checkoutSessionId
          )
        ).toBe(userId);
      });

      it('accepts the discounted price of an offer that carries a coupon', async () => {
        await configure({
          subscriptionOffers: {
            default: { coupon: 5, price: 19.99, priceId: allowlistedPriceId }
          }
        });

        retrieve.mockResolvedValue(createSession({ amount_total: 1499 }));

        expect(
          await subscriptionService.createSubscriptionViaStripe(
            checkoutSessionId
          )
        ).toBe(userId);
      });

      it('grants nothing when the deployment sells no offers at all', async () => {
        await configure({ subscriptionOffers: {} });

        expect(
          await subscriptionService.createSubscriptionViaStripe(
            checkoutSessionId
          )
        ).toBeUndefined();
        expect(create).not.toHaveBeenCalled();
      });
    });

    describe('a session presented a second time', () => {
      beforeEach(() => {
        // Exactly what the database raises when the unique column already holds
        // this session: the replay is refused by the constraint rather than by a
        // read this code performed and could have raced.
        create.mockRejectedValue(
          new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
            clientVersion: '7.7.0',
            code: 'P2002'
          })
        );
      });

      it('grants no second entitlement', async () => {
        expect(
          await subscriptionService.createSubscriptionViaStripe(
            checkoutSessionId
          )
        ).toBeUndefined();
      });

      it('reports the replay as a refusal rather than as a fault', async () => {
        await subscriptionService.createSubscriptionViaStripe(
          checkoutSessionId
        );

        expect(loggerWarn).toHaveBeenCalledWith(
          'GF-SUBSCRIPTION-PROVISIONING-REFUSED (reason ALREADY_PROVISIONED)',
          'SubscriptionService'
        );
        expect(loggerError).not.toHaveBeenCalled();
      });
    });

    describe('what reaches the log', () => {
      it('reports a provider failure as an event without repeating what the provider said', async () => {
        // A provider error object names the request it was raised for, carries
        // request and account identifiers, and maps out the application through
        // its stack.
        retrieve.mockRejectedValue(
          Object.assign(
            new Error(
              `No such checkout.session: '${checkoutSessionId}' for account 'acct_secret'`
            ),
            { requestId: 'req_secret' }
          )
        );

        await subscriptionService.createSubscriptionViaStripe(
          checkoutSessionId
        );

        expect(loggerError).toHaveBeenCalledWith(
          'GF-SUBSCRIPTION-PROVISIONING-FAILED',
          'SubscriptionService'
        );
      });

      it.each([
        {
          description: 'a refused session',
          arrange: () => {
            retrieve.mockResolvedValue(createSession({ status: 'open' }));
          }
        },
        {
          description: 'a provider failure',
          arrange: () => {
            retrieve.mockRejectedValue(
              new Error(`session ${checkoutSessionId} of user ${userId}`)
            );
          }
        }
      ])(
        'names neither the payer nor the payment session for $description',
        async ({ arrange }) => {
          arrange();

          await subscriptionService.createSubscriptionViaStripe(
            checkoutSessionId
          );

          // Asserted across every channel rather than only the one expected to
          // fire, so the identifier cannot reappear by being moved.
          const emitted = [loggerError, loggerWarn]
            .flatMap((logger) => logger.mock.calls as unknown[][])
            .map((call) =>
              call
                .map((argument) =>
                  typeof argument === 'string' ? argument : inspect(argument)
                )
                .join(' ')
            )
            .join('\n');

          expect(emitted).not.toContain(checkoutSessionId);
          expect(emitted).not.toContain(userId);
        }
      );
    });
  });

  describe('createSubscription', () => {
    it('records no payment session for a coupon redemption', async () => {
      await subscriptionService.createSubscription({ price: 0, userId });

      const [{ data }] = create.mock.calls[0] as [
        { data: Record<string, unknown> }
      ];

      // Null rather than a placeholder, because the unique index permits any
      // number of nulls and a coupon redemption has no payment to be idempotent
      // against.
      expect(data.stripeCheckoutSessionId).toBeUndefined();
    });
  });
});
