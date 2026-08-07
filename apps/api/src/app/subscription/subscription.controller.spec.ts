import { ConfigurationService } from '@ghostfolio/api/services/configuration/configuration.service';
import { PropertyService } from '@ghostfolio/api/services/property/property.service';
import { DEFAULT_LANGUAGE_CODE } from '@ghostfolio/common/config';

import { Logger } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
import { Test, TestingModule } from '@nestjs/testing';
import { Request, Response } from 'express';
import { inspect } from 'node:util';

import { SubscriptionController } from './subscription.controller';
import { SubscriptionService } from './subscription.service';

/**
 * The Stripe return leg, and specifically where it sends the browser afterwards.
 *
 * It used to land on the membership screen, which no longer owns a URL: account
 * membership became a module on the single canvas. The redirect therefore targets
 * the locale root, and that target is a template string a compiler cannot check -
 * a drift back to the retired path would still build, still pass every layout
 * test, and only surface as a dead page for whoever had just paid.
 *
 * The handler is exercised directly rather than over HTTP, because nothing here
 * concerns the request pipeline: the guard stack on this route is untouched by the
 * refactor, and the layout controller's own suite already covers guard behaviour
 * end to end.
 */
describe('SubscriptionController', () => {
  const checkoutSessionId = 'cs_test_a1b2c3';
  const rootUrl = 'https://ghostfolio.example';
  const userId = 'c0a8012e-4f7b-4d1a-9f3e-2b6d8c5a1e44';

  let createSubscriptionViaStripe: jest.Mock;
  let loggerLog: jest.SpyInstance;
  let loggerWarn: jest.SpyInstance;
  let redirect: jest.Mock;
  let subscriptionController: SubscriptionController;

  beforeEach(async () => {
    createSubscriptionViaStripe = jest.fn().mockResolvedValue(userId);
    redirect = jest.fn();

    // The handler reports the created subscription through Nest's logger. Silenced
    // so the suite output stays readable, and asserted below rather than merely
    // suppressed, because that line is the operator's only record of the event.
    loggerLog = jest.spyOn(Logger, 'log').mockImplementation(() => undefined);
    loggerWarn = jest.spyOn(Logger, 'warn').mockImplementation(() => undefined);

    const module: TestingModule = await Test.createTestingModule({
      controllers: [SubscriptionController],
      providers: [
        {
          provide: ConfigurationService,
          useValue: {
            get: (key: string) => (key === 'ROOT_URL' ? rootUrl : undefined)
          }
        },
        { provide: PropertyService, useValue: {} },
        { provide: REQUEST, useValue: { user: { id: userId } } },
        {
          provide: SubscriptionService,
          useValue: { createSubscriptionViaStripe }
        }
      ]
    }).compile();

    subscriptionController = await module.resolve(SubscriptionController);
  });

  afterEach(() => {
    loggerLog.mockRestore();
    loggerWarn.mockRestore();
  });

  describe('stripeCallback', () => {
    /** The request as Express leaves it, carrying only the query this handler reads. */
    const createRequest = () => {
      return { query: { checkoutSessionId } } as unknown as Request;
    };

    const createResponse = () => {
      return { redirect } as unknown as Response;
    };

    it('returns the payer to the locale root', async () => {
      await subscriptionController.stripeCallback(
        createRequest(),
        createResponse()
      );

      // The trailing slash is load-bearing: the client is deployed under a
      // per-locale base href, so `/en` alone would not resolve to the application.
      expect(redirect).toHaveBeenCalledTimes(1);
      expect(redirect).toHaveBeenCalledWith(
        `${rootUrl}/${DEFAULT_LANGUAGE_CODE}/`
      );
    });

    it('addresses no route that the single-canvas shell removed', async () => {
      await subscriptionController.stripeCallback(
        createRequest(),
        createResponse()
      );

      const [target] = redirect.mock.calls[0] as [string];

      // Membership is a module now, not a screen. `account` covers the retired
      // account route the membership tab used to live under.
      for (const retired of ['/account', '/home', '/pricing', '/zen']) {
        expect(target).not.toContain(retired);
      }
    });

    it('creates the subscription from the session Stripe returned before redirecting', async () => {
      await subscriptionController.stripeCallback(
        createRequest(),
        createResponse()
      );

      // Redirecting first would race the browser against the write, so the order
      // is part of the contract rather than an implementation detail.
      expect(createSubscriptionViaStripe).toHaveBeenCalledTimes(1);
      expect(createSubscriptionViaStripe).toHaveBeenCalledWith(
        checkoutSessionId
      );
      expect(
        createSubscriptionViaStripe.mock.invocationCallOrder[0]
      ).toBeLessThan(redirect.mock.invocationCallOrder[0]);
    });

    it('records that a subscription was created, without naming who it was created for', async () => {
      await subscriptionController.stripeCallback(
        createRequest(),
        createResponse()
      );

      // The distinction this line carries is provisioned versus not provisioned,
      // which is what makes the warning below meaningful by contrast. Who it was
      // provisioned for is deliberately absent: a subscriber identifier in a log
      // line is readable by everyone who can read the log and outlives the payment
      // it describes, and the subscription record already holds it.
      expect(loggerLog).toHaveBeenCalledWith(
        'A Stripe checkout session has been turned into a subscription',
        'SubscriptionController'
      );
      expect(loggerWarn).not.toHaveBeenCalled();

      const emitted = (loggerLog.mock.calls as unknown[][])
        .map((call) =>
          call
            .map((argument) =>
              typeof argument === 'string' ? argument : inspect(argument)
            )
            .join(' ')
        )
        .join('\n');

      expect(emitted).not.toContain(userId);
      expect(emitted).not.toContain(checkoutSessionId);
    });

    /**
     * What the log says when provisioning did *not* happen.
     *
     * `createSubscriptionViaStripe` swallows a provider failure and resolves
     * without a user, so the handler cannot tell the two outcomes apart from the
     * return value alone unless it looks. An unconditional success line therefore
     * announced an entitlement that was never granted - with a literal
     * `undefined` standing in for the account - and that is the single most
     * misleading thing a log can say to whoever is investigating a billing
     * complaint. The redirect is unaffected: the payer is returning in a browser
     * and must land on the application either way.
     */
    describe('when the checkout session cannot be turned into a subscription', () => {
      beforeEach(() => {
        // Exactly what the service resolves to when Stripe rejects the session.
        createSubscriptionViaStripe.mockResolvedValue(undefined);
      });

      it('claims no subscription was created', async () => {
        await subscriptionController.stripeCallback(
          createRequest(),
          createResponse()
        );

        expect(loggerLog).not.toHaveBeenCalled();
      });

      it('interpolates no undefined identity into the log', async () => {
        await subscriptionController.stripeCallback(
          createRequest(),
          createResponse()
        );

        // Asserted across every logger channel rather than only the one expected
        // to fire, so the literal cannot reappear by being moved.
        for (const logger of [loggerLog, loggerWarn]) {
          for (const [message] of logger.mock.calls as [string][]) {
            expect(message).not.toContain('undefined');
          }
        }
      });

      it('records the failure instead of staying silent', async () => {
        await subscriptionController.stripeCallback(
          createRequest(),
          createResponse()
        );

        expect(loggerWarn).toHaveBeenCalledTimes(1);
        expect(loggerWarn).toHaveBeenCalledWith(
          'A Stripe checkout session could not be turned into a subscription',
          'SubscriptionController'
        );
      });

      it('keeps the checkout session identifier out of the log', async () => {
        await subscriptionController.stripeCallback(
          createRequest(),
          createResponse()
        );

        const [message] = loggerWarn.mock.calls[0] as [string];

        // It identifies a payment session, so it does not belong in an operations
        // log; the provider error the service already logged carries the context.
        expect(message).not.toContain(checkoutSessionId);
      });

      it('still returns the payer to the locale root', async () => {
        await subscriptionController.stripeCallback(
          createRequest(),
          createResponse()
        );

        // Stranding somebody who has just paid on a bare API response would be a
        // far worse outcome than a missing entitlement they can be granted later.
        expect(redirect).toHaveBeenCalledTimes(1);
        expect(redirect).toHaveBeenCalledWith(
          `${rootUrl}/${DEFAULT_LANGUAGE_CODE}/`
        );
      });
    });
  });
});
