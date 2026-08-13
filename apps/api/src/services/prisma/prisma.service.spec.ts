import {
  DEFAULT_DATABASE_CONNECTION_TIMEOUT,
  DEFAULT_DATABASE_QUERY_TIMEOUT
} from '@ghostfolio/common/config';

import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaPg } from '@prisma/adapter-pg';

import { PrismaService } from './prisma.service';

// The driver adapter is the subject of every assertion here: it is where the
// pool configuration lands, so replacing it with a spy is what makes that
// configuration observable without a database.
jest.mock('@prisma/adapter-pg', () => ({
  PrismaPg: jest.fn()
}));

// Only the client class is replaced. The rest of the module is kept genuine
// because `@ghostfolio/common/config` imports Prisma's generated enums as
// values, and a wholesale mock would leave them undefined for every module that
// reads one.
jest.mock('@prisma/client', () => {
  const actual = jest.requireActual('@prisma/client');

  return {
    ...actual,
    PrismaClient: class {
      public $connect() {
        return Promise.resolve();
      }

      public $disconnect() {
        return Promise.resolve();
      }
    }
  };
});

describe('PrismaService', () => {
  const connectionString =
    'postgresql://user:password@localhost:5432/ghostfolio-db';

  let loggerWarn: jest.SpyInstance;
  let prismaPgMock: jest.Mock;

  /** Instantiates the service with the given environment and nothing else set. */
  const createService = (environment: Record<string, string> = {}) => {
    const configService = {
      get: (key: string) =>
        key === 'DATABASE_URL' ? connectionString : environment[key]
    } as unknown as ConfigService;

    return new PrismaService(configService);
  };

  /** The pool configuration the service handed to the driver adapter. */
  const poolConfiguration = () => prismaPgMock.mock.calls[0][0];

  /** The adapter options - the observability hooks - the service passed. */
  const adapterOptions = () => prismaPgMock.mock.calls[0][1];

  beforeEach(() => {
    loggerWarn = jest.spyOn(Logger, 'warn').mockImplementation(() => undefined);

    prismaPgMock = PrismaPg as unknown as jest.Mock;
    prismaPgMock.mockClear();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('passes the configured connection string through unchanged', () => {
    createService();

    expect(poolConfiguration().connectionString).toEqual(connectionString);
  });

  it('bounds connection acquisition, so an unresponsive database cannot hold a request open indefinitely', () => {
    createService();

    expect(poolConfiguration().connectionTimeoutMillis).toEqual(
      DEFAULT_DATABASE_CONNECTION_TIMEOUT
    );
  });

  it('bounds statement execution on both the client and the server, because a frozen backend cannot enforce its own limit', () => {
    createService();

    // `statement_timeout` ends a query the server is still willing to answer;
    // `query_timeout` is the half that applies when it has stopped answering at
    // all; `idle_in_transaction_session_timeout` stops an abandoned transaction
    // from holding its locks. All three, or the path is only partly bounded.
    expect(poolConfiguration().statement_timeout).toEqual(
      DEFAULT_DATABASE_QUERY_TIMEOUT
    );
    expect(poolConfiguration().query_timeout).toEqual(
      DEFAULT_DATABASE_QUERY_TIMEOUT
    );
    expect(poolConfiguration().idle_in_transaction_session_timeout).toEqual(
      DEFAULT_DATABASE_QUERY_TIMEOUT
    );
  });

  it('lets an operator tighten or relax either ceiling from the environment', () => {
    createService({
      DATABASE_CONNECTION_TIMEOUT: '5000',
      DATABASE_QUERY_TIMEOUT: '2500'
    });

    expect(poolConfiguration().connectionTimeoutMillis).toEqual(5000);
    expect(poolConfiguration().query_timeout).toEqual(2500);
    expect(poolConfiguration().statement_timeout).toEqual(2500);
    expect(poolConfiguration().idle_in_transaction_session_timeout).toEqual(
      2500
    );
  });

  it('honours an explicit zero, which is how an operator asks for no limit on purpose', () => {
    createService({
      DATABASE_CONNECTION_TIMEOUT: '0',
      DATABASE_QUERY_TIMEOUT: '0'
    });

    expect(poolConfiguration().connectionTimeoutMillis).toEqual(0);
    expect(poolConfiguration().query_timeout).toEqual(0);
  });

  it.each([
    ['', 'an empty value'],
    ['abc', 'a value that is not a number'],
    ['-1', 'a negative value']
  ])(
    'falls back to the default rather than removing the ceiling for %p (%s)',
    (value: string) => {
      createService({
        DATABASE_CONNECTION_TIMEOUT: value,
        DATABASE_QUERY_TIMEOUT: value
      });

      // The failure mode this guards against is specific: every one of these
      // settings is disabled by a falsy value, so letting `NaN` through would
      // silently restore the unbounded behaviour the ceiling exists to end -
      // and would look identical to having configured nothing.
      expect(poolConfiguration().connectionTimeoutMillis).toEqual(
        DEFAULT_DATABASE_CONNECTION_TIMEOUT
      );
      expect(poolConfiguration().query_timeout).toEqual(
        DEFAULT_DATABASE_QUERY_TIMEOUT
      );
    }
  );

  it('reports a pool error, which fires outside any request and would otherwise go unseen', () => {
    createService();

    adapterOptions().onPoolError(new Error('terminating connection'));

    expect(loggerWarn).toHaveBeenCalledWith(
      'Database pool error: terminating connection',
      'PrismaService'
    );
  });

  it('reports a connection error the same way', () => {
    createService();

    adapterOptions().onConnectionError(new Error('connection reset by peer'));

    expect(loggerWarn).toHaveBeenCalledWith(
      'Database connection error: connection reset by peer',
      'PrismaService'
    );
  });

  it('logs only the message of a driver error, never the configuration it carries', () => {
    createService();

    // A `pg` error keeps a reference to the configuration that produced it,
    // and that configuration holds the database password. Logging the error
    // object would copy the credentials into the log.
    const error = Object.assign(new Error('timeout expired'), {
      config: { connectionString }
    });

    adapterOptions().onPoolError(error);

    const emitted = (loggerWarn.mock.calls as unknown[][])
      .map((call) => call.join(' '))
      .join('\n');

    expect(emitted).toContain('timeout expired');
    expect(emitted).not.toContain('password');
  });
});
