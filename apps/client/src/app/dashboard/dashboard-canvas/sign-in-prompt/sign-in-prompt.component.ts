import type { LoginWithAccessTokenDialogParams } from '@ghostfolio/client/components/login-with-access-token-dialog/interfaces/interfaces';
import type { UserAccountRegistrationDialogParams } from '@ghostfolio/client/components/user-account-registration-dialog/interfaces/interfaces';
import { LazyDialogService } from '@ghostfolio/client/core/lazy-dialog.service';
import {
  KEY_STAY_SIGNED_IN,
  SettingsStorageService
} from '@ghostfolio/client/services/settings-storage.service';
import { TokenStorageService } from '@ghostfolio/client/services/token-storage.service';
import { UserService } from '@ghostfolio/client/services/user/user.service';
import { reportSanitizedError } from '@ghostfolio/common/helper';
import { hasPermission, permissions } from '@ghostfolio/common/permissions';
import { GfLogoComponent } from '@ghostfolio/ui/logo';
import { NotificationService } from '@ghostfolio/ui/notifications';
import { DataService } from '@ghostfolio/ui/services';

import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  CUSTOM_ELEMENTS_SCHEMA,
  DestroyRef,
  Input,
  OnInit
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatDialog } from '@angular/material/dialog';
import { Router } from '@angular/router';
import { DeviceDetectorService } from 'ngx-device-detector';
import { EMPTY } from 'rxjs';
import { catchError } from 'rxjs/operators';

import { GfDashboardLayoutService } from '../../services/dashboard-layout.service';

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [GfLogoComponent, MatButtonModule, MatCardModule],
  schemas: [CUSTOM_ELEMENTS_SCHEMA],
  selector: 'gf-sign-in-prompt',
  styleUrls: ['./sign-in-prompt.scss'],
  templateUrl: './sign-in-prompt.html'
})
export class GfSignInPromptComponent implements OnInit {
  /**
   * Whether the visitor reached this card by being refused by an identity
   * provider, rather than by arriving for the first time.
   *
   * A boolean, not the reason: what the provider objected to is between the
   * deployment's operator and the provider, and the failure marker that carries it
   * this far travels through a URL the visitor can edit. The sentence rendered
   * from this is fixed in the template, so nothing a link can write is ever shown.
   */
  @Input() hasSignInError = false;

  public deviceType: string;

  public hasPermissionForAuthGoogle: boolean;

  public hasPermissionForAuthOidc: boolean;

  public hasPermissionForAuthToken: boolean;

  public hasPermissionForSubscription: boolean;

  public hasPermissionToCreateUser: boolean;

  /**
   * Whether a dialog's own chunk is currently being resolved.
   *
   * Bound to both controls on this card rather than to the one that started the
   * load, and deliberately so: each opens a dialog and there is only ever one
   * visitor pressing them, so while either is resolving neither should start a
   * second. It is what makes the wait visible as well as survivable - a control that
   * has gone quiet for a moment is otherwise indistinguishable from one that did
   * nothing at all.
   */
  public isOpeningDialog = false;

  public constructor(
    private changeDetectorRef: ChangeDetectorRef,
    private dashboardLayoutService: GfDashboardLayoutService,
    private dataService: DataService,
    private destroyRef: DestroyRef,
    private deviceService: DeviceDetectorService,
    private dialog: MatDialog,
    private lazyDialogService: LazyDialogService,
    private notificationService: NotificationService,
    private router: Router,
    private settingsStorageService: SettingsStorageService,
    private tokenStorageService: TokenStorageService,
    private userService: UserService
  ) {}

  public ngOnInit() {
    const { globalPermissions } = this.dataService.fetchInfo();

    this.deviceType = this.deviceService.getDeviceInfo().deviceType;

    this.hasPermissionForAuthGoogle = hasPermission(
      globalPermissions,
      permissions.enableAuthGoogle
    );

    this.hasPermissionForAuthOidc = hasPermission(
      globalPermissions,
      permissions.enableAuthOidc
    );

    this.hasPermissionForAuthToken = hasPermission(
      globalPermissions,
      permissions.enableAuthToken
    );

    this.hasPermissionForSubscription = hasPermission(
      globalPermissions,
      permissions.enableSubscription
    );

    this.hasPermissionToCreateUser = hasPermission(
      globalPermissions,
      permissions.createUserAccount
    );

    this.changeDetectorRef.markForCheck();
  }

