import { RedisCacheService } from '@ghostfolio/api/app/redis-cache/redis-cache.service';
import { DataEnhancerService } from '@ghostfolio/api/services/data-provider/data-enhancer/data-enhancer.service';
import { DataProviderService } from '@ghostfolio/api/services/data-provider/data-provider.service';
import { PropertyService } from '@ghostfolio/api/services/property/property.service';

import { HttpException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { DataSource } from '@prisma/client';
import ms from 'ms';

import { HealthService } from './health.service';

/**
 * How much outbound work a deep health probe is allowed to cause.
 *
 * A deep probe is not a cheap read. `hasResponseFromDataEnhancer` and
 * `hasResponseFromDataProvider` each start a fresh, deliberately uncached request
 * to a third party with a thirty-second request timeout. Unguarded, one cheap
 * request buys thirty seconds of a socket, a slot in the event loop and a slice of
 * this deployment's provider quota, with nothing capping how many can be
 * outstanding at once.
 *
 * Guarding the route narrows *who* can ask. These assertions are about the other
 * half: that asking repeatedly, or concurrently, does not multiply the outbound
 * calls - so the ceiling holds for an administrator, for the administration screen
 * rendering one indicator per provider, and for anything that gets past the guard.
 */
describe('HealthService', () => {
  const DEEP_PROBE_VERDICT_TTL = ms('1 minute');

  let checkQuote: jest.Mock;
  let enhance: jest.Mock;
  let healthService: HealthService;

  /** A promise the test settles by hand, standing in for a slow provider. */
  const deferred = () => {
    let resolve: (value: boolean) => void;

    const promise = new Promise<boolean>((resolveProbe) => {
      resolve = resolveProbe;
    });

    return { promise, resolve };
  };

  beforeEach(async () => {
    jest.useFakeTimers();

    checkQuote = jest.fn().mockResolvedValue(true);
    enhance = jest.fn().mockResolvedValue(true);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        HealthService,
        { provide: DataEnhancerService, useValue: { enhance } },
        { provide: DataProviderService, useValue: { checkQuote } },
        { provide: PropertyService, useValue: { getByKey: jest.fn() } },
        { provide: RedisCacheService, useValue: { isHealthy: jest.fn() } }
      ]
    }).compile();

    healthService = module.get(HealthService);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('hasResponseFromDataProvider', () => {
    it('makes one outbound call for many concurrent callers', async () => {
      const slowProvider = deferred();

      checkQuote.mockReturnValue(slowProvider.promise);

      const probes = [
        healthService.hasResponseFromDataProvider(DataSource.YAHOO),
        healthService.hasResponseFromDataProvider(DataSource.YAHOO),
        healthService.hasResponseFromDataProvider(DataSource.YAHOO)
      ];

      slowProvider.resolve(true);

      // Every caller is answered, from one request. This is the property that caps
      // the fan-out: arriving in parallel no longer multiplies the outbound work.
      expect(await Promise.all(probes)).toEqual([true, true, true]);
      expect(checkQuote).toHaveBeenCalledTimes(1);
    });

    it('serves the verdict it reached without asking the provider again', async () => {
      await healthService.hasResponseFromDataProvider(DataSource.YAHOO);
      await healthService.hasResponseFromDataProvider(DataSource.YAHOO);
      await healthService.hasResponseFromDataProvider(DataSource.YAHOO);

      // Whether a provider is answering is a property of that provider, not of the
      // request asking, and it does not change from one second to the next.
      expect(checkQuote).toHaveBeenCalledTimes(1);
    });

    it('asks again once the verdict has stopped standing', async () => {
      await healthService.hasResponseFromDataProvider(DataSource.YAHOO);

      jest.advanceTimersByTime(DEEP_PROBE_VERDICT_TTL + 1);

      await healthService.hasResponseFromDataProvider(DataSource.YAHOO);

      // A window, not a cache: an operator who waits and asks again is told about
      // the provider now. The window is what makes the ceiling one call per
      // provider per minute rather than one call ever.
      expect(checkQuote).toHaveBeenCalledTimes(2);
    });

    it('keeps a verdict per provider rather than one for all of them', async () => {
      checkQuote.mockImplementation((dataSource: DataSource) => {
        return Promise.resolve(dataSource === DataSource.YAHOO);
      });

      await expect(
        healthService.hasResponseFromDataProvider(DataSource.YAHOO)
      ).resolves.toBe(true);
      await expect(
        healthService.hasResponseFromDataProvider(DataSource.COINGECKO)
      ).resolves.toBe(false);

      // The administration screen renders one indicator per provider, so sharing a
      // verdict across them would report every provider as whichever answered
      // first.
      expect(checkQuote).toHaveBeenCalledTimes(2);
    });

    it('reports an unhealthy provider and does not keep asking about it', async () => {
      checkQuote.mockResolvedValue(false);

      await expect(
        healthService.hasResponseFromDataProvider(DataSource.YAHOO)
      ).resolves.toBe(false);
      await expect(
        healthService.hasResponseFromDataProvider(DataSource.YAHOO)
      ).resolves.toBe(false);

      // A provider that is down is the case where repeated probing costs most - the
      // call runs to its full timeout - so the window has to cover it too.
      expect(checkQuote).toHaveBeenCalledTimes(1);
    });
  });

  describe('hasResponseFromDataEnhancer', () => {
    it('makes one outbound call for many concurrent callers', async () => {
      const slowEnhancer = deferred();

      enhance.mockReturnValue(slowEnhancer.promise);

      const probes = [
        healthService.hasResponseFromDataEnhancer('TRACKINSIGHT'),
        healthService.hasResponseFromDataEnhancer('TRACKINSIGHT')
      ];

      slowEnhancer.resolve(true);

      expect(await Promise.all(probes)).toEqual([true, true]);
      expect(enhance).toHaveBeenCalledTimes(1);
    });

    it('lets a refusal of an unrecognised name reach the caller unchanged', async () => {
      const notFound = new HttpException('Not Found', 404);

      enhance.mockRejectedValue(notFound);

      // This is how an unknown name is refused *before* any outbound request is
      // made, and it is also what keeps the bookkeeping below from being grown by
      // a caller. Swallowing it into a `false` would turn a 404 into a 503 and
      // make an unbounded set of names look like probeable ones.
      await expect(
        healthService.hasResponseFromDataEnhancer('NOT-AN-ENHANCER')
      ).rejects.toBe(notFound);
    });

    it('records nothing for a name it refused', async () => {
      enhance.mockRejectedValueOnce(new HttpException('Not Found', 404));

      await expect(
        healthService.hasResponseFromDataEnhancer('NOT-AN-ENHANCER')
      ).rejects.toThrow();

      enhance.mockResolvedValue(true);

      await expect(
        healthService.hasResponseFromDataEnhancer('NOT-AN-ENHANCER')
      ).resolves.toBe(true);

      // A failed probe must not stand as a verdict: it would suppress the next real
      // probe for a whole window, and a transient provider fault would read as a
      // sustained outage.
      expect(enhance).toHaveBeenCalledTimes(2);
    });

    it('does not confuse an enhancer with a provider of the same name', async () => {
      enhance.mockResolvedValue(false);
      checkQuote.mockResolvedValue(true);

      await expect(
        healthService.hasResponseFromDataEnhancer(DataSource.YAHOO)
      ).resolves.toBe(false);
      await expect(
        healthService.hasResponseFromDataProvider(DataSource.YAHOO)
      ).resolves.toBe(true);

      // `YAHOO` is both an enhancer name and a data source. Keying on the name
      // alone would have one answer the other's question.
      expect(enhance).toHaveBeenCalledTimes(1);
      expect(checkQuote).toHaveBeenCalledTimes(1);
    });
  });
});
