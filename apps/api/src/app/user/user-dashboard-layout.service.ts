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
   *
   * `create` sets the `userId` foreign key as a scalar rather than nesting a
   * `user: { connect: … }` relation write, because that is what lets Prisma
   * compile the upsert into a single atomic statement:
   *
   *   INSERT INTO "UserDashboardLayout" ("layoutData", "updatedAt", "userId")
   *   VALUES ($1, $2, $3)
   *   ON CONFLICT ("userId") DO UPDATE SET "layoutData" = $4, "updatedAt" = $5
   *   WHERE "userId" = $6
   *   RETURNING "userId", "layoutData", "updatedAt"
   *
   * A nested relation write forces Prisma to fall back to a read-then-write
   * interactive transaction (existence probe, user probe, insert, read back,
   * commit). Two concurrent first-ever writes for the same user then both
   * observe an absent row and both attempt the insert, so one of them fails the
   * primary key with P2002 and the request answers 500. That collision is not
   * hypothetical: a brand-new user always starts with no row, so the very first
   * save is always the create branch, and a second browser tab or a teardown
   * flush racing a pending debounced write is enough to trigger it.
   *
   * `ON CONFLICT … DO UPDATE` collapses both branches into one statement, which
   * PostgreSQL resolves atomically, so a concurrent first write converges on an
   * update instead of failing. That is safe by construction here because the
   * payload is always a complete layout snapshot rather than a delta: whichever
   * writer lands last leaves the row holding one whole submitted document. The
   * conflict target is the primary key and the `DO UPDATE` predicate matches it,
   * so `RETURNING` always yields the persisted row.
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
