import { WebAuthService } from '@ghostfolio/api/app/auth/web-auth.service';
import { HasPermissionGuard } from '@ghostfolio/api/guards/has-permission.guard';
import { ConfigurationService } from '@ghostfolio/api/services/configuration/configuration.service';
import { DEFAULT_LANGUAGE_CODE } from '@ghostfolio/common/config';
import {
  AssertionCredentialJSON,
  AttestationCredentialJSON,
  OAuthResponse
} from '@ghostfolio/common/interfaces';

import {
  Body,
  Controller,
  Get,
  HttpException,
  Param,
  Post,
  Req,
  Res,
  UseGuards,
  Version,
  VERSION_NEUTRAL
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Request, Response } from 'express';
import { getReasonPhrase, StatusCodes } from 'http-status-codes';

import { AuthService } from './auth.service';

@Controller('auth')
export class AuthController {
  public constructor(
    private readonly authService: AuthService,
    private readonly configurationService: ConfigurationService,
    private readonly webAuthService: WebAuthService
  ) {}

  /**
   * @deprecated
   */
  @Get('anonymous/:accessToken')
  public async accessTokenLoginGet(
    @Param('accessToken') accessToken: string
  ): Promise<OAuthResponse> {
    try {
      const authToken =
        await this.authService.validateAnonymousLogin(accessToken);
      return { authToken };
    } catch {
      throw new HttpException(
        getReasonPhrase(StatusCodes.FORBIDDEN),
        StatusCodes.FORBIDDEN
      );
    }
  }

  @Post('anonymous')
  public async accessTokenLogin(
    @Body() body: { accessToken: string }
  ): Promise<OAuthResponse> {
    try {
      const authToken = await this.authService.validateAnonymousLogin(
        body.accessToken
      );
      return { authToken };
    } catch {
      throw new HttpException(
        getReasonPhrase(StatusCodes.FORBIDDEN),
        StatusCodes.FORBIDDEN
      );
    }
  }

  @Get('google')
  @UseGuards(AuthGuard('google'))
  public googleLogin() {
    // Initiates the Google OAuth2 login flow
  }

  @Get('google/callback')
  @UseGuards(AuthGuard('google'))
  @Version(VERSION_NEUTRAL)
  public googleLoginCallback(
    @Req() request: Request,
    @Res() response: Response
  ) {
    const jwt: string = (request.user as any).jwt;

    if (jwt) {
      this.protectRedirectCarryingCredential(response);

      response.redirect(
        `${this.configurationService.get(
          'ROOT_URL'
        )}/${DEFAULT_LANGUAGE_CODE}/?jwt=${jwt}`
      );
    } else {
      response.redirect(
        `${this.configurationService.get('ROOT_URL')}/${DEFAULT_LANGUAGE_CODE}/`
      );
    }
  }

  @Get('oidc')
  @UseGuards(AuthGuard('oidc'))
  @Version(VERSION_NEUTRAL)
  public oidcLogin() {
    if (!this.configurationService.get('ENABLE_FEATURE_AUTH_OIDC')) {
      throw new HttpException(
        getReasonPhrase(StatusCodes.FORBIDDEN),
        StatusCodes.FORBIDDEN
      );
    }
  }

  @Get('oidc/callback')
  @UseGuards(AuthGuard('oidc'))
  @Version(VERSION_NEUTRAL)
  public oidcLoginCallback(@Req() request: Request, @Res() response: Response) {
    const jwt: string = (request.user as any).jwt;

    if (jwt) {
      this.protectRedirectCarryingCredential(response);

      response.redirect(
        `${this.configurationService.get(
          'ROOT_URL'
        )}/${DEFAULT_LANGUAGE_CODE}/?jwt=${jwt}`
      );
    } else {
      response.redirect(
        `${this.configurationService.get('ROOT_URL')}/${DEFAULT_LANGUAGE_CODE}/`
      );
    }
  }

  @Post('webauthn/generate-authentication-options')
  public async generateAuthenticationOptions(
    @Body() body: { deviceId: string }
  ) {
    return this.webAuthService.generateAuthenticationOptions(body.deviceId);
  }

  @Get('webauthn/generate-registration-options')
  @UseGuards(AuthGuard('jwt'), HasPermissionGuard)
  public async generateRegistrationOptions() {
    return this.webAuthService.generateRegistrationOptions();
  }

  @Post('webauthn/verify-attestation')
  @UseGuards(AuthGuard('jwt'), HasPermissionGuard)
  public async verifyAttestation(
    @Body() body: { deviceName: string; credential: AttestationCredentialJSON }
  ) {
    return this.webAuthService.verifyAttestation(body.credential);
  }

  @Post('webauthn/verify-authentication')
  public async verifyAuthentication(
    @Body() body: { deviceId: string; credential: AssertionCredentialJSON }
  ) {
    try {
      const authToken = await this.webAuthService.verifyAuthentication(
        body.deviceId,
        body.credential
      );
      return { authToken };
    } catch {
      throw new HttpException(
        getReasonPhrase(StatusCodes.FORBIDDEN),
        StatusCodes.FORBIDDEN
      );
    }
  }

  /**
   * Narrows the exposure of a redirect whose target URL carries the session
   * token, applied to the Google and OpenID Connect callbacks.
   *
   * The provider hands the identity back to the browser through a redirect, and
   * the token reaches the client as a query parameter of that redirect target.
   * That shape is what the client's root host consumes and is therefore kept,
   * but a URL bearing a credential must not be treated like an ordinary one:
   *
   * - `Cache-Control: no-store` together with `Pragma: no-cache` keeps the
   *   response, and the Location it carries, out of the browser cache and out
   *   of any intermediary that would otherwise be free to retain a 302.
   * - `Referrer-Policy: no-referrer` stops this URL from being disclosed as the
   *   referrer of the request the browser makes next while following it.
   *
   * These headers are set on the handler rather than centrally because the
   * application applies its security-header middleware only when the
   * subscription feature is switched on, so an installation without it would
   * otherwise send the credential-bearing redirect with default headers. They
   * narrow the exposure; they do not remove it. A token in a URL still reaches
   * browser history and any access log that records request targets, and only
   * moving the hand-off out of the URL closes that — a change to the
   * authentication mechanism itself, which is out of scope here.
   *
   * @param response the Express response the redirect is about to be written to.
   */
  private protectRedirectCarryingCredential(response: Response) {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Pragma', 'no-cache');
    response.setHeader('Referrer-Policy', 'no-referrer');
  }
}
