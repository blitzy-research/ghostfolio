import { TokenStorageService } from '@ghostfolio/client/services/token-storage.service';
import { UserService } from '@ghostfolio/client/services/user/user.service';
import { InfoItem } from '@ghostfolio/common/interfaces';
import { internalRoutes, publicRoutes } from '@ghostfolio/common/routes/routes';
import { DataService } from '@ghostfolio/ui/services';

import {
  HTTP_INTERCEPTORS,
  HttpErrorResponse,
  HttpEvent,
  HttpHandler,
  HttpInterceptor,
  HttpRequest
} from '@angular/common/http';
import { Injectable } from '@angular/core';
import {
  MatSnackBar,
  MatSnackBarRef,
  TextOnlySnackBar
} from '@angular/material/snack-bar';
import { StatusCodes } from 'http-status-codes';
import ms from 'ms';
import { Observable, throwError } from 'rxjs';
import { catchError, tap } from 'rxjs/operators';

@Injectable()
export class HttpResponseInterceptor implements HttpInterceptor {
  public info: InfoItem;
  public snackBarRef: MatSnackBarRef<TextOnlySnackBar>;

  public constructor(
    private dataService: DataService,
    private snackBar: MatSnackBar,
    private tokenStorageService: TokenStorageService,
    private userService: UserService
  ) {
    this.info = this.dataService.fetchInfo();
  }

  public intercept(
    request: HttpRequest<any>,
    next: HttpHandler
  ): Observable<HttpEvent<any>> {
    return next.handle(request).pipe(
      tap((event: HttpEvent<any>) => {
        return event;
      }),
      catchError((error: HttpErrorResponse) => {
        if (error.status === StatusCodes.FORBIDDEN) {
          if (!this.snackBarRef) {
            if (this.info.isReadOnlyMode) {
              this.snackBarRef = this.snackBar.open(
                $localize`This feature is currently unavailable.` +
                  ' ' +
                  $localize`Please try again later.`,
                undefined,
                {
                  duration: ms('6 seconds')
                }
              );
            } else if (
              !error.url.includes(internalRoutes.auth.routerLink.join(''))
            ) {
              this.snackBarRef = this.snackBar.open(
                $localize`This action is not allowed.`,
                undefined,
                {
                  duration: ms('6 seconds')
                }
              );
            }

            // Guarded, because the branches above deliberately raise NO notice for
            // one case - a refusal from the authentication endpoint, which the
            // sign-in surface reports itself - and subscribing to a reference that
            // was never assigned threw a `TypeError` from inside `catchError`,
            // replacing a handled 403 with an unhandled error.
            if (this.snackBarRef) {
              this.snackBarRef.afterDismissed().subscribe(() => {
                this.snackBarRef = undefined;
              });

              this.snackBarRef.onAction().subscribe(() => {
                // Pricing is hosted externally; document.lang is available before
                // user hydration.
                window.location.href = `https://ghostfol.io/${document.documentElement.lang}/${publicRoutes.pricing.path}`;
              });
            }
          }
        } else if (error.status === StatusCodes.SERVICE_UNAVAILABLE) {
          // A dependency the server needs is down - the database, typically. This
          // is emphatically NOT an authentication outcome, and keeping it out of
          // the 401 branch below is the whole point: the session is still valid, so
          // the token stays in storage, the canvas stays mounted and whatever
          // change is queued stays queued and recoverable. The viewer is told it is
          // temporary and offered a retry, which is the only thing that can
          // actually help.
          if (!this.snackBarRef) {
            this.snackBarRef = this.snackBar.open(
              $localize`The service is temporarily unavailable.` +
                ' ' +
                $localize`Please try again later.`,
              $localize`Retry`,
              {
                duration: ms('6 seconds')
              }
            );

            this.snackBarRef.afterDismissed().subscribe(() => {
              this.snackBarRef = undefined;
            });

            this.snackBarRef.onAction().subscribe(() => {
              window.location.reload();
            });
          }
        } else if (error.status === StatusCodes.INTERNAL_SERVER_ERROR) {
          if (!this.snackBarRef) {
            this.snackBarRef = this.snackBar.open(
              $localize`Oops! Something went wrong.` +
                ' ' +
                $localize`Please try again later.`,
              $localize`Okay`,
              {
                duration: ms('6 seconds')
              }
            );

            this.snackBarRef.afterDismissed().subscribe(() => {
              this.snackBarRef = undefined;
            });

            this.snackBarRef.onAction().subscribe(() => {
              window.location.reload();
            });
          }
        } else if (error.status === StatusCodes.TOO_MANY_REQUESTS) {
          if (!this.snackBarRef) {
            this.snackBarRef = this.snackBar.open(
              $localize`Oops! It looks like you’re making too many requests. Please slow down a bit.`
            );

            this.snackBarRef.afterDismissed().subscribe(() => {
              this.snackBarRef = undefined;
            });
          }
        } else if (error.status === StatusCodes.UNAUTHORIZED) {
          // A provider-status 401 can be independent of the user's
          // authenticated session.
          if (!error.url.includes('/data-providers/ghostfolio/status')) {
            // Told, not merely done. Signing out here replaces the whole screen
            // - the canvas, its modules and the control bar are all torn down and
            // the sign-in card takes their place - without a reload and without
            // the address changing, so with nothing said the result is
            // indistinguishable from a first visit. Anyone who had just moved a
            // module saw it revert with no explanation, and the only trace was a
            // console line.
            //
            // Announced BEFORE signing out, so the message exists whatever the
            // sign-out goes on to do to storage, and guarded by the same single
            // reference the branches above use: several requests fail together
            // when a session ends - the arrangement, each module's own read - and
            // one ended session is one message.
            this.notifySessionEnded();

            this.userService.signOut();
          }
        }

        return throwError(error);
      })
    );
  }

