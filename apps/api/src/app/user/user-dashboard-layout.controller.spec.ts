import { HAS_PERMISSION_KEY } from '@ghostfolio/api/decorators/has-permission.decorator';
import { HasPermissionGuard } from '@ghostfolio/api/guards/has-permission.guard';
import { PerformanceLoggingModule } from '@ghostfolio/api/interceptors/performance-logging/performance-logging.module';
import { UpdateUserDashboardLayoutDto } from '@ghostfolio/common/dtos';
import { UserDashboardLayout } from '@ghostfolio/common/interfaces';
import type { RequestWithUser } from '@ghostfolio/common/types';

import { UnauthorizedException } from '@nestjs/common';
import { REQUEST, Reflector } from '@nestjs/core';
import { ExecutionContextHost } from '@nestjs/core/helpers/execution-context-host';
import { AuthGuard } from '@nestjs/passport';
import { Test, TestingModule } from '@nestjs/testing';

import { UserDashboardLayoutController } from './user-dashboard-layout.controller';
import { UserDashboardLayoutService } from './user-dashboard-layout.service';

describe('UserDashboardLayoutController', () => {
  const userId = '2f1a5d20-4c8e-4a0f-9f2c-5a3f0d1c9b77';

  let getLayout: jest.Mock;
  let updateLayout: jest.Mock;
  let userDashboardLayoutController: UserDashboardLayoutController;

  beforeEach(async () => {
    getLayout = jest.fn();
    updateLayout = jest.fn();

    const module: TestingModule = await Test.createTestingModule({
      // `PerformanceLoggingModule` is imported for the same reason the real user
      // module imports it: the read handler is decorated with
      // `PerformanceLoggingInterceptor`, and Nest instantiates a controller's
      // enhancers while it builds the module.
      imports: [PerformanceLoggingModule],
      controllers: [UserDashboardLayoutController],
      providers: [
        {
          provide: REQUEST,
          useValue: { user: { id: userId } } as RequestWithUser
        },
        {
          provide: UserDashboardLayoutService,
          useValue: { getLayout, updateLayout }
        }
      ]
    }).compile();

    userDashboardLayoutController = module.get(UserDashboardLayoutController);
  });

  describe('GET /api/v1/user/layout', () => {
    it('reads the layout of the authenticated user, never an identifier taken from the request payload', async () => {
      getLayout.mockResolvedValue(null);

      await userDashboardLayoutController.getUserDashboardLayout();

      expect(getLayout).toHaveBeenCalledTimes(1);
      expect(getLayout).toHaveBeenCalledWith(userId);
    });

    it('passes an absent layout through untouched, so a new user stays distinguishable from one with an empty layout', async () => {
      getLayout.mockResolvedValue(null);

      await expect(
        userDashboardLayoutController.getUserDashboardLayout()
      ).resolves.toBe(null);

      getLayout.mockResolvedValue({ modules: [], version: 1 });

      await expect(
        userDashboardLayoutController.getUserDashboardLayout()
      ).resolves.toEqual({ modules: [], version: 1 });
    });

    it('returns the stored layout', async () => {
      const userDashboardLayout: UserDashboardLayout = {
        modules: [
          { cols: 6, moduleType: 'portfolio-overview', rows: 4, x: 0, y: 0 }
        ],
        version: 1
      };

      getLayout.mockResolvedValue(userDashboardLayout);

      await expect(
        userDashboardLayoutController.getUserDashboardLayout()
      ).resolves.toEqual(userDashboardLayout);
    });
  });

  describe('PATCH /api/v1/user/layout', () => {
    const data: UpdateUserDashboardLayoutDto = {
      modules: [{ cols: 4, moduleType: 'holdings', rows: 4, x: 0, y: 0 }],
      version: 1
    };

    it('persists the submitted snapshot for the authenticated user', async () => {
      updateLayout.mockResolvedValue(data);

      await userDashboardLayoutController.updateUserDashboardLayout(data);

      expect(updateLayout).toHaveBeenCalledTimes(1);
      expect(updateLayout).toHaveBeenCalledWith({
        userDashboardLayout: data,
        userId
      });
    });

    it('returns the persisted layout', async () => {
      updateLayout.mockResolvedValue(data);

      await expect(
        userDashboardLayoutController.updateUserDashboardLayout(data)
      ).resolves.toEqual(data);
    });
  });

  describe('authorization', () => {
    it.each([
      ['getUserDashboardLayout'],
      ['updateUserDashboardLayout']
    ] as const)(
      'guards %s with AuthGuard(jwt) followed by HasPermissionGuard',
      (methodName) => {
        const guards: unknown[] =
          Reflect.getMetadata(
            '__guards__',
            UserDashboardLayoutController.prototype[methodName]
          ) ?? [];

        expect(guards).toHaveLength(2);
        expect(guards[1]).toBe(HasPermissionGuard);
      }
    );

    it.each([
      ['getUserDashboardLayout'],
      ['updateUserDashboardLayout']
    ] as const)('declares no required permission on %s', (methodName) => {
      expect(
        Reflect.getMetadata(
          HAS_PERMISSION_KEY,
          UserDashboardLayoutController.prototype[methodName]
        )
      ).toBeUndefined();
    });

    it('rejects an unauthenticated request with 401 through the passport guard', () => {
      const JwtAuthGuard = AuthGuard('jwt');
      const guard = new JwtAuthGuard();

      expect(() => guard.handleRequest(null, false, null, null)).toThrow(
        UnauthorizedException
      );
    });

    it('does not let the permission guard turn that 401 into a 403, because no permission is annotated', () => {
      const hasPermissionGuard = new HasPermissionGuard(new Reflector());
      const context = new ExecutionContextHost([{ user: undefined }]);

      jest
        .spyOn(context, 'getHandler')
        .mockReturnValue(
          UserDashboardLayoutController.prototype.getUserDashboardLayout
        );

      expect(hasPermissionGuard.canActivate(context)).toBe(true);
    });
  });
});
