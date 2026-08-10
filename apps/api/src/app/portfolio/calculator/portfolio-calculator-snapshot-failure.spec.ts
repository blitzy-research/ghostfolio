import { RoaiPortfolioCalculator } from '@ghostfolio/api/app/portfolio/calculator/roai/portfolio-calculator';
import { RedisCacheService } from '@ghostfolio/api/app/redis-cache/redis-cache.service';
import { ConfigurationService } from '@ghostfolio/api/services/configuration/configuration.service';
import { ExchangeRateDataService } from '@ghostfolio/api/services/exchange-rate-data/exchange-rate-data.service';
import { PortfolioSnapshotService } from '@ghostfolio/api/services/queues/portfolio-snapshot/portfolio-snapshot.service';

import { CurrentRateService } from '../current-rate.service';

/**
 * What happens to the application when a portfolio snapshot computation job
 * fails.
 *
 * The failure itself is ordinary - the queue declares a job stalled when a
 * computation runs longer than its lock, which a large portfolio does - but the
 * shape of it is not. The job's completion is awaited inside the calculator's
 * constructor, so the promise holding that failure exists whether or not anyone
 * is waiting on it, and the snapshot PROCESSOR builds a calculator without ever
 * waiting on it. An unclaimed rejection ends the Node process, which is how one
 * stalled job took the entire API down rather than failing one request.
 *
 * These cases pin the two properties that keep it a failed request: the
 * rejection is always claimed, and a job that has already settled as failed does
 * not answer every later request with the same failure forever.
 */
describe('PortfolioCalculator snapshot computation failure', () => {
  const stalledMessage = 'job stalled more than maxStalledCount';
  const userId = 'a2b6d1ea-6d94-4e0c-9a02-6a1f0d3c9e77';

  let remove: jest.Mock;

  /**
   * A queue that answers with a job which has already failed - the state a
   * stalled job leaves behind - and records whether it was asked to discard it.
   */
  const createQueueStub = ({
    removeRejects = false
  }: { removeRejects?: boolean } = {}) => {
    remove = jest
      .fn()
      .mockImplementation(() =>
        removeRejects
          ? Promise.reject(new Error(`Could not remove job ${userId}`))
          : Promise.resolve()
      );

    const job = {
      finished: () => Promise.reject(new Error(stalledMessage)),
      remove
    };

    return {
      addJobToQueue: () => Promise.resolve(job),
      getJob: () => Promise.resolve(job)
    } as unknown as PortfolioSnapshotService;
  };

  /** A cache that holds nothing, so the computation is waited for. */
  const createRedisCacheStub = () =>
    ({
      get: () => Promise.resolve(null),
      getPortfolioSnapshotKey: () => `portfolio-snapshot-${userId}`,
      set: () => Promise.resolve(null)
    }) as unknown as RedisCacheService;

  const createCalculator = (options: { removeRejects?: boolean } = {}) =>
    new RoaiPortfolioCalculator({
      accountBalanceItems: [],
      activities: [],
      currency: 'USD',
      filters: [],
      userId,
      configurationService: null as unknown as ConfigurationService,
      currentRateService: null as unknown as CurrentRateService,
      exchangeRateDataService: null as unknown as ExchangeRateDataService,
      portfolioSnapshotService: createQueueStub(options),
      redisCacheService: createRedisCacheStub()
    });

  /** Yields long enough for an unclaimed rejection to have been reported. */
  const settle = async () => {
    for (let iteration = 0; iteration < 3; iteration++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };

  it('does not end the process when the computation fails and nothing is waiting on it', async () => {
    const unclaimed: unknown[] = [];
    const listener = (reason: unknown) => unclaimed.push(reason);

    process.on('unhandledRejection', listener);

    try {
      // Exactly what the snapshot processor does: build a calculator and never
      // touch the promise its constructor started.
      createCalculator();

      await settle();
    } finally {
      process.off('unhandledRejection', listener);
    }

    expect(unclaimed).toEqual([]);
  });

  it('still reports the failure to a caller that is waiting for the snapshot', async () => {
    const portfolioCalculator = createCalculator();

    // Claiming the rejection at creation must not consume it: a request that
    // asked for the snapshot has to be told the computation failed.
    await expect(portfolioCalculator.getSnapshot()).rejects.toThrow(
      stalledMessage
    );
  });

  it('discards the settled job, so the next request is not answered with the same failure', async () => {
    const portfolioCalculator = createCalculator();

    await expect(portfolioCalculator.getSnapshot()).rejects.toThrow(
      stalledMessage
    );

    // The job id is derived from the user, so a failed job left in place would
    // deduplicate every later request onto itself and answer each one with this
    // same failure - past a restart, because it lives in the queue's store.
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it('reports the original failure even when the job cannot be discarded', async () => {
    const portfolioCalculator = createCalculator({ removeRejects: true });

    // Discarding is an attempt to recover, not part of what the caller asked
    // for, so its own failure must not replace the answer the caller gets.
    await expect(portfolioCalculator.getSnapshot()).rejects.toThrow(
      stalledMessage
    );

    expect(remove).toHaveBeenCalledTimes(1);
  });
});
