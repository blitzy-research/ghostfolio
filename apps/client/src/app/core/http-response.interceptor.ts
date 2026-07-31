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

            this.snackBarRef.afterDismissed().subscribe(() => {
              this.snackBarRef = undefined;
            });

            this.snackBarRef.onAction().subscribe(() => {
              // The in-app pricing route no longer exists, so navigate to the
              // hosted pricing page. The locale is read from the document
              // because a forbidden response can precede any loaded user.
              window.location.href = `https://ghostfol.io/${document.documentElement.lang}/${publicRoutes.pricing.path}`;
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
          // Do not sign the user out when the background data provider status
          // probe fails: only a genuine unauthorized response ends the session.
          if (!error.url.includes('/data-providers/ghostfolio/status')) {
            this.userService.signOut();
          }
        }

        return throwError(error);
      })
    );
  }
}

export const httpResponseInterceptorProviders = [
  { provide: HTTP_INTERCEPTORS, useClass: HttpResponseInterceptor, multi: true }
];
