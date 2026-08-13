import { ConfigurationService } from '@ghostfolio/api/services/configuration/configuration.service';

import {
  ExecutionContext,
  HttpException,
  Injectable,
  Logger
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { getReasonPhrase, StatusCodes } from 'http-status-codes';

/**
 * The stable event identifier a federated sign-in that produced no identity is
 * reported under.
 *
 * A fixed string, because a log line is read by everyone who can read the log, is
 * captured verbatim by log shipping, and outlives the sign-in attempt it
 * describes. The identifier is what makes the event searchable; the provider
 * beside it is what makes it actionable, and it is a closed vocabulary rather than
 * anything the request supplied.
 */
const OAUTH_CALLBACK_FAILED_EVENT = 'GF-OAUTH-CALLBACK-FAILED';

/**
 * Builds the guard a *browser-facing* federated callback is protected by.
 *
 * The default behaviour of `AuthGuard` is right for an API and wrong here. It
 * rethrows whatever the strategy reported, so a provider that answered
 * `invalid_grant`, or returned an identity token without a subject, left the
 * visitor looking at `{"statusCode":500,"message":"Internal server error"}` -
 * a raw error page at an `/api/auth/...` address, with the framework's own
 * exception handler printing a stack trace beside it for an event that is not a
 * fault in this application at all. The visitor's browser is at the end of a
 * redirect chain it did not choose to be on, and has nowhere to go from there.
 *
 * `handleRequest` is the sanctioned seam for that decision, and it is deliberately
 * the one used rather than an exception filter. Whatever it returns becomes
 * `request.user` and activation proceeds, so a failure is expressed as *no
 * identity* - which is a state the callback handlers already have a branch for,
 * the one that returns the browser to the application. Nothing about the redirect
 * is restated here, and the success path is untouched.
 *
 * Narrower than a filter, too: a `@Catch()` filter on these routes would also
 * swallow a genuine defect somewhere else in the request into a redirect, hiding
 * it. This converts exactly one thing - an authentication attempt that yielded no
 * user - and lets anything else fail as loudly as it should.
 *
 * The strategy's own error, with the provider's message, is already logged by the
 * strategy. What is added here is the fixed identifier that makes the outcome
 * countable, and it names neither the visitor nor anything the provider sent.
 *
 * @param strategy the passport strategy this callback authenticates with. A closed
 * set, so the value that reaches the log cannot come from a request.
 */
function createOAuthCallbackGuard(strategy: 'google' | 'oidc') {
  @Injectable()
  class OAuthCallbackGuard extends AuthGuard(strategy) {
    public constructor(
      private readonly configurationService: ConfigurationService
    ) {
      super();
    }

    /**
     * Decides whether the provider can be consulted at all before consulting it.
     *
     * This exists because a strategy that was never registered cannot be handled by
     * {@link handleRequest}. Passport raises `Unknown authentication strategy` from
     * inside `authenticate`, which rejects before any callback of ours runs, so the
     * visitor received a sanitized 500 at an `/api/auth/...` address and the server
     * logged an error for a deployment that had simply not switched the provider on.
     * The strategy is only registered when the corresponding feature flag is set -
     * OIDC's provider factory returns `null` otherwise - so the flag is the exact
     * question to ask first.
     *
     * A disabled provider is expressed the same way a refused one is: activation
     * proceeds with NO identity, which is the state the callback handlers already
     * have a branch for, the one that returns the browser to the application. That
     * keeps a browser-facing route answering with a redirect rather than with a JSON
     * error page, and it keeps this guard's two failure modes converging on one
     * recovery.
     */
    public canActivate(context: ExecutionContext) {
      if (!this.isProviderEnabled()) {
        // Warn rather than error, and identical in shape to the line below: from
        // this application's side nothing is broken. Somebody - or something -
        // reached a callback for a provider this deployment does not offer, which
        // is worth counting and is not a fault.
        Logger.warn(
          `${OAUTH_CALLBACK_FAILED_EVENT} (provider ${strategy} is not enabled)`,
          'OAuthCallbackGuard'
        );

        context.switchToHttp().getRequest().user = null;

        return true;
      }

      return super.canActivate(context);
    }

    /**
     * The reported error is taken and deliberately not used. It is the provider's
     * own object, carrying its message and this application's stack, and putting
     * any of it on the line below would undo what makes that line safe to ship.
     * The strategy has already logged it for whoever is diagnosing.
     */
    public handleRequest<TUser>(_error: unknown, user: TUser): TUser {
      if (user) {
        return user;
      }

      // Warn rather than error: from this application's side nothing is broken -
      // an identity provider declined, or answered with something unusable - and
      // the actionable detail is already on the line the strategy logged.
      Logger.warn(
        `${OAUTH_CALLBACK_FAILED_EVENT} (provider ${strategy})`,
        'OAuthCallbackGuard'
      );

      return null as TUser;
    }

    /**
     * Whether this deployment registered the strategy this guard authenticates
     * with.
     *
     * Google's strategy is registered unconditionally, so its callback is always
     * able to consult Passport. OIDC's provider factory returns `null` unless
     * `ENABLE_FEATURE_AUTH_OIDC` is set, and a `null` provider means no strategy
     * was ever handed to Passport - which is the case this method exists to
     * recognise.
     */
    private isProviderEnabled(): boolean {
      if (strategy === 'oidc') {
        return !!this.configurationService.get('ENABLE_FEATURE_AUTH_OIDC');
      }

      return true;
    }
  }

  return OAuthCallbackGuard;
}

/**
 * Protects `GET /api/auth/google/callback`.
 *
 * Applied to the callback only. The route that *starts* the flow keeps the plain
 * guard, because a failure there happens before the visitor has left for the
 * provider and is not the stranding this exists to prevent.
 */
export const GoogleCallbackGuard = createOAuthCallbackGuard('google');

/** Protects `GET /api/auth/oidc/callback`. See `GoogleCallbackGuard`. */
export const OidcCallbackGuard = createOAuthCallbackGuard('oidc');

/**
 * Protects the route that STARTS the OIDC flow, `GET /api/auth/oidc`.
 *
 * The plain `AuthGuard('oidc')` cannot protect it, and the reason is the same one
 * the callback guard above exists for: when `ENABLE_FEATURE_AUTH_OIDC` is unset the
 * provider factory hands Passport no strategy, so `authenticate` raises `Unknown
 * authentication strategy` and the caller receives a 500 for a provider this
 * deployment simply does not offer. The handler's own flag check never ran, because
 * a guard decides before the handler is entered.
 *
 * The refusal is a 403, deliberately, and it is stated once here rather than in the
 * handler body: the visitor has not left for a provider yet - nothing is mid-flight
 * and there is nothing to return them to - so an honest status is the right answer,
 * where the CALLBACK instead redirects because a browser is stranded at the end of a
 * redirect chain by then.
 */
@Injectable()
export class OidcLoginGuard extends AuthGuard('oidc') {
  public constructor(
    private readonly configurationService: ConfigurationService
  ) {
    super();
  }

  public canActivate(context: ExecutionContext) {
    if (!this.configurationService.get('ENABLE_FEATURE_AUTH_OIDC')) {
      throw new HttpException(
        getReasonPhrase(StatusCodes.FORBIDDEN),
        StatusCodes.FORBIDDEN
      );
    }

    return super.canActivate(context);
  }
}
