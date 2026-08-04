import { ConfigurationService } from '@ghostfolio/api/services/configuration/configuration.service';
import { PropertyService } from '@ghostfolio/api/services/property/property.service';
import { DEFAULT_LANGUAGE_CODE } from '@ghostfolio/common/config';

import { Logger } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
import { Test, TestingModule } from '@nestjs/testing';
import { Request, Response } from 'express';

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
  let redirect: jest.Mock;
  let subscriptionController: SubscriptionController;

  beforeEach(async () => {
    createSubscriptionViaStripe = jest.fn().mockResolvedValue(userId);
    redirect = jest.fn();

    // The handler reports the created subscription through Nest's logger. Silenced
    // so the suite output stays readable, and asserted below rather than merely
    // suppressed, because that line is the operator's only record of the event.
    loggerLog = jest.spyOn(Logger, 'log').mockImplementation(() => undefined);

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

    it('records the created subscription against the user it was created for', async () => {
      await subscriptionController.stripeCallback(
        createRequest(),
        createResponse()
      );

      // The identity comes from the subscription that was just created, not from
      // the request: the Stripe callback is unauthenticated, so there is no request
      // user to read.
      expect(loggerLog).toHaveBeenCalledWith(
        `Subscription for user '${userId}' has been created via Stripe`,
        'SubscriptionController'
      );
    });
  });
});
