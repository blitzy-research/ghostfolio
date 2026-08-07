import { ConfigurationService } from '@ghostfolio/api/services/configuration/configuration.service';

import { Cache } from '@nestjs/cache-manager';
import { Logger } from '@nestjs/common';
import ms from 'ms';
import { inspect } from 'node:util';

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

  /**
   * Everything reported at `error`, flattened into one string.
   *
   * Used for the negative assertions: what matters about these lines is as much
   * what they cannot contain - a host, a port, a provider message, a stack - as
   * what they do.
   */
  const emittedErrors = () =>
    (loggerError.mock.calls as unknown[][])
      .map((call) =>
        call
          .map((argument) =>
            typeof argument === 'string' ? argument : inspect(argument)
          )
          .join(' ')
      )
      .join('\n');

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
        'GF-REDIS-HEALTH-CHECK-FAILED (category VALUE_MISMATCH)',
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
        'GF-REDIS-HEALTH-CHECK-FAILED (category PROBE_TIMED_OUT)',
        'RedisCacheService'
      );
    });

    it('categorises a fault the store itself raised without repeating what it said', async () => {
      // The store's own text is where the host and the port live, so it selects a
      // category and then goes no further. What is emitted describes the class of
      // fault; where the store was and what it was asked stays in the store's log.
      set.mockRejectedValue(new Error('connect ECONNREFUSED 10.1.2.3:6379'));

      await expect(redisCacheService.isHealthy()).resolves.toBe(false);

      expect(loggerError).toHaveBeenCalledWith(
        'GF-REDIS-HEALTH-CHECK-FAILED (category CONNECTION_REFUSED)',
        'RedisCacheService'
      );
      expect(emittedErrors()).not.toContain('10.1.2.3');
      expect(emittedErrors()).not.toContain('6379');
    });

    it('reports a fault it has no category for as unclassified rather than describing it', async () => {
      set.mockRejectedValue(new Error('something nobody has seen before'));

      await expect(redisCacheService.isHealthy()).resolves.toBe(false);

      expect(loggerError).toHaveBeenCalledWith(
        'GF-REDIS-HEALTH-CHECK-FAILED (category UNCLASSIFIED)',
        'RedisCacheService'
      );
      expect(emittedErrors()).not.toContain('nobody has seen before');
    });
  });

  describe('store client error reporting', () => {
    const connectionRefused = () =>
      new Error('connect ECONNREFUSED 127.0.0.1:6379');

    it('subscribes to the error channel of the store client', () => {
      expect(typeof clientErrorHandler).toBe('function');
    });

    it('reports the first occurrence as an event and a category, and nothing the client said', () => {
      clientErrorHandler(connectionRefused());

      expect(loggerError).toHaveBeenCalledTimes(1);
      expect(loggerError).toHaveBeenCalledWith(
        'GF-REDIS-CLIENT-ERROR (category CONNECTION_REFUSED)',
        'RedisCacheService'
      );

      // Neither the `Error` object nor its message: a store client's error text
      // names the address it could not reach and the command that failed, and the
      // object additionally carries a stack that maps the application out. The
      // category is what an operator acts on, and it is all that is emitted.
      const reported = emittedErrors();

      expect(reported).not.toContain('127.0.0.1');
      expect(reported).not.toContain('6379');
      expect(reported).not.toContain('ECONNREFUSED');
      const [firstReport] = loggerError.mock.calls[0] as [unknown];

      expect(firstReport).toEqual(expect.any(String));
    });

    it('collapses repeats of the same fault instead of logging every one', () => {
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

      // The count and the elapsed time are what tell an operator the dependency is
      // still down, and they are the reason suppression is not simply silence.
      // They are also measures rather than values, which is why they are the only
      // things the summary adds to the event and its category.
      expect(summary).toBe(
        'GF-REDIS-CLIENT-ERROR (category CONNECTION_REFUSED, repeated 500 times in the last 60 seconds)'
      );
      expect(summary).not.toContain('127.0.0.1');
      expect(summary).not.toContain('6379');
    });

    it('reports a different failure immediately rather than masking it behind an ongoing one', () => {
      clientErrorHandler(connectionRefused());

      // A server reply carries no errno code, only a leading error word, so this
      // is what the text matching is for: without it every codeless reply would
      // collapse into one category and this fault would be counted as a repeat of
      // the connection failure above rather than reported.
      clientErrorHandler(
        new Error('READONLY You can not write against a read only replica')
      );

      expect(loggerError).toHaveBeenCalledTimes(2);
      expect(loggerError).toHaveBeenLastCalledWith(
        'GF-REDIS-CLIENT-ERROR (category READ_ONLY_REPLICA)',
        'RedisCacheService'
      );
      expect(emittedErrors()).not.toContain('read only replica');
    });

    it('groups faults it cannot recognise under one stable category rather than under undefined', () => {
      clientErrorHandler(undefined);
      clientErrorHandler(undefined);

      expect(loggerError).toHaveBeenCalledTimes(1);
      expect(loggerError).toHaveBeenCalledWith(
        'GF-REDIS-CLIENT-ERROR (category UNCLASSIFIED)',
        'RedisCacheService'
      );
    });
  });
});