  /**
   * Says that the session ended, once.
   *
   * Deliberately without an action. Every other notice this interceptor raises
   * offers one - reload, or the pricing page - but there is nothing to offer here:
   * the sign-in card that replaces the screen a moment later *is* the way back, and
   * a second control pointing at it would be a race with the teardown that is
   * already under way.
   *
   * What it does not do is carry the unsaved arrangement forward, and that is a
   * decision rather than an omission. The layout service refuses to write a
   * snapshot whose originating identity is no longer the active one, precisely so
   * one viewer's arrangement can never be written under another's credential -
   * which is exactly the situation a replay after re-authentication would create,
   * since whoever signs in next need not be who was signed in before. The
   * arrangement is therefore lost, and the viewer is told so they can redo it,
   * rather than being handed a retry that would either silently do nothing or do
   * something dangerous.
   */
  private notifySessionEnded() {
    // Only a session that existed can have ended, and this is what keeps the
    // notice truthful. The root route asks for the viewer unconditionally - the
    // guard calls `UserService.get()` before it knows whether anyone is signed in
    // - so *every* first visit produces a 401 of its own, before any credential
    // has ever been held. Announcing that would greet a brand-new visitor with the
    // claim that a session they never had has expired, printed next to the sign-in
    // card that is the correct and complete answer to their 401.
    //
    // Storage is the right thing to ask because of the order this runs in: the
    // sign-out that clears the token runs after this returns, so a genuinely
    // expired session still has its token in hand here. The same test also keeps a
    // deliberate sign-out quiet, since that clears the token first and any
    // in-flight request failing behind it then says nothing - which is right,
    // because the viewer knows why they are signed out.
    if (!this.tokenStorageService.getToken()) {
      return;
    }

    if (this.snackBarRef) {
      return;
    }

    this.snackBarRef = this.snackBar.open(
      $localize`Your session has expired. Please sign in again.`,
      undefined,
      {
        duration: ms('6 seconds')
      }
    );

    this.snackBarRef.afterDismissed().subscribe(() => {
      this.snackBarRef = undefined;
    });
  }
}

export const httpResponseInterceptorProviders = [
  { provide: HTTP_INTERCEPTORS, useClass: HttpResponseInterceptor, multi: true }
];
