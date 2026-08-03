import { PrismaService } from '@ghostfolio/api/services/prisma/prisma.service';
import { UserDashboardLayout } from '@ghostfolio/common/interfaces';

import { UserDashboardLayoutService } from './user-dashboard-layout.service';

describe('UserDashboardLayoutService', () => {
  const layoutDocumentKeys = ['modules', 'version'];
  const rowEnvelopeKeys = ['layoutData', 'updatedAt', 'userId'];
  const userId = '8b1f1b3a-6f2a-4a52-9c0b-6d5f2f7c3a11';

  let findUnique: jest.Mock;
  let prismaServiceMock: {
    $transaction: jest.Mock;
    userDashboardLayout: Record<string, jest.Mock>;
  };
  let upsert: jest.Mock;
  let userDashboardLayoutService: UserDashboardLayoutService;

  // Every delegate method the service could conceivably reach is present as a
  // spy, so `calledDelegateMethods` proves not only that the expected one ran
  // but that no other one did.
  const calledDelegateMethods = () =>
    Object.entries(prismaServiceMock.userDashboardLayout)
      .filter(([, delegateMethod]) => delegateMethod.mock.calls.length > 0)
      .map(([methodName]) => methodName);

  beforeEach(() => {
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

    // An absent layout and a stored empty layout are different states: null
    // means the user has never saved one, whereas an empty modules array means
    // a saved layout whose last module was removed. Conflating them would make
    // the catalog auto-open for a user who deliberately emptied the canvas.
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

    // A failed read is not the same state as a user who has never saved a
    // layout, and the service deliberately has no `catch` that could conflate
    // them. Were the rejection ever turned into `null`, a database outage would
    // look exactly like a brand-new user: the catalog would auto-open on an
    // empty canvas and the next debounced write would overwrite the layout that
    // is still stored. Asserting the identity of the rejection reason is what
    // makes that regression impossible to introduce quietly, because it fails
    // for a swallowed, a replaced and a wrapped error alike.
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

    // A brand-new user always starts with no row, so the very first save always
    // takes the create branch. Prisma only compiles an upsert into a single
    // atomic `INSERT … ON CONFLICT … DO UPDATE` when the create branch contains
    // no nested relation write; a `user: { connect: … }` there makes it fall
    // back to a read-then-write transaction, and two concurrent first writes
    // then collide on the primary key and answer 500. The shape is therefore
    // pinned here rather than left to the round-trip assertions above.
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

    // The canvas writes through a debounced write-behind pipeline, so a
    // rejection is the only signal that a snapshot did not reach the database.
    // Reporting the submitted document as persisted anyway would leave the
    // client believing its layout is saved when it is not.
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
