import { PrismaService } from '@ghostfolio/api/services/prisma/prisma.service';
import { UserDashboardLayout } from '@ghostfolio/common/interfaces';

import { Test, TestingModule } from '@nestjs/testing';

import { UserDashboardLayoutService } from './user-dashboard-layout.service';

describe('UserDashboardLayoutService', () => {
  const userId = '8b1f1b3a-6f2a-4a52-9c0b-6d5f2f7c3a11';

  let findUnique: jest.Mock;
  let upsert: jest.Mock;
  let userDashboardLayoutService: UserDashboardLayoutService;

  beforeEach(async () => {
    findUnique = jest.fn();
    upsert = jest.fn();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UserDashboardLayoutService,
        {
          provide: PrismaService,
          useValue: {
            userDashboardLayout: {
              findUnique,
              upsert
            }
          }
        }
      ]
    }).compile();

    userDashboardLayoutService = module.get(UserDashboardLayoutService);
  });

  describe('getLayout', () => {
    it('reads the row through the user primary key', async () => {
      findUnique.mockResolvedValue(null);

      await userDashboardLayoutService.getLayout(userId);

      expect(findUnique).toHaveBeenCalledTimes(1);
      expect(findUnique).toHaveBeenCalledWith({ where: { userId } });
    });

    it('reports an absent row as null', async () => {
      findUnique.mockResolvedValue(null);

      await expect(userDashboardLayoutService.getLayout(userId)).resolves.toBe(
        null
      );
    });

    it('reports a row whose layout is SQL NULL as null', async () => {
      findUnique.mockResolvedValue({ layoutData: null, userId });

      await expect(userDashboardLayoutService.getLayout(userId)).resolves.toBe(
        null
      );
    });

    it('returns a stored empty layout as it was stored, keeping it distinct from an absent one', async () => {
      const layoutData = { modules: [], version: 1 };

      findUnique.mockResolvedValue({ layoutData, userId });

      await expect(
        userDashboardLayoutService.getLayout(userId)
      ).resolves.toEqual(layoutData);
    });

    it('returns the persisted layout document without the row envelope', async () => {
      const layoutData = {
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

      expect(layout).toEqual(layoutData);
      expect(layout).not.toHaveProperty('updatedAt');
      expect(layout).not.toHaveProperty('userId');
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
        create: {
          layoutData: userDashboardLayout,
          user: { connect: { id: userId } }
        },
        update: { layoutData: userDashboardLayout },
        where: { userId }
      });
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

      expect(layout).toEqual(userDashboardLayout);
      expect(layout).not.toHaveProperty('updatedAt');
      expect(layout).not.toHaveProperty('userId');
    });
  });
});
