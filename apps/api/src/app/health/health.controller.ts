import { HasPermission } from '@ghostfolio/api/decorators/has-permission.decorator';
import { HasPermissionGuard } from '@ghostfolio/api/guards/has-permission.guard';
import { TransformDataSourceInRequestInterceptor } from '@ghostfolio/api/interceptors/transform-data-source-in-request/transform-data-source-in-request.interceptor';
import {
  DataEnhancerHealthResponse,
  DataProviderHealthResponse
} from '@ghostfolio/common/interfaces';
import { permissions } from '@ghostfolio/common/permissions';

import {
  Controller,
  Get,
  HttpException,
  HttpStatus,
  Param,
  Res,
  UseGuards,
  UseInterceptors
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { DataSource } from '@prisma/client';
import { Response } from 'express';
import { StatusCodes, getReasonPhrase } from 'http-status-codes';

import { HealthService } from './health.service';

@Controller('health')
export class HealthController {
  public constructor(private readonly healthService: HealthService) {}

  /**
   * Liveness. Deliberately public and deliberately shallow.
   *
   * `GET /api/v1/health` is a documented part of this application's contract - the
   * README states no bearer token is required, and the shipped Docker composition
   * polls it as its container health check - so it stays open. It also stays
   * *shallow*: it touches only this deployment's own database and cache, never a
   * third party, and the cache probe behind it is single-flight, so repeated calls
   * during an outage cannot accumulate work.
   *
   * The two deep probes below are a different thing wearing the same prefix, and
   * they are guarded accordingly.
   */
  @Get()
  public async getHealth(@Res() response: Response) {
    const databaseServiceHealthy = await this.healthService.isDatabaseHealthy();
    const redisCacheServiceHealthy =
      await this.healthService.isRedisCacheHealthy();

    if (databaseServiceHealthy && redisCacheServiceHealthy) {
      return response
        .status(HttpStatus.OK)
        .json({ status: getReasonPhrase(StatusCodes.OK) });
    } else {
      return response
        .status(HttpStatus.SERVICE_UNAVAILABLE)
        .json({ status: getReasonPhrase(StatusCodes.SERVICE_UNAVAILABLE) });
    }
  }

  /**
   * Whether a third-party asset-profile enhancer is answering.
   *
   * Guarded, unlike the liveness probe above, because it is a fundamentally
   * different operation: it starts a fresh, deliberately uncached request to an
   * external service with a thirty-second request timeout. Left open it was an
   * amplifier - one cheap unauthenticated request bought thirty seconds of a
   * socket, a slot in the event loop, and a slice of this deployment's provider
   * quota, and nothing capped how many could be in flight at once. Neither this
   * route nor its sibling is documented as public anywhere, and the only consumer
   * of either in this application is the administration screen, so the audience
   * they need is exactly the one this guard admits.
   *
   * `AuthGuard('jwt')` runs first and yields 401 for an unauthenticated caller;
   * `HasPermissionGuard` then yields 403 for an authenticated one without
   * administration rights. The service behind it additionally serves one verdict
   * per provider per minute, so even an administrator cannot fan this out.
   */
  @Get('data-enhancer/:name')
  @HasPermission(permissions.accessAdminControl)
  @UseGuards(AuthGuard('jwt'), HasPermissionGuard)
  public async getHealthOfDataEnhancer(
    @Param('name') name: string,
    @Res() response: Response
  ): Promise<Response<DataEnhancerHealthResponse>> {
    const hasResponse =
      await this.healthService.hasResponseFromDataEnhancer(name);

    if (hasResponse) {
      return response.status(HttpStatus.OK).json({
        status: getReasonPhrase(StatusCodes.OK)
      });
    } else {
      return response
        .status(HttpStatus.SERVICE_UNAVAILABLE)
        .json({ status: getReasonPhrase(StatusCodes.SERVICE_UNAVAILABLE) });
    }
  }

  /**
   * Whether a market-data provider is answering.
   *
   * Guarded for the reason given on the enhancer probe above: it issues an
   * uncached quote request to a third party with a thirty-second timeout. Its only
   * consumer is the data-provider status indicator on the administration settings
   * screen, which is rendered exclusively for a viewer who already holds
   * `accessAdminControl`, so the guard matches the audience the feature always had
   * - the route simply had not been asking.
   */
  @Get('data-provider/:dataSource')
  @HasPermission(permissions.accessAdminControl)
  @UseGuards(AuthGuard('jwt'), HasPermissionGuard)
  @UseInterceptors(TransformDataSourceInRequestInterceptor)
  public async getHealthOfDataProvider(
    @Param('dataSource') dataSource: DataSource,
    @Res() response: Response
  ): Promise<Response<DataProviderHealthResponse>> {
    if (!DataSource[dataSource]) {
      throw new HttpException(
        getReasonPhrase(StatusCodes.NOT_FOUND),
        StatusCodes.NOT_FOUND
      );
    }

    const hasResponse =
      await this.healthService.hasResponseFromDataProvider(dataSource);

    if (hasResponse) {
      return response
        .status(HttpStatus.OK)
        .json({ status: getReasonPhrase(StatusCodes.OK) });
    } else {
      return response
        .status(HttpStatus.SERVICE_UNAVAILABLE)
        .json({ status: getReasonPhrase(StatusCodes.SERVICE_UNAVAILABLE) });
    }
  }
}
