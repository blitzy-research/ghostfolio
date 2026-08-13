import { HasPermission } from '@ghostfolio/api/decorators/has-permission.decorator';
import { HasPermissionGuard } from '@ghostfolio/api/guards/has-permission.guard';
import { TagService } from '@ghostfolio/api/services/tag/tag.service';
import { CreateTagDto, UpdateTagDto } from '@ghostfolio/common/dtos';
import { hasPermission, permissions } from '@ghostfolio/common/permissions';
import { RequestWithUser } from '@ghostfolio/common/types';

import {
  Body,
  Controller,
  Delete,
  Get,
  HttpException,
  Inject,
  Param,
  Post,
  Put,
  UseGuards
} from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';
import { Tag } from '@prisma/client';
import { StatusCodes, getReasonPhrase } from 'http-status-codes';

@Controller('tags')
export class TagsController {
  public constructor(
    @Inject(REQUEST) private readonly request: RequestWithUser,
    private readonly tagService: TagService
  ) {}

  @Post()
  @UseGuards(AuthGuard('jwt'))
  public async createTag(@Body() data: CreateTagDto): Promise<Tag> {
    const canCreateOwnTag = hasPermission(
      this.request.user.permissions,
      permissions.createOwnTag
    );

    const canCreateTag = hasPermission(
      this.request.user.permissions,
      permissions.createTag
    );

    if (!canCreateOwnTag && !canCreateTag) {
      throw new HttpException(
        getReasonPhrase(StatusCodes.FORBIDDEN),
        StatusCodes.FORBIDDEN
      );
    }

    if (canCreateOwnTag && !canCreateTag) {
      if (data.userId !== this.request.user.id) {
        throw new HttpException(
          getReasonPhrase(StatusCodes.BAD_REQUEST),
          StatusCodes.BAD_REQUEST
        );
      }
    }

    try {
      return await this.tagService.createTag(data);
    } catch (error) {
      throw this.translateTagWriteError(error);
    }
  }

  @Delete(':id')
  @HasPermission(permissions.deleteTag)
  @UseGuards(AuthGuard('jwt'), HasPermissionGuard)
  public async deleteTag(@Param('id') id: string) {
    const originalTag = await this.tagService.getTag({
      id
    });

    if (!originalTag) {
      throw new HttpException(
        getReasonPhrase(StatusCodes.FORBIDDEN),
        StatusCodes.FORBIDDEN
      );
    }

    return this.tagService.deleteTag({ id });
  }

  @Get()
  @HasPermission(permissions.readTags)
  @UseGuards(AuthGuard('jwt'), HasPermissionGuard)
  public async getTags() {
    return this.tagService.getTagsWithActivityCount();
  }

  @HasPermission(permissions.updateTag)
  @Put(':id')
  @UseGuards(AuthGuard('jwt'), HasPermissionGuard)
  public async updateTag(@Param('id') id: string, @Body() data: UpdateTagDto) {
    const originalTag = await this.tagService.getTag({
      id
    });

    if (!originalTag) {
      throw new HttpException(
        getReasonPhrase(StatusCodes.FORBIDDEN),
        StatusCodes.FORBIDDEN
      );
    }

    try {
      return await this.tagService.updateTag({
        data: {
          ...data
        },
        where: {
          id
        }
      });
    } catch (error) {
      throw this.translateTagWriteError(error);
    }
  }

  /**
   * Turns a rejected tag write into the answer its cause deserves.
   *
   * A tag is unique per owner by database constraint, so a repeated name is refused at
   * the storage layer with Prisma's `P2002`. Unmapped, that surfaced as a 500 - which
   * says the server broke when in fact the request was answerable and simply not
   * allowed, and left the interface with nothing better to offer than a generic apology
   * for a condition its viewer could have corrected in a second.
   *
   * `409` rather than `400`, because the request is well formed: it conflicts with what
   * already exists, and only the current contents of the store make it wrong. Anything
   * that is not a uniqueness conflict is re-raised untouched, so a genuine fault is
   * still a fault.
   *
   * @param aError the value thrown by the storage layer.
   * @returns the exception to raise in its place.
   */
  private translateTagWriteError(aError: unknown) {
    if ((aError as { code?: string })?.code === 'P2002') {
      return new HttpException(
        getReasonPhrase(StatusCodes.CONFLICT),
        StatusCodes.CONFLICT
      );
    }

    return aError;
  }
}
