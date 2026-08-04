import { PrismaService } from '@ghostfolio/api/services/prisma/prisma.service';
import {
  DashboardModuleLayoutItem,
  UserDashboardLayout
} from '@ghostfolio/common/interfaces';

import {
  Injectable,
  InternalServerErrorException,
  Logger
} from '@nestjs/common';
import { Prisma } from '@prisma/client';

/**
 * The only layout document shape this deployment can interpret.
 *
 * The discriminator exists so the persisted shape can change without a schema
 * migration, which only helps if a reader that meets an unfamiliar one says so
 * instead of guessing. A document carrying anything else was written by a newer
 * build than this one and is refused rather than partially read — see
 * {@link UserDashboardLayoutService.parseLayout}.
 */
const SUPPORTED_LAYOUT_VERSION = 1;

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
   *
   * The stored value is *parsed* rather than asserted. `layoutData` is a JSONB
   * column, so its type at this boundary is whatever is in the row, and the
   * previous `as unknown as UserDashboardLayout` was a claim about it rather than
   * a check of it. A document that does not hold to the shape - written by a
   * newer build, edited by hand, or damaged - would then reach the client and
   * throw while it was being iterated, inside the success handler of the read.
   * That is the one place a failure must not surface, because the canvas has
   * already been told the read succeeded: it never enters its own error state,
   * offers no retry, and shows a blank canvas that the next module added would
   * overwrite the stored arrangement from.
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

    return this.parseLayout({
      layoutData: userDashboardLayout.layoutData,
      userId
    });
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

  /**
   * Whether one entry of a stored modules array can be interpreted at all.
   *
   * Structure only, and deliberately nothing else. An unrecognised discriminator
   * is kept, because the client registry is the only thing that can judge whether
   * a module still exists; the dimensions are kept exactly as stored, because the
   * grid engine is the only thing that can judge whether they are usable and the
   * canvas normalizes them against the module's own declared minimum as it
   * hydrates. What is rejected here is only what makes an entry unreadable: a
   * non-object, a discriminator that is not a usable string, or a coordinate that
   * is not an integer.
   */
  private isLayoutItem(aValue: unknown): aValue is DashboardModuleLayoutItem {
    if (
      typeof aValue !== 'object' ||
      aValue === null ||
      Array.isArray(aValue)
    ) {
      return false;
    }

    const { cols, moduleType, rows, x, y } = aValue as Record<string, unknown>;

    return (
      typeof moduleType === 'string' &&
      moduleType.length > 0 &&
      Number.isInteger(cols) &&
      Number.isInteger(rows) &&
      Number.isInteger(x) &&
      Number.isInteger(y)
    );
  }

  /**
   * Turns a stored JSONB value into a layout document, or refuses it.
   *
   * The two outcomes are chosen for what they cost the user, not for symmetry:
   *
   * - **An unreadable envelope, or a version this build does not know**, is
   *   refused with a 500. The client maps a failed read to its own error state,
   *   which offers a retry and - crucially - permits no write at all, so the
   *   stored document survives for an operator to look at. Reporting it as an
   *   absent layout instead would open the module catalog as though this were a
   *   first visit, and the first module added afterwards would be written out as
   *   the user's entire arrangement, destroying the very document that could not
   *   be read.
   * - **An individual unreadable entry** is dropped, because there is nothing
   *   else to be done with it and refusing the whole document over one bad row
   *   would cost the user every other module they had placed.
   *
   * Only the two members the contract defines are carried over, so an extra
   * property that found its way into the row cannot reach the response.
   */
  private parseLayout({
    layoutData,
    userId
  }: {
    layoutData: Prisma.JsonValue;
    userId: string;
  }): UserDashboardLayout {
    if (
      typeof layoutData !== 'object' ||
      layoutData === null ||
      Array.isArray(layoutData)
    ) {
      Logger.error(
        `The stored dashboard layout of user '${userId}' is not a layout document`,
        'UserDashboardLayoutService'
      );

      throw new InternalServerErrorException(
        'The stored dashboard layout could not be read'
      );
    }

    const { modules, version } = layoutData as Record<string, unknown>;

    if (version !== undefined && version !== SUPPORTED_LAYOUT_VERSION) {
      Logger.error(
        // Serialised rather than coerced: the value is `unknown` because it comes
        // straight out of a JSON column, so coercing it would render an object as
        // '[object Object]' and hide the very thing the operator needs to see.
        `The stored dashboard layout of user '${userId}' declares unsupported version ${JSON.stringify(
          version
        )}`,
        'UserDashboardLayoutService'
      );

      throw new InternalServerErrorException(
        'The stored dashboard layout could not be read'
      );
    }

    if (!Array.isArray(modules)) {
      Logger.error(
        `The stored dashboard layout of user '${userId}' holds no modules array`,
        'UserDashboardLayoutService'
      );

      throw new InternalServerErrorException(
        'The stored dashboard layout could not be read'
      );
    }

    const layoutItems = modules.filter((module) => {
      return this.isLayoutItem(module);
    });

    if (layoutItems.length !== modules.length) {
      Logger.warn(
        `Dropped ${
          modules.length - layoutItems.length
        } unreadable module(s) from the stored dashboard layout of user '${userId}'`,
        'UserDashboardLayoutService'
      );
    }

    // Rebuilt from its own members rather than spread, so the absence of a
    // version discriminator stays an absence: a document written before the
    // discriminator existed must not gain one on the way out, or a reader would
    // conclude this build had interpreted a version it never saw.
    return version === undefined
      ? { modules: layoutItems }
      : { modules: layoutItems, version: SUPPORTED_LAYOUT_VERSION };
  }
}
