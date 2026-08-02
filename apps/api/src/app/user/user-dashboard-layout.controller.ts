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
  UseGuards,
  UseInterceptors
} from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';

import { UserDashboardLayoutService } from './user-dashboard-layout.service';

@Controller('user')
export class UserDashboardLayoutController {
  public constructor(
    @Inject(REQUEST) private readonly request: RequestWithUser,
    private readonly userDashboardLayoutService: UserDashboardLayoutService
  ) {}

  @Get('layout')
  @UseGuards(AuthGuard('jwt'), HasPermissionGuard)
  @UseInterceptors(PerformanceLoggingInterceptor)
  public async getUserDashboardLayout(): Promise<UserDashboardLayout> {
    return this.userDashboardLayoutService.getLayout(this.request.user.id);
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
