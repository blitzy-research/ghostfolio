import { ActivitiesService } from '@ghostfolio/api/app/activities/activities.service';
import { SubscriptionService } from '@ghostfolio/api/app/subscription/subscription.service';
import { ConfigurationService } from '@ghostfolio/api/services/configuration/configuration.service';
import { I18nService } from '@ghostfolio/api/services/i18n/i18n.service';
import { PrismaService } from '@ghostfolio/api/services/prisma/prisma.service';
import { PropertyService } from '@ghostfolio/api/services/property/property.service';
import { TagService } from '@ghostfolio/api/services/tag/tag.service';

import { ForbiddenException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Test, TestingModule } from '@nestjs/testing';

import { UserService } from './user.service';

/**
 * `UserService.deleteUser` is the account-closure path, and the only thing this
 * spec is concerned with is that the dashboard layout row is part of it.
 *
 * The row is protected by an `ON DELETE CASCADE` foreign key, so the explicit
 * delegate call is redundant *at the database level* and therefore invisible to
 * every other kind of test: remove it and the row still disappears, against
 * PostgreSQL. It is nonetheless the shape every sibling per-user model follows
 * in this method, and it is what keeps closure working against a schema whose
 * cascade was ever weakened or a provider that does not enforce one. Two
 * properties consequently need pinning, and neither is expressible in the type
 * system:
 *
 * 1. The delegate is called, keyed by the user being deleted and nothing else.
 * 2. Its failure is tolerated. Every cleanup in this method sits in a bare
 *    `try`/`catch`, precisely because a user who never opened the dashboard has
 *    no row to delete and Prisma reports that absence by rejecting. A cleanup
 *    that escaped would abort closure and leave the account half-deleted.
 *
 * The service is built through `@nestjs/testing` rather than by hand so the
 * constructor's dependency list stays honest: a collaborator added to it that
 * this module does not provide fails here rather than at runtime.
 */
