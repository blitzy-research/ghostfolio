import {
  DATABASE_UNAVAILABLE_EVENT,
  isDatabaseUnavailableError
} from '@ghostfolio/api/helper/database.helper';
import { TransformDataSourceInResponseInterceptor } from '@ghostfolio/api/interceptors/transform-data-source-in-response/transform-data-source-in-response.interceptor';
import { InfoResponse } from '@ghostfolio/common/interfaces';

import {
  Controller,
  Get,
  HttpException,
  Logger,
  UseInterceptors
} from '@nestjs/common';
import { getReasonPhrase, StatusCodes } from 'http-status-codes';

import { InfoService } from './info.service';

@Controller('info')
export class InfoController {
  public constructor(private readonly infoService: InfoService) {}

  /**
   * The public bootstrap document: which providers are configured, whether signing up
   * is allowed, the platform statistics.
   *
   * The database branch below is what stops an outage here being reported as a defect
   * in this application. The service reads several properties, so while the database is
   * unreachable it rejects - and left alone that reaches Nest's default handler, which
   * answers 500 and prints the entire Prisma failure into the log: the failing
   * statement, the host and the port, once per request, burying the entries that
   * explain the incident. 500 is also the wrong thing to tell a caller, because it
   * invites a bug report rather than a retry.
   *
   * 503 with a fixed event identifier says what is true and nothing more: the
   * dependency is down, the request may be retried, and the incident is countable. The
   * client treats this status as retryable and keeps whatever session it holds.
   */
  @Get()
  @UseInterceptors(TransformDataSourceInResponseInterceptor)
  public async getInfo(): Promise<InfoResponse> {
    try {
      return await this.infoService.get();
    } catch (error) {
      if (isDatabaseUnavailableError(error)) {
        Logger.error(DATABASE_UNAVAILABLE_EVENT, 'InfoController');

        // Raised without a `cause`: an `HttpException` is an intrinsic exception, so
        // Nest maps it to the status below without logging it, whereas attaching the
        // original would put the whole slab this branch exists to remove back into
        // the same log.
        throw new HttpException(
          getReasonPhrase(StatusCodes.SERVICE_UNAVAILABLE),
          StatusCodes.SERVICE_UNAVAILABLE
        );
      }

      throw error;
    }
  }
}
