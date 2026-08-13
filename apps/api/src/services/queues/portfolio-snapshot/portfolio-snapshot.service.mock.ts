import { RedisCacheServiceMock } from '@ghostfolio/api/app/redis-cache/redis-cache.service.mock';

import { Job, JobOptions } from 'bull';
import { addMilliseconds } from 'date-fns';
import ms from 'ms';
import { setTimeout } from 'timers/promises';

import { PortfolioSnapshotQueueJob } from './interfaces/portfolio-snapshot-queue-job.interface';

/**
 * What the processor leaves behind when the computation succeeds, minus the
 * computation.
 *
 * An empty snapshot is enough and is deliberately not a computed one: no test
 * reads it. The calculator's own `computeSnapshot()` - which is what the scenario
 * specs assert on - computes from the activities every time and never consults
 * this value; only `getSnapshot()` does, and it is exercised by a spec that
 * supplies its own queue.
 *
 * What matters is that SOMETHING is published, because the calculator waits for
 * exactly that (see `addJobToQueue`).
 */
const createPortfolioSnapshot = () => {
  return {
    activitiesCount: 0,
    createdAt: new Date(),
    currentValueInBaseCurrency: '0',
    errors: [],
    hasErrors: false,
    historicalData: [],
    positions: [],
    totalFeesWithCurrencyEffect: '0',
    totalInterestWithCurrencyEffect: '0',
    totalInvestment: '0',
    totalInvestmentWithCurrencyEffect: '0',
    totalLiabilitiesWithCurrencyEffect: '0'
  };
};

export const PortfolioSnapshotServiceMock = {
  addJobToQueue({
    data,
    opts
  }: {
    data: PortfolioSnapshotQueueJob;
    name: string;
    opts?: JobOptions;
  }): Promise<Job<any>> {
    const mockJob: Partial<Job<any>> = {
      finished: async () => {
        await setTimeout(100);

        /**
         * Publishing the snapshot to the cache is what ENDS the wait, and leaving
         * it out is what made every scenario spec leak a process.
         *
         * The calculator asks the queue to compute, waits for the job, and then
         * looks in the cache again - and if the snapshot is still not there it
         * asks again, indefinitely, because the snapshot appearing is the only
         * thing that can tell it the work is done. In production the processor
         * publishes it and the second look succeeds. This double did the waiting
         * but never the publishing, so a single calculator built in a test span
         * an unbounded loop of enqueue-and-wait, one real 100 ms timer per turn,
         * for as long as the process lived. Jest then reported that a worker
         * "failed to exit gracefully and has been force exited" - and both halves
         * of that were true: the loop was still running, and the run had to kill
         * it. Every one of the twenty scenario specs did this, in parallel.
         *
         * Published from `finished` rather than from enqueueing, so the ordering
         * matches the real thing: the snapshot exists once the job completes, not
         * the moment it is queued.
         */
        RedisCacheServiceMock.set(
          RedisCacheServiceMock.getPortfolioSnapshotKey({
            filters: data?.filters,
            userId: data?.userId
          }),
          JSON.stringify({
            // Mirrors the processor's own expiration, computed from the clock the
            // test is running on - which under faked time is the scenario's date,
            // so the freshly published snapshot is never immediately stale.
            expiration: addMilliseconds(new Date(), ms('1 minute')).getTime(),
            portfolioSnapshot: createPortfolioSnapshot()
          })
        );

        return Promise.resolve();
      }
    };

    this.jobsStore.set(opts?.jobId, mockJob);

    return Promise.resolve(mockJob as Job<any>);
  },
  getJob(jobId: string): Promise<Job<any>> {
    const job = this.jobsStore.get(jobId);

    return Promise.resolve(job as Job<any>);
  },
  jobsStore: new Map<string, Partial<Job<any>>>()
};
