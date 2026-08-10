import { Injectable, Logger } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

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
