import { GfAppQueryParams } from '@ghostfolio/client/interfaces/interfaces';
import {
  KEY_STAY_SIGNED_IN,
  SettingsStorageService
} from '@ghostfolio/client/services/settings-storage.service';
import { TokenStorageService } from '@ghostfolio/client/services/token-storage.service';
import { UserService } from '@ghostfolio/client/services/user/user.service';
import { DataService } from '@ghostfolio/ui/services';

import { Injectable } from '@angular/core';
import { ActivatedRouteSnapshot } from '@angular/router';
import { EMPTY } from 'rxjs';
import { catchError } from 'rxjs/operators';

/**
 * Guards the single root route that hosts the dashboard canvas.
 *
 * Intentionally non-gating: it always resolves `true`, because the root host — not
 * the router — decides which state to render (public portfolio, signed-out prompt,
 * empty canvas or hydrated canvas), and there is no second route to divert to.
 * Resolving `true` unconditionally is what lets the host reach its empty-canvas
 * state and auto-open the module catalog on a first visit.
 *
 * What the guard is still for is three non-routing side effects: persisting a
 * handed-off JWT, capturing `utm_source` for acquisition attribution, and
 * reconciling a stale persisted user language with the locale being served.
 */
@Injectable({ providedIn: 'root' })
export class AuthGuard {
  public constructor(
    private dataService: DataService,
    private settingsStorageService: SettingsStorageService,
    private tokenStorageService: TokenStorageService,
    private userService: UserService
  ) {}

  canActivate(route: ActivatedRouteSnapshot) {
    // Read through the root route's own parameter contract rather than off the
    // untyped `Params` bag. Both values are then narrowed explicitly, because a
    // query string is attacker-controlled shape as much as attacker-controlled
    // content: a URL of `?jwt=a&jwt=b` yields an array, not a string, and handing
    // that to storage would persist `"a,b"` as a token or as an attribution tag.
    // Anything that is not a single string is therefore treated as absent.
    const queryParams: GfAppQueryParams = route.queryParams ?? {};

    const jwt = typeof queryParams.jwt === 'string' ? queryParams.jwt : null;
    const utmSource =
      typeof queryParams.utm_source === 'string'
        ? queryParams.utm_source
        : null;

    // Persist a handed-off token BEFORE `userService.get()` is called below.
    // This ordering is load-bearing: the API's Google and OIDC callbacks land
    // on `/<locale>/?jwt=<token>`, and the outgoing request interceptor reads
    // the token from storage. Capturing it any later would let that user
    // request fire unauthenticated, fail with 401, and strand a validly
    // authenticated visitor on the signed-out prompt — a failure that raises no
    // exception and is invisible to the compiler.
    //
    // Clearing the parameter from the URL is intentionally not done here:
    // navigating from within `canActivate` risks cancelling the very navigation
    // being guarded. The root host owns that clean-up, and does it with
    // `replaceUrl` so the address it replaces leaves no history entry behind.
    if (this.canAdoptHandedOffToken(jwt)) {
      this.tokenStorageService.saveToken(
        jwt,
        this.settingsStorageService.getSetting(KEY_STAY_SIGNED_IN) === 'true'
      );
    }

    if (utmSource) {
      this.settingsStorageService.setSetting('utm_source', utmSource);
    }

    return new Promise<boolean>((resolve) => {
      this.userService
        .get()
        .pipe(
          // Any lookup failure — no session, but equally a network or server
          // error — activates the route anyway, leaving the root host to render
          // its signed-out state. Failing open is deliberate: there is nowhere
          // else to send the visitor, and blocking activation would render
          // nothing at all.
          catchError(() => {
            resolve(true);
            return EMPTY;
          })
        )
        .subscribe((user) => {
          const userLanguage = user?.settings?.language;

          if (userLanguage && document.documentElement.lang !== userLanguage) {
            this.dataService
              .putUserSetting({ language: document.documentElement.lang })
              .subscribe(() => {
                this.userService.reset();

                setTimeout(() => {
                  window.location.reload();
                }, 300);
              });

            resolve(true);
            return;
          }

          resolve(true);
        });
    });
  }

  /**
   * Whether a token offered in the address bar may be adopted as this browser's
   * session.
   *
   * The hand-off shape itself is fixed: the API's Google and OpenID Connect
   * callbacks redirect to `/<locale>/?jwt=<token>` and this root host is what
   * consumes it. Three conditions narrow what that permits.
   *
   * A token is only adopted when no session is already held. Without that, a
   * link of the form `/?jwt=<attacker-token>` sent to somebody who is signed in
   * would silently swap their session for the sender's — and everything they
   * then entered would be readable by whoever issued the link. Nothing
   * legitimate is lost by refusing: the provider hand-off only ever completes a
   * sign-in that began from the signed-out prompt, so a session in hand means
   * the parameter did not come from a sign-in this browser started. A viewer who
   * genuinely wants to change account signs out first, which clears the token
   * and makes the next hand-off adoptable again.
   *
   * The value must also be shaped like the credential it claims to be — the
   * three dot-separated base64url segments of a compact JWS. A query parameter
   * is whatever somebody typed, and without this check any string at all would
   * be written into storage and then attached to every subsequent request as a
   * bearer token.
   *
   * Third, and this is what makes the parameter safe rather than merely narrow:
   * the sign-in must have been *started from this browser*. The Google and OpenID
   * Connect links record that in session storage immediately before navigating
   * away, and that record survives the journey to the provider and back with the
   * tab — while a link pasted into a fresh tab, or followed out of an email, has
   * no such record. Without it the parameter would be adoptable on its own merits,
   * so `/?jwt=<the sender's own token>` sent to any signed-out visitor would
   * silently sign them into the *sender's* account: every activity, account and
   * holding they then entered would be written into somebody else's portfolio and
   * readable by them. The mark is spent whether or not it was valid, so one
   * started sign-in authorises exactly one hand-off and a reload of the same URL
   * is refused.
   *
   * It is checked last on purpose. It is the only one of the three with a side
   * effect, and spending it while refusing for one of the other reasons would
   * consume a legitimately started sign-in.
   *
   * What this still does NOT do is stop the token being a reusable bearer carried
   * in a URL, where it reaches browser history and any access log that records
   * request targets. Closing that requires a single-use code bound to the provider
   * transaction, or a session cookie — a change to the authentication mechanism
   * itself, which is out of scope here. The residual exposure is narrowed on both
   * sides instead: the API marks the redirect no-store and
   * no-referrer, and the root host replaces the address rather than adding it to
   * history. An adopted token that turns out not to authenticate needs no
   * unwinding here either — the response interceptor signs out on the resulting
   * 401, which clears it.
   *
   * @param aJwt the `jwt` query parameter, absent on all but a hand-off.
   */
  private canAdoptHandedOffToken(aJwt: unknown): aJwt is string {
    if (typeof aJwt !== 'string' || this.tokenStorageService.getToken()) {
      return false;
    }

    if (!/^[\w-]+\.[\w-]+\.[\w-]+$/.test(aJwt)) {
      return false;
    }

    return this.tokenStorageService.consumeExternalSignInMark();
  }
}
