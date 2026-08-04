import { LoginWithAccessTokenDialogParams } from '@ghostfolio/client/components/login-with-access-token-dialog/interfaces/interfaces';
import { GfLoginWithAccessTokenDialogComponent } from '@ghostfolio/client/components/login-with-access-token-dialog/login-with-access-token-dialog.component';
import { UserAccountRegistrationDialogParams } from '@ghostfolio/client/components/user-account-registration-dialog/interfaces/interfaces';
import { GfUserAccountRegistrationDialogComponent } from '@ghostfolio/client/components/user-account-registration-dialog/user-account-registration-dialog.component';
import {
  KEY_STAY_SIGNED_IN,
  SettingsStorageService
} from '@ghostfolio/client/services/settings-storage.service';
import { TokenStorageService } from '@ghostfolio/client/services/token-storage.service';
import { UserService } from '@ghostfolio/client/services/user/user.service';
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
  public deviceType: string;

  public hasPermissionForAuthGoogle: boolean;

  public hasPermissionForAuthOidc: boolean;

  public hasPermissionForAuthToken: boolean;

  public hasPermissionForSubscription: boolean;

  public hasPermissionToCreateUser: boolean;

  public constructor(
    private changeDetectorRef: ChangeDetectorRef,
    private dashboardLayoutService: GfDashboardLayoutService,
    private dataService: DataService,
    private destroyRef: DestroyRef,
    private deviceService: DeviceDetectorService,
    private dialog: MatDialog,
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
  public openLoginDialog() {
    // The third type argument is what the dialog actually resolves with. Without
    // it `afterClosed()` yields `any`, and every read of the token below is an
    // unchecked one. The shape is the dialog's own: it closes with
    // `{ accessToken }` when a token was entered and with nothing otherwise,
    // which is exactly what the union states.
    const dialogRef = this.dialog.open<
      GfLoginWithAccessTokenDialogComponent,
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
  public openShowAccessTokenDialog() {
    // Resolves with the freshly issued token, or with nothing when the dialog is
    // cancelled - its template closes on `authToken` and on `undefined`
    // respectively - so the result is declared rather than inferred as `any`.
    const dialogRef = this.dialog.open<
      GfUserAccountRegistrationDialogComponent,
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
              console.error(
                'Failed to read the newly created user account',
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
          console.error('Failed to read the signed-in user account', error);

          window.location.reload();
        },
        next: (user) => {
          const userLanguage = user?.settings?.language;

          if (userLanguage && document.documentElement.lang !== userLanguage) {
            window.location.href = `../${userLanguage}`;
          } else {
            // Voided deliberately rather than awaited. The request is already
            // satisfied on the collapsed route table, so it resolves immediately
            // and there is nothing to sequence after it; the re-read of the viewer
            // above is what the canvas rehydrates from.
            void this.router.navigate(['/']);
          }
        }
      });
  }
}
