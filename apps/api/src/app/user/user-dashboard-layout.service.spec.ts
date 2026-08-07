import { PrismaService } from '@ghostfolio/api/services/prisma/prisma.service';
import { UserDashboardLayout } from '@ghostfolio/common/interfaces';

import { InternalServerErrorException, Logger } from '@nestjs/common';
import { inspect } from 'node:util';

import { UserDashboardLayoutService } from './user-dashboard-layout.service';

describe('UserDashboardLayoutService', () => {
  const layoutDocumentKeys = ['modules', 'version'];
  const rowEnvelopeKeys = ['layoutData', 'updatedAt', 'userId'];
  const userId = '8b1f1b3a-6f2a-4a52-9c0b-6d5f2f7c3a11';

  let findUnique: jest.Mock;
  let loggerError: jest.SpyInstance;
  let loggerWarn: jest.SpyInstance;
  let prismaServiceMock: {
    $transaction: jest.Mock;
    userDashboardLayout: Record<string, jest.Mock>;
  };
  let upsert: jest.Mock;
  let userDashboardLayoutService: UserDashboardLayoutService;

  /** Everything the service emitted through the given logger level, as one string. */
  const emitted = (aLoggerLevel: jest.SpyInstance) =>
    (aLoggerLevel.mock.calls as unknown[][])
      .map((call) =>
        call
          .map((argument) =>
            typeof argument === 'string' ? argument : inspect(argument)
          )
          .join(' ')
      )
      .join('\n');

  // Every delegate method the service could conceivably reach is present as a
  // spy, so `calledDelegateMethods` proves not only that the expected one ran
  // but that no other one did.
  const calledDelegateMethods = () =>
    Object.entries(prismaServiceMock.userDashboardLayout)
      .filter(([, delegateMethod]) => delegateMethod.mock.calls.length > 0)
      .map(([methodName]) => methodName);

  beforeEach(() => {
    // Silenced rather than left to print, and captured rather than merely
    // silenced. A refused document is reported at `error` and a dropped entry at
    // `warn`, both deliberately, and several cases below exercise exactly those
    // paths - so without this the suite's output is dominated by lines that are
    // the expected behaviour rather than a problem. Holding the spies is what
    // lets the assertions below state what those lines may and may not carry.
    loggerError = jest
      .spyOn(Logger, 'error')
      .mockImplementation(() => undefined);
    loggerWarn = jest.spyOn(Logger, 'warn').mockImplementation(() => undefined);

    findUnique = jest.fn();
    upsert = jest.fn();

    prismaServiceMock = {
      $transaction: jest.fn(),
      userDashboardLayout: {
        count: jest.fn(),
        create: jest.fn(),
        delete: jest.fn(),
        deleteMany: jest.fn(),
        findMany: jest.fn(),
        findUnique,
        update: jest.fn(),
        upsert
      }
    };

    userDashboardLayoutService = new UserDashboardLayoutService(
      prismaServiceMock as unknown as PrismaService
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('takes the Prisma delegate as its only dependency, so persisting a layout can emit nothing and notify nobody', () => {
    expect(UserDashboardLayoutService.length).toBe(1);
  });

  describe('getLayout', () => {
    it('reads the row through the authenticated user primary key and touches no other delegate method', async () => {
      findUnique.mockResolvedValue(null);

      await userDashboardLayoutService.getLayout(userId);

      expect(findUnique).toHaveBeenCalledTimes(1);
      expect(findUnique).toHaveBeenCalledWith({ where: { userId } });
      expect(calledDelegateMethods()).toEqual(['findUnique']);
      expect(prismaServiceMock.$transaction).not.toHaveBeenCalled();
    });

    it('reports an absent row as null instead of fabricating an empty layout', async () => {
      findUnique.mockResolvedValue(null);

      await expect(
        userDashboardLayoutService.getLayout(userId)
      ).resolves.toBeNull();

      await expect(
        userDashboardLayoutService.getLayout(userId)
      ).resolves.not.toEqual({ modules: [] });
    });

    it('reports a row whose layout is SQL NULL as null', async () => {
      findUnique.mockResolvedValue({
        layoutData: null,
        updatedAt: new Date('2026-01-01T00:00:00.000Z'),
        userId
      });

      await expect(
        userDashboardLayoutService.getLayout(userId)
      ).resolves.toBeNull();
    });

    it('keeps a stored empty layout distinct from an absent one', async () => {
      const layoutData: UserDashboardLayout = { modules: [], version: 1 };

      findUnique.mockResolvedValue(null);

      const absentLayout = await userDashboardLayoutService.getLayout(userId);

      findUnique.mockResolvedValue({ layoutData, userId });

      const emptyLayout = await userDashboardLayoutService.getLayout(userId);

      expect(absentLayout).toBeNull();
      expect(emptyLayout).not.toBeNull();
      expect(emptyLayout).toEqual({ modules: [], version: 1 });
      expect(emptyLayout).not.toEqual(absentLayout);
    });

    it('returns the persisted document unwrapped, without the row envelope', async () => {
      const layoutData: UserDashboardLayout = {
        modules: [
          { cols: 6, moduleType: 'portfolio-overview', rows: 4, x: 0, y: 0 }
        ],
        version: 1
      };

      findUnique.mockResolvedValue({
        layoutData,
        updatedAt: new Date('2026-01-01T00:00:00.000Z'),
        userId
      });

      const layout = await userDashboardLayoutService.getLayout(userId);

      expect(layout).toEqual({
        modules: [
          { cols: 6, moduleType: 'portfolio-overview', rows: 4, x: 0, y: 0 }
        ],
        version: 1
      });
      expect(Object.keys(layout).sort()).toEqual(layoutDocumentKeys);
      expect(Object.keys(layout.modules[0]).sort()).toEqual([
        'cols',
        'moduleType',
        'rows',
        'x',
        'y'
      ]);

      for (const rowEnvelopeKey of rowEnvelopeKeys) {
        expect(layout).not.toHaveProperty(rowEnvelopeKey);
      }
    });

    it('reads through to the delegate on every call, caching no layout state of its own', async () => {
      findUnique.mockResolvedValue({
        layoutData: { modules: [], version: 1 },
        userId
      });

      const firstLayout = await userDashboardLayoutService.getLayout(userId);

      findUnique.mockResolvedValue({
        layoutData: {
          modules: [{ cols: 4, moduleType: 'holdings', rows: 4, x: 8, y: 0 }],
          version: 1
        },
        userId
      });

      const secondLayout = await userDashboardLayoutService.getLayout(userId);

      expect(findUnique).toHaveBeenCalledTimes(2);
      expect(firstLayout).toEqual({ modules: [], version: 1 });
      expect(secondLayout).toEqual({
        modules: [{ cols: 4, moduleType: 'holdings', rows: 4, x: 8, y: 0 }],
        version: 1
      });
    });

    it('returns an unrecognised module type unchanged, leaving the client registry as the only judge of it', async () => {
      findUnique.mockResolvedValue({
        layoutData: {
          modules: [
            { cols: 2, moduleType: 'some-future-module', rows: 2, x: 10, y: 7 }
          ],
          version: 1
        },
        userId
      });

      const layout = await userDashboardLayoutService.getLayout(userId);

      expect(layout.modules).toHaveLength(1);
      expect(layout.modules[0].moduleType).toBe('some-future-module');
    });

    it('returns cell dimensions unchanged, leaving the grid engine as the only judge of them', async () => {
      findUnique.mockResolvedValue({
        layoutData: {
          modules: [{ cols: 12, moduleType: 'x-ray', rows: 9, x: 0, y: 23 }],
          version: 1
        },
        userId
      });

      const layout = await userDashboardLayoutService.getLayout(userId);

      expect(layout.modules[0]).toEqual({
        cols: 12,
        moduleType: 'x-ray',
        rows: 9,
        x: 0,
        y: 23
      });
    });

    it('does not omit a layout that carries no version discriminator', async () => {
      findUnique.mockResolvedValue({
        layoutData: {
          modules: [{ cols: 4, moduleType: 'markets', rows: 4, x: 4, y: 0 }]
        },
        userId
      });

      const layout = await userDashboardLayoutService.getLayout(userId);

      expect(layout).toEqual({
        modules: [{ cols: 4, moduleType: 'markets', rows: 4, x: 4, y: 0 }]
      });
      expect(layout).not.toHaveProperty('version');
    });

    it('carries over only the two members the contract defines, so a surplus property cannot reach the response', async () => {
      findUnique.mockResolvedValue({
        layoutData: {
          modules: [{ cols: 4, moduleType: 'holdings', rows: 4, x: 0, y: 0 }],
          surplus: 'unexpected',
          version: 1
        },
        userId
      });

      const layout = await userDashboardLayoutService.getLayout(userId);

      expect(Object.keys(layout).sort()).toEqual(layoutDocumentKeys);
      expect(layout).not.toHaveProperty('surplus');
    });

    it('drops a module entry it cannot interpret and keeps every entry it can', async () => {
      // The client iterates this array inside the success handler of its read, so
      // an entry that cannot be destructured throws in the one place a failure
      // must not surface: the canvas has already concluded the read succeeded, so
      // it never enters its error state, offers no retry, and shows a blank canvas
      // that the next module added would overwrite the stored arrangement from.
      findUnique.mockResolvedValue({
        layoutData: {
          modules: [
            { cols: 4, moduleType: 'holdings', rows: 4, x: 0, y: 0 },
            null,
            'not-an-object',
            { cols: 4, moduleType: 'markets', rows: 'four', x: 0, y: 4 },
            { cols: 4, rows: 4, x: 0, y: 8 },
            { cols: 4, moduleType: '', rows: 4, x: 0, y: 12 },
            { cols: 6, moduleType: 'watchlist', rows: 3, x: 4, y: 0 }
          ],
          version: 1
        },
        userId
      });

      const layout = await userDashboardLayoutService.getLayout(userId);

      expect(layout.modules).toEqual([
        { cols: 4, moduleType: 'holdings', rows: 4, x: 0, y: 0 },
        { cols: 6, moduleType: 'watchlist', rows: 3, x: 4, y: 0 }
      ]);

      // How much was unreadable is a measure rather than a value, so it is safe to
      // report and is the one thing an operator can act on. What those entries
      // held, and whose row they came out of, is neither reported nor implied.
      expect(loggerWarn).toHaveBeenCalledTimes(1);
      expect(loggerWarn).toHaveBeenCalledWith(
        'GF-USER-DASHBOARD-LAYOUT-ITEMS-DROPPED (count 5)',
        'UserDashboardLayoutService'
      );

      const reported = emitted(loggerWarn);

      expect(reported).not.toContain(userId);
      expect(reported).not.toContain('markets');
      expect(reported).not.toContain('not-an-object');
    });

    it.each([
      {
        description: 'is not an object at all',
        layoutData: 'not-a-document',
        reason: 'INVALID_ENVELOPE'
      },
      {
        description: 'is a JSON array',
        layoutData: [],
        reason: 'INVALID_ENVELOPE'
      },
      {
        description: 'holds no modules array',
        layoutData: { modules: 'not-an-array', version: 1 },
        reason: 'MISSING_MODULES_ARRAY'
      },
      {
        description: 'declares a version this build does not know',
        layoutData: { modules: [], version: 2 },
        reason: 'UNSUPPORTED_VERSION'
      }
    ])(
      'refuses a stored document that $description rather than reporting it as an absent layout, reporting $reason',
      async ({ layoutData, reason }) => {
        // Refusing is what keeps the document safe. The client maps a failed read
        // to its own error state, which offers a retry and permits no write at
        // all, so the stored arrangement survives for an operator to look at.
        // Answering `null` instead would look like a first visit, and the first
        // module added afterwards would be written out as the user's entire
        // arrangement - destroying the very document that could not be read.
        findUnique.mockResolvedValue({ layoutData, userId });

        await expect(
          userDashboardLayoutService.getLayout(userId)
        ).rejects.toThrow(InternalServerErrorException);

        // A stable identifier and the reason category, so an operator can tell the
        // three ways a document can be unreadable apart and search for either.
        expect(loggerError).toHaveBeenCalledTimes(1);
        expect(loggerError).toHaveBeenCalledWith(
          `GF-USER-DASHBOARD-LAYOUT-UNREADABLE (reason ${reason})`,
          'UserDashboardLayoutService'
        );

        // And nothing else. The account is the authenticated caller, which the
        // request log already establishes, and the document came out of a column
        // the viewer's own client wrote - so neither belongs in a line that
        // outlives the request and is readable by everyone who can read the log.
        expect(emitted(loggerError)).not.toContain(userId);
      }
    );

    it('reports an unsupported version without disclosing the value it read', async () => {
      // The value is `unknown` because it comes straight out of a JSON column, so
      // it can be an object, an array or a string the viewer's client put there.
      // Serialising it to explain the refusal is what would copy stored viewer
      // data into the log; the reason category is what the operator acts on.
      findUnique.mockResolvedValue({
        layoutData: {
          modules: [],
          version: { future: 'shape', secret: 'do-not-log-me' }
        },
        userId
      });

      await expect(
        userDashboardLayoutService.getLayout(userId)
      ).rejects.toThrow(InternalServerErrorException);

      expect(loggerError).toHaveBeenCalledWith(
        'GF-USER-DASHBOARD-LAYOUT-UNREADABLE (reason UNSUPPORTED_VERSION)',
        'UserDashboardLayoutService'
      );

      const reported = emitted(loggerError);

      expect(reported).not.toContain('do-not-log-me');
      expect(reported).not.toContain('future');
      expect(reported).not.toContain('shape');
      expect(reported).not.toContain(userId);
    });

    it('propagates a read failure instead of reporting it as an absent layout', async () => {
      const readFailure = new Error('connection terminated unexpectedly');

      findUnique.mockRejectedValue(readFailure);

      await expect(userDashboardLayoutService.getLayout(userId)).rejects.toBe(
        readFailure
      );

      expect(findUnique).toHaveBeenCalledTimes(1);
      expect(calledDelegateMethods()).toEqual(['findUnique']);
      expect(prismaServiceMock.$transaction).not.toHaveBeenCalled();
    });
  });

  describe('updateLayout', () => {
    const userDashboardLayout: UserDashboardLayout = {
      modules: [{ cols: 4, moduleType: 'holdings', rows: 4, x: 0, y: 0 }],
      version: 1
    };

    it('writes the complete snapshot through a single upsert keyed by the authenticated user', async () => {
      upsert.mockResolvedValue({ layoutData: userDashboardLayout, userId });

      await userDashboardLayoutService.updateLayout({
        userDashboardLayout,
        userId
      });

      expect(upsert).toHaveBeenCalledTimes(1);
      expect(upsert).toHaveBeenCalledWith({
        create: { layoutData: userDashboardLayout, userId },
        update: { layoutData: userDashboardLayout },
        where: { userId }
      });
      expect(calledDelegateMethods()).toEqual(['upsert']);
      expect(prismaServiceMock.$transaction).not.toHaveBeenCalled();
    });

    it('keys the create branch by the foreign key scalar, so the write stays a single atomic statement', async () => {
      upsert.mockResolvedValue({ layoutData: userDashboardLayout, userId });

      await userDashboardLayoutService.updateLayout({
        userDashboardLayout,
        userId
      });

      const [{ create }] = upsert.mock.calls[0] as [
        { create: Record<string, unknown> }
      ];

      expect(Object.keys(create).sort()).toEqual(['layoutData', 'userId']);
      expect(create.userId).toBe(userId);
      expect(create).not.toHaveProperty('user');
      expect(prismaServiceMock.$transaction).not.toHaveBeenCalled();
      expect(
        prismaServiceMock.userDashboardLayout.create
      ).not.toHaveBeenCalled();
      expect(
        prismaServiceMock.userDashboardLayout.update
      ).not.toHaveBeenCalled();
      expect(
        prismaServiceMock.userDashboardLayout.findUnique
      ).not.toHaveBeenCalled();
    });

    it('returns only the persisted layout document', async () => {
      upsert.mockResolvedValue({
        layoutData: userDashboardLayout,
        updatedAt: new Date('2026-01-01T00:00:00.000Z'),
        userId
      });

      const layout = await userDashboardLayoutService.updateLayout({
        userDashboardLayout,
        userId
      });

      expect(layout).toEqual({
        modules: [{ cols: 4, moduleType: 'holdings', rows: 4, x: 0, y: 0 }],
        version: 1
      });
      expect(Object.keys(layout).sort()).toEqual(layoutDocumentKeys);

      for (const rowEnvelopeKey of rowEnvelopeKeys) {
        expect(layout).not.toHaveProperty(rowEnvelopeKey);
      }
    });

    it('persists an empty layout, which is a state a user can legitimately reach', async () => {
      const emptyUserDashboardLayout: UserDashboardLayout = {
        modules: [],
        version: 1
      };

      upsert.mockResolvedValue({
        layoutData: emptyUserDashboardLayout,
        userId
      });

      const layout = await userDashboardLayoutService.updateLayout({
        userDashboardLayout: emptyUserDashboardLayout,
        userId
      });

      expect(upsert).toHaveBeenCalledTimes(1);
      expect(upsert).toHaveBeenCalledWith({
        create: { layoutData: { modules: [], version: 1 }, userId },
        update: { layoutData: { modules: [], version: 1 } },
        where: { userId }
      });
      expect(layout).not.toBeNull();
      expect(layout).toEqual({ modules: [], version: 1 });
    });

    it('persists an unrecognised module type verbatim, without validating or normalising it', async () => {
      const futureUserDashboardLayout: UserDashboardLayout = {
        modules: [
          { cols: 2, moduleType: 'some-future-module', rows: 2, x: 10, y: 7 }
        ],
        version: 1
      };

      upsert.mockResolvedValue({
        layoutData: futureUserDashboardLayout,
        userId
      });

      const layout = await userDashboardLayoutService.updateLayout({
        userDashboardLayout: futureUserDashboardLayout,
        userId
      });

      expect(upsert).toHaveBeenCalledTimes(1);
      expect(upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: {
            layoutData: {
              modules: [
                {
                  cols: 2,
                  moduleType: 'some-future-module',
                  rows: 2,
                  x: 10,
                  y: 7
                }
              ],
              version: 1
            },
            userId
          }
        })
      );
      expect(layout.modules[0].moduleType).toBe('some-future-module');
    });

    it('persists cell dimensions verbatim, without clamping, rounding or coercing them', async () => {
      const boundaryUserDashboardLayout: UserDashboardLayout = {
        modules: [
          { cols: 2, moduleType: 'watchlist', rows: 2, x: 11, y: 0 },
          { cols: 12, moduleType: 'activities', rows: 9, x: 0, y: 23 }
        ],
        version: 1
      };

      upsert.mockResolvedValue({
        layoutData: boundaryUserDashboardLayout,
        userId
      });

      const layout = await userDashboardLayoutService.updateLayout({
        userDashboardLayout: boundaryUserDashboardLayout,
        userId
      });

      expect(upsert).toHaveBeenCalledTimes(1);
      expect(upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          update: {
            layoutData: {
              modules: [
                { cols: 2, moduleType: 'watchlist', rows: 2, x: 11, y: 0 },
                { cols: 12, moduleType: 'activities', rows: 9, x: 0, y: 23 }
              ],
              version: 1
            }
          }
        })
      );
      expect(layout.modules).toEqual([
        { cols: 2, moduleType: 'watchlist', rows: 2, x: 11, y: 0 },
        { cols: 12, moduleType: 'activities', rows: 9, x: 0, y: 23 }
      ]);
    });

    it('writes through to the delegate on every call, caching no layout state of its own', async () => {
      upsert.mockResolvedValue({ layoutData: userDashboardLayout, userId });

      await userDashboardLayoutService.updateLayout({
        userDashboardLayout,
        userId
      });
      await userDashboardLayoutService.updateLayout({
        userDashboardLayout,
        userId
      });

      expect(upsert).toHaveBeenCalledTimes(2);
      expect(calledDelegateMethods()).toEqual(['upsert']);
    });

    it('propagates a write failure instead of reporting the layout as persisted', async () => {
      const writeFailure = new Error(
        'could not serialize access due to concurrent update'
      );

      upsert.mockRejectedValue(writeFailure);

      await expect(
        userDashboardLayoutService.updateLayout({
          userDashboardLayout,
          userId
        })
      ).rejects.toBe(writeFailure);

      expect(upsert).toHaveBeenCalledTimes(1);
      expect(calledDelegateMethods()).toEqual(['upsert']);
      expect(prismaServiceMock.$transaction).not.toHaveBeenCalled();
    });
  });
});
