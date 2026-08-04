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
 * On a single-canvas shell this guard is intentionally non-gating: it always
 * resolves `true`. Screen selection has stopped being a routing concern, so the
 * root host — not the router — decides which state to render (public portfolio,
 * signed-out prompt, empty canvas or hydrated canvas). Every redirect target
 * this guard previously used (`/start`, `/demo`, `/register`, `/home`, `/zen`)
 * was removed together with the route shells, so a redirect from here could
 * only ever navigate to a route that no longer exists. Resolving `true`
 * unconditionally is also what allows the root host to reach its empty-canvas
 * state and auto-open the module catalog on a first visit.
 *
 * Three side effects are retained deliberately, because none of them is a
 * routing concern: persisting a handed-off JWT, capturing `utm_source` for
 * acquisition attribution, and reconciling a stale persisted user language with
 * the locale actually being served.
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
    const jwt = route.queryParams?.jwt;
    const utmSource = route.queryParams?.utm_source;

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
    // being guarded. The root host owns that clean-up.
    if (jwt) {
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
          // A failed lookup simply means nobody is signed in. There is no
          // public route left to divert to, so the route is still activated and
          // the root host renders its signed-out state.
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
}
