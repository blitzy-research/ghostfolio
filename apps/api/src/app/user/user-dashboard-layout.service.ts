import { PrismaService } from '@ghostfolio/api/services/prisma/prisma.service';
import { MAX_USER_DASHBOARD_LAYOUT_ITEMS } from '@ghostfolio/common/config';
import {
  DashboardModuleLayoutItem,
  UserDashboardLayout
} from '@ghostfolio/common/interfaces';

import { ConflictException, Injectable, Logger } from '@nestjs/common';
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

/**
 * The stable event identifier every refused read is reported under, and the
 * reason categories that distinguish them.
 *
 * Fixed strings, deliberately. A log line is readable by everyone who can read
 * the log and outlives the request that produced it, so it carries what an
 * operator needs to act — which of the three ways a document can be unreadable
 * this was — and nothing that describes the viewer or what they had stored.
 * Neither the account the row belongs to nor any value out of the row appears in
 * any of them, which is what makes the identifier searchable without being
 * disclosive.
 */
const LAYOUT_UNREADABLE_EVENT = 'GF-USER-DASHBOARD-LAYOUT-UNREADABLE';

const LAYOUT_UNREADABLE_REASONS = {
  invalidEnvelope: 'INVALID_ENVELOPE',
  missingModulesArray: 'MISSING_MODULES_ARRAY',
  unsupportedVersion: 'UNSUPPORTED_VERSION'
} as const;

/**
 * The stable event identifier a partially readable document is reported under.
 *
 * The count travels with it because a count is a measure rather than a value: it
 * tells an operator how much of the document could not be interpreted without
 * telling them anything that was in it.
 */
const LAYOUT_ITEMS_DROPPED_EVENT = 'GF-USER-DASHBOARD-LAYOUT-ITEMS-DROPPED';

/**
 * The message a refused read answers with.
 *
 * Stated once and shared by all three refusal reasons, because the reason
 * categories are for the operator's log and not for the caller: which of the
 * three ways a stored document is unreadable is not something the caller can act
 * on differently, and spelling them out on the wire would describe the contents
 * of a viewer's row to anyone who could provoke the failure.
 */
const LAYOUT_UNREADABLE_MESSAGE =
  'The stored dashboard layout could not be read';

/**
 * The message a refused write answers with.
 *
 * Actionable, unlike the read failure: the caller holds an arrangement built on
 * a revision the row has moved past, and the two things it can do about that -
 * take the newer document, or overwrite it deliberately - are both available to
 * it.
 */
const LAYOUT_STALE_REVISION_MESSAGE =
  'The dashboard layout was changed elsewhere';

@Injectable()
export class UserDashboardLayoutService {
  public constructor(private readonly prismaService: PrismaService) {}

  /**
   * Discards a user's stored arrangement.
   *
   * This exists because a document this build cannot interpret leaves the canvas
   * with nothing it is allowed to do: it refuses every write while a layout it
   * never read is stored, precisely so that opening a damaged arrangement cannot
   * destroy it — which without a discard makes the account unrecoverable from the
   * UI. A delete is the one operation that resolves that safely, because it is
   * not a layout WRITE: it stores no arrangement, so it cannot invent one, and it
   * leaves the next read reporting a genuine absence rather than a document some
   * error state guessed at.
   *
   * `deleteMany` rather than `delete`, so the absence of a row is success rather
   * than a `P2025`. Discarding an arrangement that was never saved is exactly as
   * meaningful as discarding one that was, and both leave the same state behind.
   */
  public async deleteLayout(userId: string): Promise<void> {
    await this.prismaService.userDashboardLayout.deleteMany({
      where: {
        userId
      }
    });
  }

