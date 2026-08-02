import { PrismaService } from '@ghostfolio/api/services/prisma/prisma.service';
import { UserDashboardLayout } from '@ghostfolio/common/interfaces';

import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

@Injectable()
export class UserDashboardLayoutService {
  public constructor(private readonly prismaService: PrismaService) {}

  /**
   * `userId` comes from the authenticated request context and is bound directly
   * to the primary key, so a caller can only ever reach its own row. Only the
   * stored document is returned, so `userId` and `updatedAt` never leave here.
   *
   * A missing row and a stored SQL NULL both mean the user has never saved a
   * layout and are reported as `null`. A persisted layout whose modules array
   * is empty is a different state and is returned as it was stored.
   */
  public async getLayout(userId: string): Promise<UserDashboardLayout | null> {
    const userDashboardLayout =
      await this.prismaService.userDashboardLayout.findUnique({
        where: {
          userId
        }
      });

    if (!userDashboardLayout?.layoutData) {
      return null;
    }

    return userDashboardLayout.layoutData as unknown as UserDashboardLayout;
  }

  /**
   * `userId` is a separate argument rather than a member of the request body,
   * so the row is keyed by the authenticated identity and can never be
   * redirected by the payload. The snapshot is stored verbatim and returned
   * unwrapped, so the response carries no row envelope and no identity field.
   */
  public async updateLayout({
    userDashboardLayout,
    userId
  }: {
    userDashboardLayout: UserDashboardLayout;
    userId: string;
  }): Promise<UserDashboardLayout> {
    const { layoutData } = await this.prismaService.userDashboardLayout.upsert({
      create: {
        layoutData: userDashboardLayout as unknown as Prisma.JsonObject,
        user: {
          connect: {
            id: userId
          }
        }
      },
      update: {
        layoutData: userDashboardLayout as unknown as Prisma.JsonObject
      },
      where: {
        userId
      }
    });

    return layoutData as unknown as UserDashboardLayout;
  }
}
