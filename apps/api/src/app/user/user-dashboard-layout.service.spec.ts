import { PrismaService } from '@ghostfolio/api/services/prisma/prisma.service';
import { MAX_USER_DASHBOARD_LAYOUT_ITEMS } from '@ghostfolio/common/config';
import { UserDashboardLayout } from '@ghostfolio/common/interfaces';

import { ConflictException, Logger } from '@nestjs/common';
import { inspect } from 'node:util';

import { UserDashboardLayoutService } from './user-dashboard-layout.service';

describe('UserDashboardLayoutService', () => {
  const layoutDocumentKeys = ['modules', 'version'];
  // What a write answers with: the stored document plus the row's concurrency
  // token, which is transport-only and never part of `layoutData`.
  const layoutResponseKeys = ['modules', 'revision', 'version'];
  const rowEnvelopeKeys = ['layoutData', 'updatedAt', 'userId'];
  const userId = '8b1f1b3a-6f2a-4a52-9c0b-6d5f2f7c3a11';

  /** A stored modules array of the given length, every entry interpretable. */
  const storedModulesOfLength = (length: number) =>
    Array.from({ length }, () => ({
      cols: 4,
      moduleType: 'holdings',
      rows: 4,
      x: 0,
      y: 0
    }));

  let deleteMany: jest.Mock;
  let findUnique: jest.Mock;
  let loggerError: jest.SpyInstance;
  let loggerWarn: jest.SpyInstance;
  let prismaServiceMock: {
    $transaction: jest.Mock;
    userDashboardLayout: Record<string, jest.Mock>;
  };
  let updateMany: jest.Mock;
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

    deleteMany = jest.fn();
    findUnique = jest.fn();
    updateMany = jest.fn();
    upsert = jest.fn();

    prismaServiceMock = {
      $transaction: jest.fn(),
      userDashboardLayout: {
        count: jest.fn(),
        create: jest.fn(),
        delete: jest.fn(),
        deleteMany,
        findMany: jest.fn(),
        findUnique,
        update: jest.fn(),
        updateMany,
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

      // The stored document, plus the row's `updatedAt` as an opaque concurrency
      // token - and nothing else off the row. The token is transport-only: it is
      // never written into `layoutData`, so the stored shape stays exactly the two
      // envelope members and the five per item.
      expect(layout).toEqual({
        modules: [
          { cols: 6, moduleType: 'portfolio-overview', rows: 4, x: 0, y: 0 }
        ],
        revision: '2026-01-01T00:00:00.000Z',
        version: 1
      });
      expect(Object.keys(layout).sort()).toEqual(layoutResponseKeys);
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

    it('carries over only the five members each item defines, so a surplus property on an ENTRY cannot reach the response either', async () => {
      // The envelope test above is not the whole contract, and the difference is
      // where the leak actually was: filtering the modules array hands back the very
      // objects that came out of the JSONB column, so anything riding on an entry
      // travelled through untouched even while the envelope was being rebuilt. The
      // column is writable by hand and by any future build, so the members below are
      // the two shapes that matter - transient grid bookkeeping the client is
      // explicitly forbidden from sending, and a value that has no business leaving
      // the database at all.
      findUnique.mockResolvedValue({
        layoutData: {
          modules: [
            {
              cols: 4,
              dragEnabled: true,
              internalNote: 'do-not-return-me',
              layerIndex: 2,
              minItemCols: 2,
              moduleType: 'holdings',
              rows: 4,
              x: 0,
              y: 0
            },
            {
              cols: 6,
              moduleType: 'watchlist',
              rows: 3,
              x: 4,
              y: 0,
              y2: 99
            }
          ],
          version: 1
        },
        userId
      });

      const layout = await userDashboardLayoutService.getLayout(userId);

      // Stated as an exact equality rather than as a series of `not.toHaveProperty`
      // checks, so a member nobody thought to name is caught as well.
      expect(layout).toEqual({
        modules: [
          { cols: 4, moduleType: 'holdings', rows: 4, x: 0, y: 0 },
          { cols: 6, moduleType: 'watchlist', rows: 3, x: 4, y: 0 }
        ],
        version: 1
      });

      for (const module of layout.modules) {
        expect(Object.keys(module).sort()).toEqual([
          'cols',
          'moduleType',
          'rows',
          'x',
          'y'
        ]);
      }

      // A surplus member on an entry is not an unreadable entry - the entry is
      // perfectly interpretable and is kept - so nothing is dropped and the
      // partially-readable warning must stay silent.
      expect(loggerWarn).not.toHaveBeenCalled();
    });

    it('hands back fresh entries rather than the stored objects, so a caller cannot reach into the row', async () => {
      const storedModule = {
        cols: 4,
        moduleType: 'holdings',
        rows: 4,
        x: 0,
        y: 0
      };
      const storedModules = [storedModule];

      findUnique.mockResolvedValue({
        layoutData: { modules: storedModules, version: 1 },
        userId
      });

      const layout = await userDashboardLayoutService.getLayout(userId);

      // Identity, not equality. Returning the stored object by reference is what let
      // surplus members escape in the first place, and it is the property to pin:
      // equality would still hold for a reference and would say nothing.
      expect(layout.modules).not.toBe(storedModules);
      expect(layout.modules[0]).not.toBe(storedModule);
      expect(layout.modules[0]).toEqual(storedModule);
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

    it('returns a layout that is exactly at the ceiling in full', async () => {
      findUnique.mockResolvedValue({
        layoutData: {
          modules: storedModulesOfLength(MAX_USER_DASHBOARD_LAYOUT_ITEMS),
          version: 1
        },
        userId
      });

      const layout = await userDashboardLayoutService.getLayout(userId);

      expect(layout.modules).toHaveLength(MAX_USER_DASHBOARD_LAYOUT_ITEMS);
      expect(loggerWarn).not.toHaveBeenCalled();
    });

    it('bounds a stored layout that holds more entries than a layout is allowed to hold', async () => {
      // The write DTO is not the only way a document reaches this column: direct
      // database access, a migration, or an older build can all leave one there,
      // and a read with no ceiling of its own serves whatever it finds. A document
      // holding twenty thousand entries was returned in full - over a megabyte of
      // it - for a canvas that has twenty-one module types to place.
      findUnique.mockResolvedValue({
        layoutData: { modules: storedModulesOfLength(20000), version: 1 },
        userId
      });

      const layout = await userDashboardLayoutService.getLayout(userId);

      expect(layout.modules).toHaveLength(MAX_USER_DASHBOARD_LAYOUT_ITEMS);

      // Bounded rather than refused, deliberately. Refusing would cost the user
      // every module they had placed over a condition they did not create;
      // answering with as much as a layout may hold leaves the canvas usable, and
      // the row is untouched either way.
      expect(layout.modules[0]).toEqual({
        cols: 4,
        moduleType: 'holdings',
        rows: 4,
        x: 0,
        y: 0
      });

      // The same identifier the unreadable-entry case reports, because the count
      // is what an operator acts on and it does not change with the reason.
      expect(loggerWarn).toHaveBeenCalledTimes(1);
      expect(loggerWarn).toHaveBeenCalledWith(
        `GF-USER-DASHBOARD-LAYOUT-ITEMS-DROPPED (count ${
          20000 - MAX_USER_DASHBOARD_LAYOUT_ITEMS
        })`,
        'UserDashboardLayoutService'
      );
    });

    it('counts entries dropped for either reason once, when a stored layout is both oversized and partly unreadable', async () => {
      findUnique.mockResolvedValue({
        layoutData: {
          modules: [
            null,
            'not-an-object',
            ...storedModulesOfLength(MAX_USER_DASHBOARD_LAYOUT_ITEMS + 50)
          ],
          version: 1
        },
        userId
      });

      const layout = await userDashboardLayoutService.getLayout(userId);

      expect(layout.modules).toHaveLength(MAX_USER_DASHBOARD_LAYOUT_ITEMS);
      expect(loggerWarn).toHaveBeenCalledWith(
        'GF-USER-DASHBOARD-LAYOUT-ITEMS-DROPPED (count 52)',
        'UserDashboardLayoutService'
      );
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
      // The three JSON scalars that are FALSY. Named individually rather than
      // folded into the string case above, because they are the ones a truthiness
      // test silently swallows: `!layoutData` cannot tell them from an absent row,
      // so each was reported as "this viewer has never saved a layout" - the single
      // most damaging answer available, since the client reads it as a first visit,
      // opens the module catalog and writes the first module added out as the whole
      // arrangement, destroying the document that could not be read. Refusing them
      // is what keeps the row intact for an operator to look at.
      {
        description: 'is the JSON literal false',
        layoutData: false,
        reason: 'INVALID_ENVELOPE'
      },
      {
        description: 'is the JSON number zero',
        layoutData: 0,
        reason: 'INVALID_ENVELOPE'
      },
      {
        description: 'is the empty JSON string',
        layoutData: '',
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

        // Rejecting is itself the assertion the falsy cases exist for: the answer
        // must be an ERROR and specifically not the `null` that means "never saved",
        // and `rejects` is what distinguishes the two.
        await expect(
          userDashboardLayoutService.getLayout(userId)
        ).rejects.toThrow(ConflictException);

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
      ).rejects.toThrow(ConflictException);

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

  describe('deleteLayout', () => {
    it('discards the row through the authenticated user primary key and touches no other delegate method', async () => {
      deleteMany.mockResolvedValue({ count: 1 });

      await userDashboardLayoutService.deleteLayout(userId);

      expect(deleteMany).toHaveBeenCalledTimes(1);
      expect(deleteMany).toHaveBeenCalledWith({ where: { userId } });
      expect(calledDelegateMethods()).toEqual(['deleteMany']);
      expect(prismaServiceMock.$transaction).not.toHaveBeenCalled();
    });

    // The reason a discard exists at all is that a document this build cannot
    // interpret leaves the canvas refusing every write, so the account is
    // unrecoverable from the UI without it. That reason is only served if the
    // discard STORES nothing: a recovery that wrote an arrangement would be
    // inventing one, and the user would be left with a layout nobody chose.
    it('stores no arrangement of its own, so recovering cannot invent one', async () => {
      deleteMany.mockResolvedValue({ count: 1 });

      await userDashboardLayoutService.deleteLayout(userId);

      expect(upsert).not.toHaveBeenCalled();
      expect(updateMany).not.toHaveBeenCalled();
      expect(
        prismaServiceMock.userDashboardLayout.create
      ).not.toHaveBeenCalled();
      expect(
        prismaServiceMock.userDashboardLayout.update
      ).not.toHaveBeenCalled();
    });

    // `deleteMany` rather than `delete` is the whole point: `delete` raises
    // `P2025` when the row is absent, which would make discarding an arrangement
    // that was never saved an error even though it leaves exactly the state the
    // caller asked for.
    it('treats the absence of a row as success rather than as a failure', async () => {
      deleteMany.mockResolvedValue({ count: 0 });

      await expect(
        userDashboardLayoutService.deleteLayout(userId)
      ).resolves.toBeUndefined();

      expect(deleteMany).toHaveBeenCalledTimes(1);
      expect(
        prismaServiceMock.userDashboardLayout.delete
      ).not.toHaveBeenCalled();
    });

    it('is idempotent, so discarding twice leaves the same state as discarding once', async () => {
      deleteMany.mockResolvedValueOnce({ count: 1 });
      deleteMany.mockResolvedValueOnce({ count: 0 });

      await userDashboardLayoutService.deleteLayout(userId);
      await userDashboardLayoutService.deleteLayout(userId);

      expect(deleteMany).toHaveBeenCalledTimes(2);
      expect(
        (deleteMany.mock.calls as unknown[][]).map(([argument]) => argument)
      ).toEqual([{ where: { userId } }, { where: { userId } }]);
      expect(calledDelegateMethods()).toEqual(['deleteMany']);
    });

    it('propagates a delete failure instead of reporting the layout as discarded', async () => {
      const deleteFailure = new Error('connection terminated unexpectedly');

      deleteMany.mockRejectedValue(deleteFailure);

      await expect(
        userDashboardLayoutService.deleteLayout(userId)
      ).rejects.toBe(deleteFailure);

      expect(deleteMany).toHaveBeenCalledTimes(1);
      expect(calledDelegateMethods()).toEqual(['deleteMany']);
    });

    it('reports nothing back, so a discard cannot be mistaken for a layout', async () => {
      deleteMany.mockResolvedValue({ count: 1 });

      expect(
        await userDashboardLayoutService.deleteLayout(userId)
      ).toBeUndefined();
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

      // The document exactly as submitted, plus the concurrency token the row now
      // carries - and nothing from the row envelope itself. The token is what makes
      // the client's NEXT write conditional; without it every later write would
      // carry the revision this one has just superseded and would be refused.
      expect(layout).toEqual({
        modules: [{ cols: 4, moduleType: 'holdings', rows: 4, x: 0, y: 0 }],
        revision: '2026-01-01T00:00:00.000Z',
        version: 1
      });
      expect(Object.keys(layout).sort()).toEqual(layoutResponseKeys);

      for (const rowEnvelopeKey of rowEnvelopeKeys) {
        expect(layout).not.toHaveProperty(rowEnvelopeKey);
      }
    });

    /**
     * The write answers through the read's projection, not through a cast.
     *
     * The stored value is deliberately spelled with things the contract does not
     * define - a surplus member on the envelope, a surplus member on an item, and
     * an entry that is not an item at all - because a cast would hand every one of
     * them straight back while claiming the return type. Only a projection removes
     * them, and removing them is what makes a write and a read of one row agree:
     * the read has always rebuilt the document this way, so anything the read would
     * alter used to make the same row answer the two verbs differently.
     *
     * Not reachable through the endpoint - the request pipe now refuses a
     * non-object entry and a surplus member before the service is called - which is
     * exactly why it is asserted here, where the row can be spelled directly. The
     * guarantee has to hold for a row this build did not write.
     */
    it('returns the projection of what was stored rather than the stored value itself', async () => {
      const storedLayoutData = {
        modules: [
          {
            cols: 4,
            moduleType: 'holdings',
            rows: 4,
            secret: 'must not travel',
            x: 0,
            y: 0
          },
          [],
          { cols: 6, moduleType: 'markets', rows: 4, x: 4, y: 0 }
        ],
        surplus: 'must not travel',
        version: 1
      };

      upsert.mockResolvedValue({ layoutData: storedLayoutData, userId });

      const layout = await userDashboardLayoutService.updateLayout({
        userDashboardLayout: storedLayoutData as unknown as UserDashboardLayout,
        userId
      });

      expect(Object.keys(layout).sort()).toEqual(layoutDocumentKeys);
      expect(layout).toEqual({
        modules: [
          { cols: 4, moduleType: 'holdings', rows: 4, x: 0, y: 0 },
          { cols: 6, moduleType: 'markets', rows: 4, x: 4, y: 0 }
        ],
        version: 1
      });

      for (const layoutItem of layout.modules) {
        expect(Object.keys(layoutItem).sort()).toEqual([
          'cols',
          'moduleType',
          'rows',
          'x',
          'y'
        ]);
      }

      // Fresh objects rather than the ones out of the row, so a caller cannot
      // reach through the response into the value the write handed back.
      expect(layout).not.toBe(storedLayoutData);
      expect(layout.modules[0]).not.toBe(storedLayoutData.modules[0]);

      // The uninterpretable entry is reported as a count and nothing else - the
      // same measure the read emits - so an operator learns how much of the
      // document could not be read without learning what was in it.
      expect(emitted(loggerWarn)).toContain(
        'GF-USER-DASHBOARD-LAYOUT-ITEMS-DROPPED (count 1)'
      );
      expect(emitted(loggerWarn)).not.toContain(userId);
      expect(emitted(loggerWarn)).not.toContain('must not travel');
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

    it('commits successive layouts in the order it was asked, leaving the row holding the last one', async () => {
      // The server-order half of the write-ordering contract. This method carries no
      // revision column and no stale-write guard, so it cannot itself tell an older
      // submission from a newer one - the ordering is established one layer up, by
      // the client's serialised write queue, which never has two requests
      // outstanding. What this asserts is the other side of that division of
      // responsibility: given submissions one at a time, each `await`ed before the
      // next, the row ends up holding the LAST document submitted and no earlier one
      // can overwrite it. A regression that made this method reorder, batch, retry or
      // merge submissions would break here even though the client is unchanged.
      const submitted: UserDashboardLayout[] = [4, 6, 8, 10].map((cols) => ({
        modules: [{ cols, moduleType: 'holdings', rows: 4, x: 0, y: 0 }],
        version: 1
      }));

      // The row, modelled rather than mocked away, so "what the database is left
      // holding" is an observation instead of an assumption.
      let storedLayoutData: unknown = null;

      upsert.mockImplementation(
        ({ update }: { update: { layoutData: unknown } }) => {
          storedLayoutData = update.layoutData;

          return Promise.resolve({ layoutData: storedLayoutData, userId });
        }
      );

      for (const userDashboardLayoutSubmission of submitted) {
        await userDashboardLayoutService.updateLayout({
          userDashboardLayout: userDashboardLayoutSubmission,
          userId
        });
      }

      const submittedColumns = (
        upsert.mock.calls as [{ update: { layoutData: UserDashboardLayout } }][]
      ).map(([{ update }]) => update.layoutData.modules[0].cols);

      expect(submittedColumns).toEqual([4, 6, 8, 10]);
      expect(storedLayoutData).toEqual(submitted[submitted.length - 1]);
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

  // A write that carries a revision is asking to replace the arrangement it read
  // rather than whatever is stored now. That distinction is what stops two open
  // tabs from silently overwriting each other, and it is expressed entirely in
  // the WHERE clause of a single statement rather than in a read-then-write pair
  // that another writer could interleave with.
  describe('updateLayout carrying a concurrency token', () => {
    const revision = '2026-01-01T00:00:00.000Z';
    const supersededRevision = '2026-02-02T12:30:00.000Z';
    const userDashboardLayout: UserDashboardLayout = {
      modules: [{ cols: 4, moduleType: 'holdings', rows: 4, x: 0, y: 0 }],
      revision,
      version: 1
    };

    it('writes conditionally on the revision it read, in one statement, and never through the upsert', async () => {
      updateMany.mockResolvedValue({ count: 1 });
      findUnique.mockResolvedValue({
        layoutData: { modules: userDashboardLayout.modules, version: 1 },
        updatedAt: new Date(supersededRevision),
        userId
      });

      await userDashboardLayoutService.updateLayout({
        userDashboardLayout,
        userId
      });

      expect(updateMany).toHaveBeenCalledTimes(1);
      expect(updateMany).toHaveBeenCalledWith({
        data: {
          layoutData: { modules: userDashboardLayout.modules, version: 1 }
        },
        where: { updatedAt: new Date(revision), userId }
      });
      expect(upsert).not.toHaveBeenCalled();
      expect(prismaServiceMock.$transaction).not.toHaveBeenCalled();
    });

    // The token describes the ROW, not the arrangement. Storing it would make the
    // next read hand back a document carrying a revision from some earlier write,
    // and the stored shape would stop being exactly `{ modules, version }`.
    it('keeps the token out of storage, so the stored document stays the arrangement alone', async () => {
      updateMany.mockResolvedValue({ count: 1 });
      findUnique.mockResolvedValue({
        layoutData: { modules: userDashboardLayout.modules, version: 1 },
        updatedAt: new Date(supersededRevision),
        userId
      });

      await userDashboardLayoutService.updateLayout({
        userDashboardLayout,
        userId
      });

      const [{ data }] = updateMany.mock.calls[0] as [
        { data: { layoutData: Record<string, unknown> } }
      ];

      expect(Object.keys(data.layoutData).sort()).toEqual(layoutDocumentKeys);
      expect(data.layoutData).not.toHaveProperty('revision');
    });

    // Without the read-back the caller would be left holding the revision it just
    // superseded, and every later write it made would be refused.
    it('answers with the revision the write produced rather than the one it was given', async () => {
      updateMany.mockResolvedValue({ count: 1 });
      findUnique.mockResolvedValue({
        layoutData: { modules: userDashboardLayout.modules, version: 1 },
        updatedAt: new Date(supersededRevision),
        userId
      });

      const layout = await userDashboardLayoutService.updateLayout({
        userDashboardLayout,
        userId
      });

      expect(layout).toEqual({
        modules: [{ cols: 4, moduleType: 'holdings', rows: 4, x: 0, y: 0 }],
        revision: supersededRevision,
        version: 1
      });
      expect(Object.keys(layout).sort()).toEqual(layoutResponseKeys);
      expect(findUnique).toHaveBeenCalledTimes(1);
      expect(findUnique).toHaveBeenCalledWith({ where: { userId } });
    });

    // Nothing matched the revision, which means the row moved on. Refusing is the
    // only answer that does not destroy the arrangement the other writer saved,
    // and 409 is what tells the client it has a choice to offer rather than a
    // failure to report.
    it('refuses a write built on a revision the row has moved past, and stores nothing', async () => {
      updateMany.mockResolvedValue({ count: 0 });

      await expect(
        userDashboardLayoutService.updateLayout({
          userDashboardLayout,
          userId
        })
      ).rejects.toBeInstanceOf(ConflictException);

      expect(updateMany).toHaveBeenCalledTimes(1);
      expect(upsert).not.toHaveBeenCalled();
      expect(findUnique).not.toHaveBeenCalled();
      expect(calledDelegateMethods()).toEqual(['updateMany']);
    });

    it('names what happened when it refuses, so the client can offer the two things it can do about it', async () => {
      updateMany.mockResolvedValue({ count: 0 });

      await expect(
        userDashboardLayoutService.updateLayout({
          userDashboardLayout,
          userId
        })
      ).rejects.toThrow('The dashboard layout was changed elsewhere');
    });

    // A row deleted between the write and the read-back leaves the client without
    // a token, which correctly makes its next write unconditional: there is no
    // longer a revision for it to be conditional on.
    it('answers without a token when the row it just wrote is already gone', async () => {
      updateMany.mockResolvedValue({ count: 1 });
      findUnique.mockResolvedValue(null);

      const layout = await userDashboardLayoutService.updateLayout({
        userDashboardLayout,
        userId
      });

      expect(layout).toEqual({
        modules: [{ cols: 4, moduleType: 'holdings', rows: 4, x: 0, y: 0 }],
        version: 1
      });
      expect(layout).not.toHaveProperty('revision');
    });

    // The absence of a token is not a weaker conditional write, it is a different
    // operation: an unconditional one, which is what a first write and a
    // deliberate overwrite both are.
    it('writes unconditionally when no token is carried, leaving the upsert as the only statement', async () => {
      upsert.mockResolvedValue({
        layoutData: { modules: userDashboardLayout.modules, version: 1 },
        updatedAt: new Date(supersededRevision),
        userId
      });

      const layout = await userDashboardLayoutService.updateLayout({
        userDashboardLayout: {
          modules: userDashboardLayout.modules,
          version: 1
        },
        userId
      });

      expect(upsert).toHaveBeenCalledTimes(1);
      expect(updateMany).not.toHaveBeenCalled();
      expect(calledDelegateMethods()).toEqual(['upsert']);
      expect(layout.revision).toBe(supersededRevision);
    });

    it('propagates a conditional write failure instead of reporting the layout as persisted', async () => {
      const writeFailure = new Error(
        'could not serialize access due to concurrent update'
      );

      updateMany.mockRejectedValue(writeFailure);

      await expect(
        userDashboardLayoutService.updateLayout({
          userDashboardLayout,
          userId
        })
      ).rejects.toBe(writeFailure);

      expect(findUnique).not.toHaveBeenCalled();
      expect(upsert).not.toHaveBeenCalled();
    });
  });
});
