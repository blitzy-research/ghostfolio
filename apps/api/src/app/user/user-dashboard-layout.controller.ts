import { HasPermissionGuard } from '@ghostfolio/api/guards/has-permission.guard';
import { PerformanceLoggingInterceptor } from '@ghostfolio/api/interceptors/performance-logging/performance-logging.interceptor';
import { UpdateUserDashboardLayoutDto } from '@ghostfolio/common/dtos';
import { UserDashboardLayout } from '@ghostfolio/common/interfaces';
import type { RequestWithUser } from '@ghostfolio/common/types';

import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Patch,
  Res,
  UseGuards,
  UseInterceptors
} from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';
import { Response } from 'express';
import { StatusCodes } from 'http-status-codes';

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
   * What that line does NOT measure is worth stating, because the number is easy
   * to mistake for the whole request. An interceptor wraps the HANDLER, and Nest
   * runs guards before interceptors, so the elapsed time reported here begins
   * after authentication has already completed - and authentication is where most
   * of this request's cost is: it resolves the caller across several tables,
   * while the handler itself is one primary-key lookup. Measured together, a warm
   * read spends a handful of milliseconds end to end and a small fraction of it
   * inside this handler. So the line is evidence about the layout read's own cost,
   * which is what a regression in THIS code would move; holding the endpoint to a
   * budget the caller experiences needs a timing source at the request boundary,
   * which this application deliberately does not install - the read path carries
   * no global interceptors, and adding one would put work in front of every
   * endpoint in the application to observe one of them.
   *
   * The interceptor is method-scoped rather than controller-scoped: the write
   * carries no latency budget, so timing it would add a line per save that says
   * nothing about anything a budget is stated for.
   */
  /**
   * Discards the caller's stored arrangement.
   *
   * The guard stack is the one every handler on this controller carries, so an
   * unauthenticated caller is refused by passport before anything here runs and no
   * caller can reach a row but its own — the identity comes from the request
   * context, never from a parameter.
   *
   * This is deliberately a DELETE and not a layout write, and the distinction is
   * the whole reason the endpoint exists. A layout may be written only as the
   * result of a grid state change — a drag, a resize, an add or a remove — and the
   * canvas refuses every write while it holds an arrangement it could not read,
   * which is precisely what keeps a damaged document from being overwritten by the
   * error state that reports it. That left one gap: no way out. Emptying the
   * arrangement and saving it would have closed the gap by opening a second write
   * origin — the one able to overwrite a document the canvas never read. Deleting
   * the row closes it without one: nothing is stored, so nothing is invented, and
   * the next read reports a genuine absence.
   *
   * 204 rather than a body. There is no arrangement left to describe, and an empty
   * 200 from Nest's Express adapter carries no `Content-Type` at all — which is not
   * valid JSON and fails any consumer stricter than Angular's `HttpClient`.
   */
  @Delete('layout')
  @HttpCode(StatusCodes.NO_CONTENT)
  @UseGuards(AuthGuard('jwt'), HasPermissionGuard)
  public async deleteUserDashboardLayout(): Promise<void> {
    await this.userDashboardLayoutService.deleteLayout(this.request.user.id);
  }

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
