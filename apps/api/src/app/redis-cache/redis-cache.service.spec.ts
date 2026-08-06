import { ConfigurationService } from '@ghostfolio/api/services/configuration/configuration.service';

import { Cache } from '@nestjs/cache-manager';
import { Logger } from '@nestjs/common';
import ms from 'ms';

import { RedisCacheService } from './redis-cache.service';

/**
 * The two properties of this service an outage depends on: that its health
 * check always produces an answer, and that a store it cannot reach does not
 * drown the log.
 *
 * Both were observed to fail against a genuinely unreachable Redis, and neither
 * is visible in a passing build - the service compiles either way, and every
 * other suite in this project runs against a store that answers. The store is
 * therefore driven from here as a set of promises whose settlement this suite
 * controls, because "never settles" is exactly the condition that has to be
 * reproducible for these assertions to mean anything.
 */
describe('RedisCacheService', () => {
  /** A promise that models a command the store never answers. */
  const neverSettles = () => new Promise<never>(() => undefined);

  let clientErrorHandler: (error: Error) => void;
  let del: jest.Mock;
  let get: jest.Mock;
  let loggerError: jest.SpyInstance;
  let redisCacheService: RedisCacheService;
  let set: jest.Mock;

  /** Backs the healthy-store mocks, so a read observes what the write stored. */
  let store: Map<string, string>;

  beforeEach(() => {
    // `Date.now()` is faked alongside the timers, which is what lets the
    // suppression window be crossed deliberately rather than waited out.
    jest.useFakeTimers();

    store = new Map<string, string>();

    del = jest.fn((key: string) => {
      store.delete(key);

      return Promise.resolve(true);
    });

    get = jest.fn((key: string) => Promise.resolve(store.get(key)));

    set = jest.fn((key: string, value: string) => {
      store.set(key, value);

      return Promise.resolve(value);
    });

    loggerError = jest
      .spyOn(Logger, 'error')
      .mockImplementation(() => undefined);

    // Stands in for the Keyv store the real service pulls out of the cache
    // manager. The `error` listener is captured rather than ignored: it is the
    // unit under test for the log-volume assertions below.
    const client = {
      deserialize: undefined as unknown,
      iterator: () => [],
      on: (event: string, listener: (error: Error) => void) => {
        if (event === 'error') {
          clientErrorHandler = listener;
        }
      }
    };

    redisCacheService = new RedisCacheService(
      { del, get, set, stores: [client] } as unknown as Cache,
      { get: () => ms('1 hour') } as unknown as ConfigurationService
    );
  });

  afterEach(() => {
    loggerError.mockRestore();

    jest.useRealTimers();
  });

  describe('isHealthy', () => {
    it('reports a reachable store as healthy', async () => {
      await expect(redisCacheService.isHealthy()).resolves.toBe(true);
    });

    it('resolves even though the store never answers, so the caller can always report the outage', async () => {
      // Every command hangs, which is what an unreachable store actually does:
      // its client queues commands until it reconnects rather than failing them.
      del.mockReturnValue(neverSettles());
      get.mockReturnValue(neverSettles());
      set.mockReturnValue(neverSettles());

      const isHealthy = redisCacheService.isHealthy();

      await jest.advanceTimersByTimeAsync(ms('5 seconds'));

      // A pending promise here is the defect this asserts against: the health
      // handler awaits this value, so never producing one means never writing a
      // response and a liveness probe timing out instead of seeing a 503.
      await expect(isHealthy).resolves.toBe(false);
    });

    it('does not wait for its own cleanup', async () => {
      // The read and write succeed, so the outcome is known immediately; only
      // the removal hangs. Awaiting it would hold a healthy answer hostage to an
      // unreachable store just as surely as an unhealthy one.
      del.mockReturnValue(neverSettles());

      await expect(redisCacheService.isHealthy()).resolves.toBe(true);

      expect(del).toHaveBeenCalledTimes(1);
    });

    it('removes exactly the key it wrote', async () => {
      await redisCacheService.isHealthy();

      const [writtenKey] = set.mock.calls[0] as [string];
      const [removedKey] = del.mock.calls[0] as [string];

      expect(writtenKey).toMatch(/^__health_check__/);
      expect(removedKey).toBe(writtenKey);
    });

    it('leaves no pending timer behind once the outcome is known', async () => {
      await redisCacheService.isHealthy();

      // The probe answers in microseconds against a healthy store; an uncleared
      // timeout would keep a timer live for the rest of the five-second window on
      // every single probe.
      expect(jest.getTimerCount()).toBe(0);
    });

    it('reports a store that answers with the wrong value as unhealthy', async () => {
      get.mockResolvedValue('a value this probe never wrote');

      await expect(redisCacheService.isHealthy()).resolves.toBe(false);
      expect(loggerError).toHaveBeenCalledWith(
        'Redis health check failed: value mismatch',
        'RedisCacheService'
      );
    });

    it('diagnoses a hanging store as a timeout', async () => {
      get.mockReturnValue(neverSettles());
      set.mockReturnValue(neverSettles());

      const isHealthy = redisCacheService.isHealthy();

      await jest.advanceTimersByTimeAsync(ms('5 seconds'));
      await isHealthy;

      // The one line that explains the outage. It is only worth emitting if it
      // stays findable, which is what the suppression below protects.
      expect(loggerError).toHaveBeenCalledWith(
        'Redis health check failed: timeout',
        'RedisCacheService'
      );
    });
  });

  describe('store client error reporting', () => {
    const connectionRefused = () =>
      new Error('connect ECONNREFUSED 127.0.0.1:6379');

    it('subscribes to the error channel of the store client', () => {
      expect(typeof clientErrorHandler).toBe('function');
    });

    it('reports the first occurrence in full', () => {
      const error = connectionRefused();

      clientErrorHandler(error);

      // The error object, not its message, so the first report still carries a
      // stack.
      expect(loggerError).toHaveBeenCalledTimes(1);
      expect(loggerError).toHaveBeenCalledWith(error, 'RedisCacheService');
    });

    it('collapses identical repeats instead of logging every one', () => {
      for (let attempt = 0; attempt < 500; attempt++) {
        clientErrorHandler(connectionRefused());
      }

      // The client re-emits on every reconnect attempt, so this is the
      // difference between one line and thousands.
      expect(loggerError).toHaveBeenCalledTimes(1);
    });

    it('releases a single aggregated summary once the window has passed', () => {
      clientErrorHandler(connectionRefused());

      for (let attempt = 0; attempt < 499; attempt++) {
        clientErrorHandler(connectionRefused());
      }

      jest.advanceTimersByTime(ms('1 minute'));

      clientErrorHandler(connectionRefused());

      expect(loggerError).toHaveBeenCalledTimes(2);

      const [summary] = loggerError.mock.calls[1] as [string];

      // The count is what tells an operator the dependency is still down, and
      // it is the reason suppression is not simply silence.
      expect(summary).toContain('connect ECONNREFUSED 127.0.0.1:6379');
      expect(summary).toContain('repeated 500 times');
      expect(summary).toContain('60 seconds');
    });

    it('reports a different failure immediately rather than masking it behind an ongoing one', () => {
      clientErrorHandler(connectionRefused());

      const readOnlyReplica = new Error(
        'READONLY You can not write against a read only replica'
      );

      clientErrorHandler(readOnlyReplica);

      expect(loggerError).toHaveBeenCalledTimes(2);
      expect(loggerError).toHaveBeenLastCalledWith(
        readOnlyReplica,
        'RedisCacheService'
      );
    });

    it('groups messageless errors under a stable label rather than under undefined', () => {
      clientErrorHandler(undefined);
      clientErrorHandler(undefined);

      expect(loggerError).toHaveBeenCalledTimes(1);
    });
  });
});
