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
   *
   * The read is timed, because this endpoint carries a stated latency budget and
   * a budget nobody can observe is not a budget. The measurement is taken by the
   * shared `PerformanceLoggingInterceptor` — the same instrument
   * `PortfolioController` already uses — and deliberately not by anything local
   * to this controller: one observability authority reporting in one format is
   * what lets an operator read every timing in this application the same way,
   * and a second one here would be a fork of it that only this endpoint speaks.
   *
   * What it emits is what the shared authority emits, and that is deliberately
   * minimal: the handler's class, the handler's own name and the elapsed time.
   * No user id, no token, no query string and no part of the layout document —
   * none of which would help an operator read a latency distribution, and all of
   * which would put viewer data into the log.
   *
   * Which environments that line reaches is a deployment decision rather than a
   * controller decision, and it is already configurable: the shared service
   * reports at `debug`, the production logger defaults to
   * `['error', 'log', 'warn']`, and `LOG_LEVELS` is the documented lever that
   * widens it (see the environment variable table in `README.md` and
   * `docs/setup.md`). An operator who wants to hold this endpoint to its budget
   * sets it there, once, for every timing this application produces.
   *
   * The interceptor is method-scoped rather than controller-scoped: the write
   * carries no latency budget, so timing it would add a line per save that says
   * nothing about anything a budget is stated for.
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
