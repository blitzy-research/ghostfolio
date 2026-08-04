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
   * `userId` is a separate argument rather than a member of the request body, so
   * the row is keyed by the authenticated identity and can never be redirected by
   * the payload. Only the stored document is returned, so the response carries no
   * row envelope and no identity field.
   *
   * `create` sets `userId` as a scalar instead of nesting a `user: { connect: … }`
   * relation write, because only the scalar form lets Prisma compile the upsert
   * into a single atomic `INSERT … ON CONFLICT … DO UPDATE`. A nested relation
   * write falls back to a read-then-write transaction, where two concurrent
   * first-ever writes for one user both see an absent row and collide on the
   * primary key. Converging on an update instead is safe here only because the
   * payload is always a complete layout snapshot rather than a delta: whichever
   * writer lands last leaves the row holding one whole submitted document.
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
        userId
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
