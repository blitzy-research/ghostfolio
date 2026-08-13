import { AccessService } from '@ghostfolio/api/app/access/access.service';
import { ActivitiesService } from '@ghostfolio/api/app/activities/activities.service';
import { PortfolioService } from '@ghostfolio/api/app/portfolio/portfolio.service';
import { UserService } from '@ghostfolio/api/app/user/user.service';
import { RedactValuesInResponseInterceptor } from '@ghostfolio/api/interceptors/redact-values-in-response/redact-values-in-response.interceptor';
import { ConfigurationService } from '@ghostfolio/api/services/configuration/configuration.service';
import { ExchangeRateDataService } from '@ghostfolio/api/services/exchange-rate-data/exchange-rate-data.service';

import { ExecutionContext, HttpException } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
import { Test, TestingModule } from '@nestjs/testing';
import { AccessPermission } from '@prisma/client';
import { firstValueFrom, of } from 'rxjs';

import { PublicController } from './public.controller';

/**
 * What a public share link is allowed to disclose.
 *
 * A share link is a capability: whoever holds the identifier is the request's
 * entire authority, and `Access.permissions` is the only thing in the system that
 * says how much of a portfolio that capability opens. Links are created
 * `READ_RESTRICTED` by default, so the restricted case below is the *normal* one
 * rather than an edge case.
 *
 * The assertions are made against the response object the handler returns rather
 * than against what the page renders, and that distinction is the whole point:
 * the client hid these figures in its template while the API kept sending them,
 * so anybody reading the JSON directly - which is all a shared URL requires - saw
 * the exact fee, quantity, unit price and value of the ten most recent trades.
 * Asserting through the UI would have passed throughout.
 */
