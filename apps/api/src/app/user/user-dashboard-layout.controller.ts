import { HasPermissionGuard } from '@ghostfolio/api/guards/has-permission.guard';
import { UpdateUserDashboardLayoutDto } from '@ghostfolio/common/dtos';
import { UserDashboardLayout } from '@ghostfolio/common/interfaces';
import type { RequestWithUser } from '@ghostfolio/common/types';

import {
  Body,
  Controller,
  Get,
  Inject,
  Logger,
  Patch,
  Res,
  UseGuards
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
   * a budget nobody can observe is not a budget. The measurement is taken here
   * rather than by `PerformanceLoggingInterceptor`, and that is the whole point
   * of doing it by hand: the shared interceptor reports through
   * `PerformanceLoggingService`, which logs at `debug`, and the default
   * production logger is `['error', 'log', 'warn']` — so decorating this handler
   * with it would produce a measurement that exists everywhere except the
   * environment the budget applies to. `LOG_LEVELS` can widen that set, but it is
   * optional and unset by default, so it cannot be relied on; and raising the
   * shared service's level would change `PortfolioController`, which is not this
   * refactor's to change. `Logger.log` is enabled by both the production and the
   * development default, so the line below is emitted in every environment.
   *
   * What it emits is deliberately minimal: the handler's own name and the elapsed
   * time. No user id, no token, no query string and no part of the layout
   * document — none of which would help an operator read a latency distribution,
   * and all of which would put viewer data into the log.
   */
  @Get('layout')
  @UseGuards(AuthGuard('jwt'), HasPermissionGuard)
  public async getUserDashboardLayout(@Res() response: Response) {
    const startTime = performance.now();

    const userDashboardLayout: UserDashboardLayout | null =
      await this.userDashboardLayoutService.getLayout(this.request.user.id);

    response.json(userDashboardLayout);

    // Wording and units are copied from `PerformanceLoggingService` on purpose,
    // so this line groups with every other performance line an operator greps
    // for even though it is emitted at a level they can actually see.
    Logger.log(
      `Completed execution of getUserDashboardLayout() in ${(
        (performance.now() - startTime) /
        1000
      ).toFixed(3)} seconds`,
      'UserDashboardLayoutController'
    );
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