  /**
   * `EMPTY` after the alert is what stops a rejected token exchange from reaching
   * the success branch; the alert is the whole of the failure handling.
   */
  public async openLoginDialog() {
    // Resolved on demand rather than imported at the top of the file. This dialog
    // carries the whole alternative-credential surface - the security-token field,
    // the Google anchor and the OpenID Connect anchor - and it is opened only when
    // a visitor asks to sign in, so a static reference would put all of it in the
    // initial bundle for every visitor. The application has a single route, so
    // there is no route boundary to do this for us.
    //
    // The load goes through the shared loader, which deduplicates concurrent
    // requests, reports a rejected chunk through the sanitized channel and tells the
    // visitor about it. The guard below is this card's own share of that: without it
    // a slow chunk could be pressed again and would stack a second dialog on the
    // first.
    if (this.isOpeningDialog) {
      return;
    }

    const GfLoginWithAccessTokenDialogComponent = await this.resolveDialog(
      'login-with-access-token-dialog',
      () =>
        import('@ghostfolio/client/components/login-with-access-token-dialog/login-with-access-token-dialog.component').then(
          (chunk) => {
            return chunk.GfLoginWithAccessTokenDialogComponent;
          }
        )
    );

    // Nothing to open, and nothing to say: the loader has already reported the
    // failure and told the visitor about it.
    if (!GfLoginWithAccessTokenDialogComponent) {
      return;
    }

    // The third type argument is what the dialog actually resolves with. Without
    // it `afterClosed()` yields `any`, and every read of the token below is an
    // unchecked one. The shape is the dialog's own: it closes with
    // `{ accessToken }` when a token was entered and with nothing otherwise,
    // which is exactly what the union states.
    // `InstanceType<typeof …>` rather than the bare class name: the dynamic
    // import binds a value, not a type alias, and this generic parameter wants
    // the component's instance type.
    const dialogRef = this.dialog.open<
      InstanceType<typeof GfLoginWithAccessTokenDialogComponent>,
      LoginWithAccessTokenDialogParams,
      { accessToken: string } | undefined
    >(GfLoginWithAccessTokenDialogComponent, {
      autoFocus: false,
      data: {
        accessToken: '',
        hasPermissionToUseAuthGoogle: this.hasPermissionForAuthGoogle,
        hasPermissionToUseAuthOidc: this.hasPermissionForAuthOidc,
        hasPermissionToUseAuthToken: this.hasPermissionForAuthToken,
        title: $localize`Sign in`
      },
      width: '30rem'
    });

    dialogRef
      .afterClosed()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((data) => {
        if (data?.accessToken) {
          this.dataService
            .loginAnonymous(data?.accessToken)
            .pipe(
              catchError(() => {
                this.notificationService.alert({
                  title: $localize`Oops! Incorrect Security Token.`
                });

                return EMPTY;
              }),
              takeUntilDestroyed(this.destroyRef)
            )
            .subscribe(({ authToken }) => {
              this.setToken(authToken);
            });
        }
      });
  }

  /**
   * Adopts a freshly created account's token, and handles the read of the viewer
   * it belongs to failing.
   *
   * The failure is not hypothetical and not benign: the token is persisted before
   * the viewer is read, so a request that never answers - an offline tab, a proxy
   * returning status 0 - leaves a stored credential with no viewer resolved
   * against it. The viewer store keeps whatever it last held on a failed forced
   * fetch, which while this prompt is on screen is nothing at all, so the canvas
   * is never told to leave the signed-out branch. The viewer sits looking at a
   * sign-in prompt for an account that exists, was just created, and whose token
   * is already in storage - with no control on screen that can retry, because
   * every control here creates or adopts a *new* credential rather than re-reading
   * the current one.
   *
   * Reloading is the remedy, for the same reason the shell reloads after adopting
   * a newly created account's token: it discards every in-memory cache and
   * restarts viewer resolution from the stored token, which is precisely the step
   * that failed. The message is written to the console rather than raised as an
   * alert because there is nothing for the viewer to decide - the recovery is
   * automatic - and it deliberately carries no response body, only the error
   * object the HTTP layer produced.
   *
   * The transition is announced first, in the same order the shell uses, so that
   * the interval between storing the token and resolving its viewer cannot
   * authorise a layout write. Writes reopen only when the canvas hydrates and
   * names the viewer that arrived.
   */
  public async openShowAccessTokenDialog() {
    // Resolved on demand for the same reason as the sign-in dialog above: this is
    // reached only when a visitor asks to create an account, so its graph stays
    // out of every visitor's initial bundle - and through the same shared loader,
    // for the same three reasons.
    if (this.isOpeningDialog) {
      return;
    }

    const GfUserAccountRegistrationDialogComponent = await this.resolveDialog(
      'user-account-registration-dialog',
      () =>
        import('@ghostfolio/client/components/user-account-registration-dialog/user-account-registration-dialog.component').then(
          (chunk) => {
            return chunk.GfUserAccountRegistrationDialogComponent;
          }
        )
    );

    if (!GfUserAccountRegistrationDialogComponent) {
      return;
    }
    // Resolves with the freshly issued token, or with nothing when the dialog is
    // cancelled - its template closes on `authToken` and on `undefined`
    // respectively - so the result is declared rather than inferred as `any`.
    // `InstanceType<typeof …>` rather than the bare class name: the dynamic
    // import binds a value, not a type alias, and this generic parameter wants
    // the component's instance type.
    const dialogRef = this.dialog.open<
      InstanceType<typeof GfUserAccountRegistrationDialogComponent>,
      UserAccountRegistrationDialogParams,
      string | undefined
    >(GfUserAccountRegistrationDialogComponent, {
      data: {
        deviceType: this.deviceType,
        needsToAcceptTermsOfService: this.hasPermissionForSubscription
      },
      disableClose: true,
      height: this.deviceType === 'mobile' ? '98vh' : undefined,
      width: this.deviceType === 'mobile' ? '100vw' : '30rem'
    });

    dialogRef
      .afterClosed()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((authToken) => {
        if (!authToken) {
          return;
        }

        this.dashboardLayoutService.beginIdentityTransition();

        this.tokenStorageService.saveToken(authToken, true);

        this.userService
          .get(true)
          .pipe(takeUntilDestroyed(this.destroyRef))
          .subscribe({
            error: (error) => {
              // Sanitized rather than raw, and with an identifier of its own so this
              // failure stays distinguishable from the token sign-in one below. Both
              // are credential-adjacent paths: an `HttpErrorResponse` carries the
              // request URL and the response body, and the console is readable by
              // every script on the page and captured verbatim by session-replay
              // tooling. A fixed event identifier and the numeric status are what an
              // operator can act on, and they are all that is emitted.
              reportSanitizedError(
                'GF-SIGN-IN-PROMPT-USER-CREATE-READ-FAILED',
                error
              );

              window.location.reload();
            }
          });
      });
  }

