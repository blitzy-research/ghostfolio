import { UserService } from '@ghostfolio/api/app/user/user.service';
import {
  DATABASE_UNAVAILABLE_EVENT,
  isDatabaseUnavailableError
} from '@ghostfolio/api/helper/database.helper';
import { ConfigurationService } from '@ghostfolio/api/services/configuration/configuration.service';
import { PrismaService } from '@ghostfolio/api/services/prisma/prisma.service';
import {
  DEFAULT_CURRENCY,
  DEFAULT_LANGUAGE_CODE,
  HEADER_KEY_TIMEZONE
} from '@ghostfolio/common/config';
import { hasRole } from '@ghostfolio/common/permissions';

import { HttpException, Injectable, Logger } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import * as countriesAndTimezones from 'countries-and-timezones';
import { StatusCodes, getReasonPhrase } from 'http-status-codes';
import { ExtractJwt, Strategy } from 'passport-jwt';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  public constructor(
    private readonly configurationService: ConfigurationService,
    private readonly prismaService: PrismaService,
    private readonly userService: UserService
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      passReqToCallback: true,
      secretOrKey: configurationService.get('JWT_SECRET_KEY')
    });
  }

  public async validate(request: Request, { id }: { id: string }) {
    try {
      const timezone = request.headers[HEADER_KEY_TIMEZONE.toLowerCase()];
      const user = await this.userService.user({ id });

      if (user) {
        if (this.configurationService.get('ENABLE_FEATURE_SUBSCRIPTION')) {
          if (hasRole(user, 'INACTIVE')) {
            throw new HttpException(
              getReasonPhrase(StatusCodes.TOO_MANY_REQUESTS),
              StatusCodes.TOO_MANY_REQUESTS
            );
          }

          const country =
            countriesAndTimezones.getCountryForTimezone(timezone)?.id;

          await this.prismaService.analytics.upsert({
            create: { country, user: { connect: { id: user.id } } },
            update: {
              country,
              activityCount: { increment: 1 },
              lastRequestAt: new Date()
            },
            where: { userId: user.id }
          });
        }

        if (!user.settings.settings.baseCurrency) {
          user.settings.settings.baseCurrency = DEFAULT_CURRENCY;
        }

        if (!user.settings.settings.language) {
          user.settings.settings.language = DEFAULT_LANGUAGE_CODE;
        }

        return user;
      } else {
        throw new HttpException(
          getReasonPhrase(StatusCodes.NOT_FOUND),
          StatusCodes.NOT_FOUND
        );
      }
    } catch (error) {
      if (error?.getStatus?.() === StatusCodes.TOO_MANY_REQUESTS) {
        throw error;
      } else if (isDatabaseUnavailableError(error)) {
        // A credential problem and an unreachable database are opposite events and
        // must not share an answer. This branch exists because they did: every
        // failure here became a 401, so an outage told every signed-in browser its
        // session had expired - the client cleared a token that was perfectly
        // valid, unmounted the canvas and dropped whatever edit was queued, and no
        // sign-in could succeed until the database returned. Nothing about that is
        // recoverable by the visitor, and none of it was written to the log.
        //
        // 503 says what is true: the request could not be served, the credential
        // was never in question, and the caller should try again. The client keeps
        // the session on this status, which is what makes a pending change
        // survivable.
        Logger.error(DATABASE_UNAVAILABLE_EVENT, 'JwtStrategy');

        throw new HttpException(
          getReasonPhrase(StatusCodes.SERVICE_UNAVAILABLE),
          StatusCodes.SERVICE_UNAVAILABLE
        );
      } else {
        throw new HttpException(
          getReasonPhrase(StatusCodes.UNAUTHORIZED),
          StatusCodes.UNAUTHORIZED
        );
      }
    }
  }
}
