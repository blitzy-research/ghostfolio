import { HasPermissionGuard } from '@ghostfolio/api/guards/has-permission.guard';
import { PerformanceLoggingInterceptor } from '@ghostfolio/api/interceptors/performance-logging/performance-logging.interceptor';
import { UpdateUserDashboardLayoutDto } from '@ghostfolio/common/dtos';
import { UserDashboardLayout } from '@ghostfolio/common/interfaces';
import type { RequestWithUser } from '@ghostfolio/common/types';

import {
  Body,
  Controller,
  Get,
  Inject,
  Patch,
  Res,
  UseGuards,
  UseInterceptors
} from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';
import { Response } from 'express';

import { UserDashboardLayoutService } from './user-dashboard-layout.service';

@Controller('user')
export class UserDashboardLayoutController {
  public constructor(
    @Inject(REQUEST) private readonly request: RequestWithUser,
    private readonly userDashboardLayoutService: UserDashboardLayoutService
  ) {}

  /**
   * A user who has never saved a layout is reported as the JSON literal `null`,
   * which is a different state from a stored document whose module list happens
   * to be empty. Both states have to be expressible on the wire, so the response
   * is written through `response.json(...)` rather than returned: Nest's Express
   * adapter answers a nil handler result with `response.send()` and no argument,
   * which produces a zero-byte body with no `Content-Type` at all. That is not
   * valid JSON, so any consumer stricter than Angular's `HttpClient` — which
   * happens to coerce an empty body to `null` — fails to parse it.
   *
   * Writing the value keeps `null` as `null` and `{ modules: [] }` as
   * `{ modules: [] }`, both as `application/json`, and leaves the status at 200.
   */
  @Get('layout')
  @UseGuards(AuthGuard('jwt'), HasPermissionGuard)
  @UseInterceptors(PerformanceLoggingInterceptor)
  public async getUserDashboardLayout(@Res() response: Response) {
    const userDashboardLayout: UserDashboardLayout | null =
      await this.userDashboardLayoutService.getLayout(this.request.user.id);

    response.json(userDashboardLayout);
  }

  @Patch('layout')
  @UseGuards(AuthGuard('jwt'), HasPermissionGuard)
  public async updateUserDashboardLayout(
    @Body() data: UpdateUserDashboardLayoutDto
  ): Promise<UserDashboardLayout> {
    return this.userDashboardLayoutService.updateLayout({
      userDashboardLayout: data,
      userId: this.request.user.id
    });
  }
}