  /**
   * Persists a token using the stay-signed-in preference. A language change
   * requires document navigation because locales use distinct base paths.
   *
   * The read is forced. An unforced one is served from the viewer store whenever
   * it holds anything at all, and the whole point of this call is to resolve the
   * viewer belonging to the token that was stored one line above - a cached answer
   * would describe whoever was current before it.
   *
   * A failed read is handled for the same reason as in
   * {@link openShowAccessTokenDialog}, and it matters more here: this method is
   * the sole continuation of the token sign-in path, so without an error branch a
   * request that never answers leaves the token persisted, the viewer unresolved,
   * the canvas on its signed-out branch and no navigation performed - a prompt the
   * viewer cannot get past, for a credential that is already accepted. Reloading
   * restarts resolution from that stored token, which is exactly the step that
   * failed.
   */
  public setToken(aToken: string) {
    this.dashboardLayoutService.beginIdentityTransition();

    this.tokenStorageService.saveToken(
      aToken,
      this.settingsStorageService.getSetting(KEY_STAY_SIGNED_IN) === 'true'
    );

    this.userService
      .get(true)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        error: (error) => {
          // A distinct identifier for a distinct path: this one follows a token the
          // viewer supplied, so the failing request carries a credential the log
          // must never come near. Reported sanitized, exactly as the account-creation
          // path above is.
          reportSanitizedError(
            'GF-SIGN-IN-PROMPT-TOKEN-SIGN-IN-READ-FAILED',
            error
          );

          window.location.reload();
        },
        next: (user) => {
          const userLanguage = user?.settings?.language;

          if (userLanguage && document.documentElement.lang !== userLanguage) {
            window.location.href = `../${userLanguage}`;
          } else {
            // Voided deliberately rather than awaited. `/` is the route already
            // active, so the request resolves immediately and there is nothing to
            // sequence after it; the re-read of the viewer above is what the canvas
            // rehydrates from.
            void this.router.navigate(['/']);
          }
        }
      });
  }
  /**
   * Resolves a dialog component while both controls on this card report the wait.
   *
   * The pending flag is raised before the load and lowered however it settles, so a
   * failed chunk leaves the controls usable rather than permanently inert - the
   * loader releases its own entry the same way, and a visitor pressing the control
   * again genuinely tries again.
   *
   * @param aKey stable, data-free name of the dialog, used for deduplication and in
   * the sanitized failure report.
   * @param aLoad performs the dynamic import and picks the component out of it.
   * @returns the component, or `null` when the chunk could not be loaded - in which
   * case the visitor has already been told.
   */
  private async resolveDialog<T>(
    aKey: string,
    aLoad: () => Promise<T>
  ): Promise<T | null> {
    this.isOpeningDialog = true;

    this.changeDetectorRef.markForCheck();

    try {
      return await this.lazyDialogService.load(aKey, aLoad);
    } finally {
      // `finally`, so the controls are released even if the loader itself were ever
      // to throw rather than resolve with nothing.
      this.isOpeningDialog = false;

      this.changeDetectorRef.markForCheck();
    }
  }
}