describe('UserService', () => {
  const userId = 'c0a8012e-4f7b-4d1a-9f3e-2b6d8c5a1e44';

  let deleteActivities: jest.Mock;
  let isUserSignupEnabled: jest.Mock;
  let prismaServiceMock: {
    access: { deleteMany: jest.Mock };
    account: { deleteMany: jest.Mock };
    analytics: { delete: jest.Mock };
    settings: { delete: jest.Mock };
    user: {
      create: jest.Mock;
      delete: jest.Mock;
      findMany: jest.Mock;
      update: jest.Mock;
    };
    userDashboardLayout: { delete: jest.Mock };
  };
  let userService: UserService;

  beforeEach(async () => {
    deleteActivities = jest.fn().mockResolvedValue(undefined);
    isUserSignupEnabled = jest.fn().mockResolvedValue(true);

    prismaServiceMock = {
      access: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
      account: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
      analytics: { delete: jest.fn().mockResolvedValue({}) },
      settings: { delete: jest.fn().mockResolvedValue({}) },
      user: {
        create: jest.fn().mockResolvedValue({ id: userId }),
        delete: jest.fn().mockResolvedValue({ id: userId }),
        findMany: jest.fn().mockResolvedValue([]),
        update: jest.fn().mockResolvedValue({ id: userId })
      },
      userDashboardLayout: { delete: jest.fn().mockResolvedValue({ userId }) }
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UserService,
        { provide: ActivitiesService, useValue: { deleteActivities } },
        {
          provide: ConfigurationService,
          useValue: {
            // Only the salt is answered. Every other key stays undefined so the
            // subscription feature remains off, which is what the closure tests
            // below already depend on.
            get: (aKey: string) =>
              aKey === 'ACCESS_TOKEN_SALT' ? 'ACCESS_TOKEN_SALT' : undefined
          }
        },
        { provide: EventEmitter2, useValue: { emit: jest.fn() } },
        {
          provide: I18nService,
          // Reached only on the creating path, where the default account this
          // service opens alongside the user takes its name from a translation.
          useValue: { getTranslation: () => 'My Account' }
        },
        { provide: PrismaService, useValue: prismaServiceMock },
        { provide: PropertyService, useValue: { isUserSignupEnabled } },
        { provide: SubscriptionService, useValue: {} },
        { provide: TagService, useValue: {} }
      ]
    }).compile();

    userService = module.get(UserService);
  });

  /**
   * Account creation is gated on the deployment still admitting accounts, and the
   * gate is asserted at the point of creation.
   *
   * It is asserted at both existing call sites too, so nothing observable changes
   * today - which is exactly what makes it worth pinning here rather than through
   * either of those. What is being protected is the next caller: a check that lives
   * only in the callers is one a new caller can omit, and the omission would be
   * silent, because creating a row is not an operation that fails on its own.
   */
  describe('createUser', () => {
    it('creates the account while the deployment admits them', async () => {
      await userService.createUser();

      expect(isUserSignupEnabled).toHaveBeenCalledTimes(1);
      expect(prismaServiceMock.user.create).toHaveBeenCalledTimes(1);
    });

    it('refuses to create one once the deployment has stopped admitting them', async () => {
      isUserSignupEnabled.mockResolvedValue(false);

      await expect(userService.createUser()).rejects.toThrow(
        ForbiddenException
      );

      // The assertion that matters: refused BEFORE the row is written, so a caller
      // that forgot to check cannot leave an account behind.
      expect(prismaServiceMock.user.create).not.toHaveBeenCalled();
    });

    it('refuses an externally supplied identity on the same ground', async () => {
      isUserSignupEnabled.mockResolvedValue(false);

      await expect(
        userService.createUser({
          data: { provider: 'GOOGLE', thirdPartyId: 'THIRD_PARTY_ID' }
        })
      ).rejects.toThrow(ForbiddenException);

      expect(prismaServiceMock.user.create).not.toHaveBeenCalled();
    });
  });

  describe('deleteUser', () => {
    it('deletes the dashboard layout row of the user being closed', async () => {
      await userService.deleteUser({ id: userId });

      // Keyed on the user and on nothing else. `userId` is the primary key of the
      // layout table, so a wider filter here would be a filter that could match
      // somebody else's row.
      expect(
        prismaServiceMock.userDashboardLayout.delete
      ).toHaveBeenCalledTimes(1);
      expect(prismaServiceMock.userDashboardLayout.delete).toHaveBeenCalledWith(
        {
          where: { userId }
        }
      );
    });

    it('deletes the layout row before the user itself', async () => {
      const order: string[] = [];

      prismaServiceMock.userDashboardLayout.delete.mockImplementation(() => {
        order.push('layout');

        return Promise.resolve({ userId });
      });
      prismaServiceMock.user.delete.mockImplementation(() => {
        order.push('user');

        return Promise.resolve({ id: userId });
      });

      await userService.deleteUser({ id: userId });

      // Order is the contract rather than an incidental detail: the layout row
      // references the user, so deleting the user first would either fail or -
      // through the cascade - make the explicit cleanup a call against a row that
      // no longer exists.
      expect(order).toEqual(['layout', 'user']);
    });

    it('cleans up every per-user model alongside the layout', async () => {
      await userService.deleteUser({ id: userId });

      // The layout is one member of a set, and it has to stay one: a future
      // cleanup added ahead of it must not displace it, and this assertion is
      // what notices if it does.
      expect(prismaServiceMock.access.deleteMany).toHaveBeenCalledWith({
        where: { OR: [{ granteeUserId: userId }, { userId }] }
      });
      expect(prismaServiceMock.account.deleteMany).toHaveBeenCalledWith({
        where: { userId }
      });
      expect(prismaServiceMock.analytics.delete).toHaveBeenCalledWith({
        where: { userId }
      });
      expect(deleteActivities).toHaveBeenCalledWith({ userId });
      expect(prismaServiceMock.settings.delete).toHaveBeenCalledWith({
        where: { userId }
      });
    });

    it('closes the account of a user who never saved a layout', async () => {
      // What Prisma actually does for an absent row: `delete` rejects rather than
      // resolving with nothing. A brand-new user who never opened the dashboard
      // has no row at all, so this is the ordinary case rather than an edge one.
      prismaServiceMock.userDashboardLayout.delete.mockRejectedValue(
        new Error(
          'An operation failed because it depends on one or more records that were required but not found.'
        )
      );

      await expect(userService.deleteUser({ id: userId })).resolves.toEqual({
        id: userId
      });

      expect(prismaServiceMock.user.delete).toHaveBeenCalledTimes(1);
      expect(prismaServiceMock.user.delete).toHaveBeenCalledWith({
        where: { id: userId }
      });
    });

    it('returns the deleted user and passes the filter through untouched', async () => {
      const where = { id: userId };

      const deleted = await userService.deleteUser(where);

      // The final delete receives the caller's own filter rather than one rebuilt
      // from `id`, which is what lets a caller close an account by any unique
      // field the schema offers.
      expect(prismaServiceMock.user.delete).toHaveBeenCalledWith({ where });
      expect(deleted).toEqual({ id: userId });
    });
  });
});