  /**
   * `userId` comes from the authenticated request context and is bound directly
   * to the primary key, so a caller can only ever reach its own row. Only the
   * stored document is returned, so `userId` and `updatedAt` never leave here.
   *
   * A missing row and a stored SQL NULL both mean the user has never saved a
   * layout and are reported as `null`. A persisted layout whose modules array
   * is empty is a different state and is returned as it was stored.
   *
   * The absence test is deliberately NULLISH rather than falsy, and the
   * difference is a correctness one. `layoutData` is JSONB, so `false`, `0` and
   * `""` are all values it can legitimately hold - and every one of them is
   * falsy. Treating them as an absent layout would report the most damaging
   * answer available: the client reads "absent" as a first visit, opens the module
   * catalog, and writes the first module added out as the viewer's entire
   * arrangement - destroying the very document that could not be read. Only a
   * genuinely absent row and a genuine SQL NULL answer `null`; every other stored
   * value is handed to {@link UserDashboardLayoutService.parseLayout}, which
   * refuses it as an unreadable envelope and leaves the row intact.
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

    const layoutData = userDashboardLayout?.layoutData;

    if (layoutData === null || layoutData === undefined) {
      return null;
    }

    // The concurrency token travels with the document rather than being derived
    // by the caller, because it is the row's own `updatedAt` and nothing else can
    // observe that. It is attached AFTER parsing, so a refused document answers
    // with no token at all - there is nothing a caller could correctly do with a
    // revision for a document it was not given.
    return this.toLayoutResponse(
      this.parseLayout(layoutData),
      userDashboardLayout.updatedAt
    );
  }

  /**
   * `userId` is a separate argument rather than a member of the request body, so
   * the row is keyed by the authenticated identity and can never be redirected by
   * the payload. Only the stored document is returned, so the response carries no
   * row envelope and no identity field.
   *
   * What is returned is the stored value put through the SAME projection the read
   * uses, rather than asserted to be a layout with a cast. The two answers have to
   * agree, and previously they could not: the read rebuilds the document entry by
   * entry and drops anything it cannot interpret, so a row holding an entry the
   * projection refuses answered a write with that entry present and every later
   * read with it gone - one row, two different documents, and the write response
   * was the one that did not hold to the declared type. Parsing here makes the
   * response provably the five-field-per-item projection its return type claims,
   * whatever is in the column.
   *
   * That the write can no longer produce such a row - each submitted entry must
   * now be an object before it is measured against the item bounds - is what makes
   * this a guarantee rather than a repair. It is kept because the guarantee should
   * not rest on the request pipe alone: a row written by an older build, edited by
   * hand or reached by any future path still leaves through one projection. The
   * refusal path it inherits is therefore unreachable for a write this build
   * admits, and remains the right answer if it is ever reached - handing a client
   * a document it will iterate and throw inside its own success handler is worse
   * than telling it the write could not be confirmed, and a whole-document write
   * is idempotent, so the retry that follows costs nothing.
   *
   * `create` sets `userId` as a scalar instead of nesting a `user: { connect: … }`
   * relation write, because only the scalar form lets Prisma compile the upsert
   * into a single atomic `INSERT … ON CONFLICT … DO UPDATE`. A nested relation
   * write falls back to a read-then-write transaction, where two concurrent
   * first-ever writes for one user both see an absent row and collide on the
   * primary key. Converging on an update instead is safe here only because the
   * payload is always a complete layout snapshot rather than a delta: whichever
   * writer lands last leaves the row holding one whole submitted document.
   *
   * ## Where write ordering comes from
   *
   * Two mechanisms, covering two different races, and both are needed.
   *
   * **Within one client**, ordering is established one layer up. A viewer's
   * browser holds exactly one canvas, and that canvas's layout service dispatches
   * its snapshots through a SERIALISED queue - each request begins only once the
   * previous one has settled, and a snapshot the queue finds already superseded is
   * skipped rather than sent. One writer, one request at a time, so the last
   * document that client reported is the last one it sends.
   *
   * **Between clients**, that guarantee says nothing, and the whole-document
   * payload makes the gap consequential: two tabs signed in as the same person
   * each hold their own snapshot, so a tab that moves one module submits every
   * other module at the position IT last read - silently restoring whatever the
   * other tab had already persisted. Hence the conditional write below. The client
   * echoes back the revision it read, this method commits only while the row still
   * carries it, and a submission built on a superseded revision is refused with a
   * 409 so the client can offer its viewer the newer document or an explicit
   * overwrite. Nothing is guessed at and nothing is merged: a layout is a whole
   * document, and choosing between two of them is the viewer's to make.
   *
   * The comparison is expressed as the WHERE clause of a single `updateMany`
   * rather than as a read followed by a write, which is what makes it atomic: the
   * database matches the revision and applies the document in one statement, so
   * two conditional writes racing on one row cannot both find it current.
   * `count === 0` is therefore the whole test, and it covers both ways a
   * conditional write can fail to apply - a row that moved on, and a row that is
   * no longer there.
   *
   * A submission carrying NO revision is unconditional, and that is a contract
   * rather than a loophole. It is the shape of a first-ever save, where there is
   * no row to have a revision; and of a deliberate overwrite, where the viewer has
   * been told their arrangement changed elsewhere and chose to keep their own.
   * Converging on an update rather than colliding is safe there only because the
   * payload is always a complete snapshot: whichever writer lands last leaves the
   * row holding one whole submitted document.
   *
   * `create` sets `userId` as a scalar instead of nesting a `user: { connect: … }`
   * relation write, because only the scalar form lets Prisma compile the upsert
   * into a single atomic `INSERT … ON CONFLICT … DO UPDATE`. A nested relation
   * write falls back to a read-then-write transaction, where two concurrent
   * first-ever writes for one user both see an absent row and collide on the
   * primary key.
   */
  public async updateLayout({
    userDashboardLayout,
    userId
  }: {
    userDashboardLayout: UserDashboardLayout;
    userId: string;
  }): Promise<UserDashboardLayout> {
    // The token never reaches storage: it describes the row rather than the
    // arrangement, and the stored shape is exactly `{ modules, version }`.
    const { revision, ...layoutDocument } = userDashboardLayout;

    if (revision === undefined) {
      const { updatedAt } = await this.prismaService.userDashboardLayout.upsert(
        {
          create: {
            layoutData: layoutDocument as unknown as Prisma.JsonObject,
            userId
          },
          update: {
            layoutData: layoutDocument as unknown as Prisma.JsonObject
          },
          where: {
            userId
          }
        }
      );

      return this.toLayoutResponse(
        this.parseLayout(layoutDocument as unknown as Prisma.JsonValue),
        updatedAt
      );
    }

    const { count } = await this.prismaService.userDashboardLayout.updateMany({
      data: {
        layoutData: layoutDocument as unknown as Prisma.JsonObject
      },
      where: {
        updatedAt: new Date(revision),
        userId
      }
    });

    if (count === 0) {
      throw new ConflictException(LAYOUT_STALE_REVISION_MESSAGE);
    }

    // Read back for the revision the write produced, so the client's next
    // conditional write is built on the row as it now stands. `updateMany` reports
    // only how many rows it touched, and a client left holding the revision it
    // sent would have every subsequent write refused.
    const userDashboardLayoutRow =
      await this.prismaService.userDashboardLayout.findUnique({
        where: {
          userId
        }
      });

    return this.toLayoutResponse(
      this.parseLayout(layoutDocument as unknown as Prisma.JsonValue),
      userDashboardLayoutRow?.updatedAt
    );
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
   * The single projection BOTH public methods answer through, which is what makes
   * a read and a write of one row return the same document rather than merely
   * documents of the same type. The reasoning below is written from the read,
   * because that is where an unreadable row is actually met; a write reaches these
   * outcomes only for a row it did not itself produce, since a submitted entry has
   * to be an object carrying the five bounded fields before the pipe admits it.
   *
   * The two outcomes are chosen for what they cost the user, not for symmetry:
   *
   * - **An unreadable envelope, or a version this build does not know**, is
   *   refused. The client maps a failed read to its own error state, which
   *   permits no write at all, so the stored document survives for an operator to
   *   look at. Reporting it as an absent layout instead would open the module
   *   catalog as though this were a first visit, and the first module added
   *   afterwards would be written out as the user's entire arrangement, destroying
   *   the very document that could not be read.
   * - **An individual unreadable entry** is dropped, because there is nothing
   *   else to be done with it and refusing the whole document over one bad row
   *   would cost the user every other module they had placed.
   *
   * ## Why the refusal is a 409 and not a 500
   *
   * A 500 says the server failed and invites the caller to try again. Nothing here
   * failed and no retry can succeed: the row holds a document this build is not
   * able to interpret, and it will hold the same one on the next request. Answering
   * with a retryable status left the canvas offering a retry that provably could
   * not work - a viewer whose stored `version` had moved ahead of their client was
   * locked out of their own dashboard with nothing to press but "Try again".
   *
   * 409 states the actual situation: the stored resource conflicts with what this
   * build can represent. It is distinguishable from a transient failure, which is
   * what lets the client say what is wrong and offer the one action that resolves
   * it - discarding the arrangement and starting again - instead of a retry loop.
   *
   * Only the members the contract defines are carried over - the two on the
   * envelope and the five on each item - so an extra property that found its way
   * into the row cannot reach the response at either level.
   *
   * Each outcome is reported as a fixed event identifier and a reason category,
   * and that is the whole of what is emitted. The account the row belongs to is
   * deliberately absent — it is the authenticated caller, so the request log
   * already establishes who asked, and repeating it here would put an account
   * identifier into every operator's view of this failure. The offending value is
   * absent for the same reason and more so: it comes straight out of a JSON column
   * the viewer's own client wrote, so serialising it into a log would copy stored
   * viewer data somewhere it is neither protected nor expiring. The reason
   * category is what an operator acts on, and it survives without either.
   */
  private parseLayout(layoutData: Prisma.JsonValue): UserDashboardLayout {
    if (
      typeof layoutData !== 'object' ||
      layoutData === null ||
      Array.isArray(layoutData)
    ) {
      Logger.error(
        `${LAYOUT_UNREADABLE_EVENT} (reason ${LAYOUT_UNREADABLE_REASONS.invalidEnvelope})`,
        'UserDashboardLayoutService'
      );

      throw new ConflictException(LAYOUT_UNREADABLE_MESSAGE);
    }

    const { modules, version } = layoutData as Record<string, unknown>;

    if (version !== undefined && version !== SUPPORTED_LAYOUT_VERSION) {
      Logger.error(
        `${LAYOUT_UNREADABLE_EVENT} (reason ${LAYOUT_UNREADABLE_REASONS.unsupportedVersion})`,
        'UserDashboardLayoutService'
      );

      throw new ConflictException(LAYOUT_UNREADABLE_MESSAGE);
    }

    if (!Array.isArray(modules)) {
      Logger.error(
        `${LAYOUT_UNREADABLE_EVENT} (reason ${LAYOUT_UNREADABLE_REASONS.missingModulesArray})`,
        'UserDashboardLayoutService'
      );

      throw new ConflictException(LAYOUT_UNREADABLE_MESSAGE);
    }

    // Rebuilt entry by entry rather than filtered, for exactly the reason the
    // envelope below is rebuilt rather than spread. A filter hands back the very
    // objects that came out of the JSONB column, so any surplus member on an
    // item - written by a newer build, inserted by hand, or left behind by an
    // earlier shape - would travel through the response untouched. The contract is
    // five fields per item, and returning a fresh object holding exactly those
    // five is what makes that true of the response and not merely of the type.
    //
    // Bounded by the same ceiling the write DTO applies, and stopping AT it
    // rather than trimming afterwards. The write path is not the only way a
    // document reaches this column - direct database access, a migration, or an
    // older build can all put one there - so a read with no ceiling of its own
    // will serve whatever it finds: a document holding twenty thousand entries
    // came back in full, over a megabyte of it, for a canvas that has twenty-one
    // module types to place. Refusing the document outright would be the wrong
    // trade, because it would cost the user every module they had placed over a
    // condition they did not create; answering with as much of it as a layout is
    // allowed to hold leaves the canvas usable and the row intact for an operator
    // to look at. Stopping early is what keeps the cost bounded too - building the
    // full array and then slicing it would still allocate every entry first.
    const layoutItems = modules.reduce<DashboardModuleLayoutItem[]>(
      (items, module) => {
        if (
          items.length < MAX_USER_DASHBOARD_LAYOUT_ITEMS &&
          this.isLayoutItem(module)
        ) {
          const { cols, moduleType, rows, x, y } = module;

          items.push({ cols, moduleType, rows, x, y });
        }

        return items;
      },
      []
    );

    // One event for both reasons an entry can fail to reach the response - it
    // could not be interpreted, or the layout was already full - because the
    // count is what an operator acts on and the identifier is what they search
    // for, and neither changes with the reason. Reporting a second identifier
    // here would break a log matcher for no gain.
    if (layoutItems.length !== modules.length) {
      Logger.warn(
        `${LAYOUT_ITEMS_DROPPED_EVENT} (count ${
          modules.length - layoutItems.length
        })`,
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

  /**
   * Builds the response for a write: the document as it was committed, plus the
   * revision the row now carries.
   *
   * The revision is what makes the client's NEXT conditional write possible, and a
   * client left holding the token it sent would have every subsequent write
   * refused. It is optional here only because a row can in principle be deleted
   * between the write and the read-back that observes its `updatedAt` - in which
   * case the client is left without a token and its next write is unconditional,
   * which is the correct outcome for an arrangement that no longer has a row.
   *
   * The document reaching this method has ALREADY been through `parseLayout`,
   * whichever verb is calling. That is deliberate rather than defensive
   * duplication: a write that echoed its own submitted object would answer with
   * the members and the key order it was handed, while a read of that same row
   * answers with the projection - one row, two documents, and the write's answer
   * the one that did not hold to the declared type. Both verbs therefore project
   * first and attach the token here, so this method only ever adds the revision to
   * a document that is already exactly `{ modules, version? }`.
   */
  private toLayoutResponse(
    layout: UserDashboardLayout,
    updatedAt: Date | undefined
  ): UserDashboardLayout {
    return updatedAt
      ? { ...layout, revision: updatedAt.toISOString() }
      : layout;
  }
}