describe('PublicController', () => {
  const accessId = '9c3f3d2a-6b64-4d2e-9b31-27a8e1a4c111';
  const userId = 'c0a8012e-4f7b-4d1a-9f3e-2b6d8c5a1e44';

  /** Every member of an activity that quantifies money or size. */
  const MONETARY_MEMBERS = [
    'fee',
    'quantity',
    'unitPrice',
    'value',
    'valueInBaseCurrency'
  ] as const;

  let access: jest.Mock;
  let publicController: PublicController;

  const activity = {
    currency: 'USD',
    date: new Date('2026-01-15T00:00:00.000Z'),
    fee: 1.95,
    quantity: 42,
    SymbolProfile: { currency: 'USD', name: 'Apple Inc.', symbol: 'AAPL' },
    type: 'BUY',
    unitPrice: 187.25,
    value: 7864.5,
    valueInBaseCurrency: 7864.5
  };

  const createController = async ({
    permissions
  }: {
    permissions: AccessPermission[];
  }) => {
    access = jest.fn().mockResolvedValue({
      permissions,
      userId,
      alias: 'Shared portfolio',
      id: accessId
    });

    const module: TestingModule = await Test.createTestingModule({
      controllers: [PublicController],
      providers: [
        { provide: AccessService, useValue: { access } },
        {
          provide: ActivitiesService,
          useValue: {
            getActivities: jest
              .fn()
              .mockResolvedValue({ activities: [activity] })
          }
        },
        {
          provide: ConfigurationService,
          useValue: {
            // Switched off, which is the self-hosted default and the only
            // configuration in which the trade list is populated at all.
            get: (key: string) =>
              key === 'ENABLE_FEATURE_SUBSCRIPTION' ? false : undefined
          }
        },
        {
          provide: ExchangeRateDataService,
          useValue: { toCurrency: (value: number) => value }
        },
        {
          provide: PortfolioService,
          useValue: {
            getDetails: jest.fn().mockResolvedValue({
              createdAt: new Date('2025-01-01T00:00:00.000Z'),
              holdings: {
                AAPL: {
                  currency: 'USD',
                  dataSource: 'YAHOO',
                  marketPrice: 190,
                  netPerformancePercentWithCurrencyEffect: 0.1,
                  quantity: 42,
                  symbol: 'AAPL',
                  valueInBaseCurrency: 7980
                }
              },
              markets: {}
            }),
            getPerformance: jest.fn().mockResolvedValue({
              performance: { netPerformancePercentageWithCurrencyEffect: 0.1 }
            })
          }
        },
        { provide: REQUEST, useValue: {} },
        {
          provide: UserService,
          useValue: {
            user: jest.fn().mockResolvedValue({
              id: userId,
              settings: { settings: { baseCurrency: 'USD' } },
              subscription: { type: 'Basic' }
            })
          }
        }
      ]
    }).compile();

    publicController = await module.resolve(PublicController);

    return publicController;
  };

  describe('a link granted only restricted read', () => {
    beforeEach(async () => {
      await createController({
        permissions: [AccessPermission.READ_RESTRICTED]
      });
    });

    it.each(MONETARY_MEMBERS)('withholds %s', async (member) => {
      const { latestActivities } =
        await publicController.getPublicPortfolio(accessId);

      // `null` rather than absent: the value component renders `null` as `*****`
      // and an absent value as a loading skeleton, so this is the difference
      // between the recipient being told a figure is withheld and being shown a
      // page that never finishes.
      expect(latestActivities[0][member]).toBeNull();
    });

    it('discloses no exact figure anywhere in the trade list', async () => {
      const response = await publicController.getPublicPortfolio(accessId);

      // Asserted over the serialised payload rather than member by member, so a
      // figure reintroduced under a different name is caught too. Every one of
      // these numbers appears in the fixture and none may reach the wire.
      const serialised = JSON.stringify(response.latestActivities);

      for (const withheld of [
        activity.fee,
        activity.quantity,
        activity.unitPrice,
        activity.value,
        activity.valueInBaseCurrency
      ]) {
        expect(serialised).not.toContain(`${withheld}`);
      }
    });

    it('still shows what was traded and when, which is what the link is for', async () => {
      const { latestActivities } =
        await publicController.getPublicPortfolio(accessId);

      // Minimisation, not removal. A restricted link remains a showcase of the
      // strategy; it stops being a disclosure of the position size.
      expect(latestActivities[0].currency).toBe(activity.currency);
      expect(latestActivities[0].date).toEqual(activity.date);
      expect(latestActivities[0].type).toBe(activity.type);
      expect(latestActivities[0].SymbolProfile).toEqual(activity.SymbolProfile);
    });
  });

  describe('a link granted unrestricted read', () => {
    beforeEach(async () => {
      await createController({ permissions: [AccessPermission.READ] });
    });

    it.each(MONETARY_MEMBERS)('discloses %s', async (member) => {
      const { latestActivities } =
        await publicController.getPublicPortfolio(accessId);

      // The owner asked for a link that shows everything, so withholding here
      // would be a regression rather than a safeguard. Asserted so the fix cannot
      // have been achieved by removing the capability altogether.
      expect(latestActivities[0][member]).toBe(activity[member]);
    });
  });

  describe('a link whose permissions are absent', () => {
    it('withholds the figures rather than assuming the wider grant', async () => {
      await createController({ permissions: undefined });

      const { latestActivities } =
        await publicController.getPublicPortfolio(accessId);

      // A row with no permissions recorded is not evidence of permission. The
      // default has to be the narrower reading, because the alternative discloses
      // on the strength of missing data.
      for (const member of MONETARY_MEMBERS) {
        expect(latestActivities[0][member]).toBeNull();
      }
    });
  });

  /**
   * The route does not return the handler's object directly: it declares
   * `RedactValuesInResponseInterceptor`, which runs afterwards and censors a fixed
   * list of paths whenever the request looks restricted. A public request has no
   * viewer at all, and `isRestrictedView` treats an absent viewer as restricted,
   * so on this route that pass runs every single time.
   *
   * That makes the composition, not the handler alone, the thing that has to be
   * right - and it is where a plausible-looking hardening went wrong once already:
   * adding the trade list's monetary paths to the shared list censored them for
   * every share request, including links whose owner had granted unrestricted
   * read, silently overruling the grant the handler had just honoured. These tests
   * pin both directions of that composition so the shared list cannot start
   * deciding what the capability decides.
   */
  describe('the redaction pass the route declares', () => {
    const applyRouteRedaction = async <T>(payload: T): Promise<T> => {
      // The interceptor is declared as returning `Observable<any>`, so its result
      // is narrowed back to the payload's own type here rather than at each call
      // site - the redaction censors values in place and never changes the shape.
      const redacted: unknown = await firstValueFrom(
        new RedactValuesInResponseInterceptor<T>().intercept(
          {
            // No `user`, which is what a public request looks like, and is
            // precisely the condition under which the pass engages.
            switchToHttp: () => {
              return { getRequest: () => ({ headers: {} }) };
            }
          } as unknown as ExecutionContext,
          { handle: () => of(payload) }
        )
      );

      return redacted as T;
    };

    it('engages on a public request, so these assertions mean something', async () => {
      // Positive control. Without it, a mis-built context that quietly returned
      // the payload untouched would make the test below pass for the wrong reason.
      const redacted = await applyRouteRedaction({ balance: 1234.56 });

      expect(redacted.balance).toBeNull();
    });

    it('leaves a restricted link withheld', async () => {
      await createController({
        permissions: [AccessPermission.READ_RESTRICTED]
      });

      const { latestActivities } = await applyRouteRedaction(
        await publicController.getPublicPortfolio(accessId)
      );

      for (const member of MONETARY_MEMBERS) {
        expect(latestActivities[0][member]).toBeNull();
      }
    });

    it('does not overrule an unrestricted grant', async () => {
      await createController({ permissions: [AccessPermission.READ] });

      const { latestActivities } = await applyRouteRedaction(
        await publicController.getPublicPortfolio(accessId)
      );

      // The owner granted a link that shows everything. Censoring it here would
      // make the grant unreachable in production while every handler-level test
      // above still passed, which is exactly the failure this guards.
      for (const member of MONETARY_MEMBERS) {
        expect(latestActivities[0][member]).toBe(activity[member]);
      }
    });
  });

  describe('an identifier that opens nothing', () => {
    it('reports not found rather than an empty portfolio', async () => {
      await createController({
        permissions: [AccessPermission.READ_RESTRICTED]
      });

      access.mockResolvedValue(null);

      await expect(
        publicController.getPublicPortfolio(accessId)
      ).rejects.toThrow(HttpException);
    });
  });
});
