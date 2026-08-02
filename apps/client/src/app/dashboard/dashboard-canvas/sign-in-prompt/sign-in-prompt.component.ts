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
   * Opens the shared sign-in dialog. Keep localized message text stable to
   * preserve translation IDs; EMPTY consumes a failed token exchange after the
   * alert.
   */
  public openLoginDialog() {
    const dialogRef = this.dialog.open<
      GfLoginWithAccessTokenDialogComponent,
      LoginWithAccessTokenDialogParams
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
   * Opens registration, persists the returned token, and refetches the user so
   * authenticated state updates without relying on navigation.
   */
  public openShowAccessTokenDialog() {
    const dialogRef = this.dialog.open<
      GfUserAccountRegistrationDialogComponent,
      UserAccountRegistrationDialogParams
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
        if (authToken) {
          this.tokenStorageService.saveToken(authToken, true);

          this.userService
            .get(true)
            .pipe(takeUntilDestroyed(this.destroyRef))
            .subscribe();
        }
      });
  }

  /**
   * Persists a token using the stay-signed-in preference. A language change
   * requires document navigation because locales use distinct base paths.
   */
  public setToken(aToken: string) {
    this.tokenStorageService.saveToken(
      aToken,
      this.settingsStorageService.getSetting(KEY_STAY_SIGNED_IN) === 'true'
    );

    this.userService
      .get()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((user) => {
        const userLanguage = user?.settings?.language;

        if (userLanguage && document.documentElement.lang !== userLanguage) {
          window.location.href = `../${userLanguage}`;
        } else {
          this.router.navigate(['/']);
        }
      });
  }
}
