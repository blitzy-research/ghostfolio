import {
  GoogleCallbackGuard,
  OidcCallbackGuard
} from '@ghostfolio/api/app/auth/oauth-callback.guard';
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
  @UseGuards(GoogleCallbackGuard)
  @Version(VERSION_NEUTRAL)
  public googleLoginCallback(
    @Req() request: Request,
    @Res() response: Response
  ) {
    // Optional, because the callback guard expresses a provider round trip that
    // yielded no identity as an absent user rather than as an exception. Reading
    // through it unconditionally would replace the 500 this arrangement exists to
    // remove with a `TypeError` producing another one.
    const jwt: string = (request.user as any)?.jwt;

    if (jwt) {
      this.protectRedirectCarryingCredential(response);

      response.redirect(
        `${this.configurationService.get(
          'ROOT_URL'
        )}/${DEFAULT_LANGUAGE_CODE}/?jwt=${jwt}`
      );
    } else {
      response.redirect(this.buildSignInFailureUrl());
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
  @UseGuards(OidcCallbackGuard)
  @Version(VERSION_NEUTRAL)
  public oidcLoginCallback(@Req() request: Request, @Res() response: Response) {
    // See the Google callback: an absent user is how a refused or unusable
    // provider answer arrives here.
    const jwt: string = (request.user as any)?.jwt;

    if (jwt) {
      this.protectRedirectCarryingCredential(response);

      response.redirect(
        `${this.configurationService.get(
          'ROOT_URL'
        )}/${DEFAULT_LANGUAGE_CODE}/?jwt=${jwt}`
      );
    } else {
      response.redirect(this.buildSignInFailureUrl());
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
   * Where the browser is sent when a federated sign-in came back without an
   * identity.
   *
   * The locale root, because that is the only route there is, and with a marker,
   * because without one the visitor lands on the signed-out prompt they started
   * from with nothing to distinguish "the provider declined" from "you have not
   * signed in yet" - so the natural response is to press the same button and
   * arrive back here. The marker is what turns a loop into a message.
   *
   * A fixed value from a closed vocabulary rather than anything about the failure.
   * It travels in a URL the visitor can read and edit, so it must be worth nothing
   * if forged and disclose nothing if genuine: which provider was involved, what it
   * said, and whether the account exists are all absent, and the client compares
   * the value rather than displaying it. `provider` covers both callbacks because
   * the sentence the visitor needs is the same either way.
   *
   * The credential-protecting headers are deliberately not set on this redirect:
   * there is no credential in it, and this URL is one a visitor may legitimately
   * keep.
   */
  private buildSignInFailureUrl() {
    return `${this.configurationService.get(
      'ROOT_URL'
    )}/${DEFAULT_LANGUAGE_CODE}/?signInError=provider`;
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
