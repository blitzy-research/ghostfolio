import { TagService } from '@ghostfolio/api/services/tag/tag.service';
import { permissions } from '@ghostfolio/common/permissions';

import { HttpException } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
import { Test, TestingModule } from '@nestjs/testing';
import { StatusCodes } from 'http-status-codes';

import { TagsController } from './tags.controller';

/**
 * What a tag write answers when the name is already taken.
 *
 * A tag is unique per owner by database constraint (`@@unique([name, userId])`), so a
 * repeated name is refused by the storage layer, not by any check in this controller.
 * That refusal arrives as Prisma's `P2002`, and while it was unmapped it left the
 * handler by the ordinary exception route and became a `500`: an answer that says the
 * server broke, for a request that was understood perfectly well and merely conflicted
 * with something that already existed. The interface downstream could do nothing with
 * it but apologise generically, discard the name that had been typed, and leave a list
 * that looked exactly as it had before - indistinguishable, for a create, from success.
 *
 * The status is the whole of the fix, so the status is what is asserted. `409` rather
 * than `400`: the request is well formed and only the current contents of the store
 * make it wrong, which is also what makes it worth retrying with a different name.
 *
 * Handlers are called directly rather than over HTTP. Nothing here concerns the request
 * pipeline - the guards are unchanged and the layout controller's suite already covers
 * that ground - and the permission branches above the write are reached by varying the
 * injected viewer, which is where they read from.
 */
describe('TagsController', () => {
  const tag = { id: 'TAG_ID', name: 'Emergency Fund', userId: 'USER_ID' };
  const userId = 'USER_ID';

  /** The rejection Prisma raises for a violated unique constraint. */
  const uniquenessConflict = () => {
    return Object.assign(
      new Error(
        'Unique constraint failed on the fields: (`name`,`userId`)'
      ) as Error & { code: string; meta: { target: string[] } },
      { code: 'P2002', meta: { target: ['name', 'userId'] } }
    );
  };

  let createTag: jest.Mock;
  let getTag: jest.Mock;
  let updateTag: jest.Mock;

  /**
   * Builds the controller for one viewer.
   *
   * The permission list is a parameter because two of the branches under test sit
   * above the write and are selected by it: a viewer who may only create their own
   * tags is refused a tag addressed to somebody else, and a viewer holding neither
   * permission is refused outright. Both must keep answering as they did.
   */
  const createController = async (
    grantedPermissions: string[] = [
      permissions.createTag,
      permissions.updateTag
    ]
  ) => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [TagsController],
      providers: [
        {
          provide: REQUEST,
          useValue: { user: { id: userId, permissions: grantedPermissions } }
        },
        {
          provide: TagService,
          useValue: { createTag, deleteTag: jest.fn(), getTag, updateTag }
        }
      ]
    }).compile();

    return module.get<TagsController>(TagsController);
  };

  beforeEach(() => {
    createTag = jest.fn().mockResolvedValue(tag);
    getTag = jest.fn().mockResolvedValue(tag);
    updateTag = jest.fn().mockResolvedValue(tag);
  });

  describe('creating a tag whose name is already taken', () => {
    it('answers with a conflict rather than a server fault', async () => {
      createTag.mockRejectedValue(uniquenessConflict());

      const controller = await createController();

      await expect(
        controller.createTag({ name: tag.name, userId })
      ).rejects.toBeInstanceOf(HttpException);

      await expect(
        controller.createTag({ name: tag.name, userId })
      ).rejects.toMatchObject({ status: StatusCodes.CONFLICT });
    });

    it('does not answer 500', async () => {
      createTag.mockRejectedValue(uniquenessConflict());

      const controller = await createController();

      // Stated separately and negatively on purpose: the defect was not the absence
      // of a 409, it was the presence of a 500, and that is the claim a regression
      // would break.
      await expect(
        controller.createTag({ name: tag.name, userId })
      ).rejects.not.toMatchObject({
        status: StatusCodes.INTERNAL_SERVER_ERROR
      });
    });
  });

  describe('renaming a tag onto a name that is already taken', () => {
    it('answers with a conflict rather than a server fault', async () => {
      updateTag.mockRejectedValue(uniquenessConflict());

      const controller = await createController();

      await expect(
        controller.updateTag(tag.id, { id: tag.id, name: 'Emergency', userId })
      ).rejects.toMatchObject({ status: StatusCodes.CONFLICT });
    });
  });

  describe('a write refused for any other reason', () => {
    it('is re-raised untouched', async () => {
      const outage = new Error('Connection refused');

      createTag.mockRejectedValue(outage);

      const controller = await createController();

      // The translation must be narrow. A dropped connection is a genuine fault and
      // has to keep looking like one, or the interface will invite the viewer to
      // rename a tag over a database that is simply not there.
      await expect(
        controller.createTag({ name: tag.name, userId })
      ).rejects.toBe(outage);
    });

    it('leaves a rejection carrying no code alone', async () => {
      const nothingUseful = 'refused';

      updateTag.mockRejectedValue(nothingUseful);

      const controller = await createController();

      // Reads defensively, because the storage layer is not the only thing that can
      // reject: `?.code` on a string must not throw on its way past.
      await expect(
        controller.updateTag(tag.id, { id: tag.id, name: tag.name, userId })
      ).rejects.toBe(nothingUseful);
    });
  });

  describe('an accepted write', () => {
    it('returns the stored tag', async () => {
      const controller = await createController();

      await expect(
        controller.createTag({ name: tag.name, userId })
      ).resolves.toEqual(tag);
      expect(createTag).toHaveBeenCalledWith({ name: tag.name, userId });
    });

    it('returns the renamed tag', async () => {
      const controller = await createController();

      await expect(
        controller.updateTag(tag.id, { id: tag.id, name: 'Cash', userId })
      ).resolves.toEqual(tag);
    });
  });

  describe('the permission branches above the write', () => {
    it('refuses a viewer holding neither create permission', async () => {
      const controller = await createController([]);

      await expect(
        controller.createTag({ name: tag.name, userId })
      ).rejects.toMatchObject({ status: StatusCodes.FORBIDDEN });
      expect(createTag).not.toHaveBeenCalled();
    });

    it('refuses an own-tag creator addressing somebody else', async () => {
      const controller = await createController([permissions.createOwnTag]);

      await expect(
        controller.createTag({ name: tag.name, userId: 'SOMEBODY_ELSE' })
      ).rejects.toMatchObject({ status: StatusCodes.BAD_REQUEST });
      expect(createTag).not.toHaveBeenCalled();
    });

    it('lets an own-tag creator address themselves', async () => {
      const controller = await createController([permissions.createOwnTag]);

      await expect(
        controller.createTag({ name: tag.name, userId })
      ).resolves.toEqual(tag);
    });

    it('refuses a rename of a tag that is not there', async () => {
      getTag.mockResolvedValue(null);

      const controller = await createController();

      await expect(
        controller.updateTag(tag.id, { id: tag.id, name: tag.name, userId })
      ).rejects.toMatchObject({ status: StatusCodes.FORBIDDEN });
      expect(updateTag).not.toHaveBeenCalled();
    });
  });
});
