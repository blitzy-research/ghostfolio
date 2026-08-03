import { getCssVariable } from '@ghostfolio/common/helper';
import { InfoItem, User } from '@ghostfolio/common/interfaces';
import { hasPermission, permissions } from '@ghostfolio/common/permissions';
import { ColorScheme } from '@ghostfolio/common/types';
import { NotificationService } from '@ghostfolio/ui/notifications';
import { DataService } from '@ghostfolio/ui/services';

import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  DestroyRef,
  DOCUMENT,
  HostBinding,
  inject,
  OnInit
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { MatDialog } from '@angular/material/dialog';
import { ActivatedRoute, Router, RouterOutlet } from '@angular/router';
import { DataSource } from '@prisma/client';
import { addIcons } from 'ionicons';
import { openOutline } from 'ionicons/icons';
import { DeviceDetectorService } from 'ngx-device-detector';

import { GfHoldingDetailDialogComponent } from './components/holding-detail-dialog/holding-detail-dialog.component';
import { UserAccountRegistrationDialogParams } from './components/user-account-registration-dialog/interfaces/interfaces';
import { GfUserAccountRegistrationDialogComponent } from './components/user-account-registration-dialog/user-account-registration-dialog.component';
import { GfAppQueryParams } from './interfaces/interfaces';
import { ImpersonationStorageService } from './services/impersonation-storage.service';
import { TokenStorageService } from './services/token-storage.service';
import { UserService } from './services/user/user.service';

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterOutlet],
  selector: 'gf-root',
  styleUrls: ['./app.component.scss'],
  templateUrl: './app.component.html'
})
export class GfAppComponent implements OnInit {
  public canCreateAccount: boolean;
  public deviceType: string;
  public hasImpersonationId: boolean;
  public hasInfoMessage: boolean;
  public hasPermissionForSubscription: boolean;
  public hasPromotion = false;
  public info: InfoItem;
  public user: User | undefined;

  private readonly changeDetectorRef = inject(ChangeDetectorRef);
  private readonly dataService = inject(DataService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly deviceService = inject(DeviceDetectorService);
  private readonly dialog = inject(MatDialog);
  private readonly document = inject(DOCUMENT);
  private readonly impersonationStorageService = inject(
    ImpersonationStorageService
  );
  private readonly notificationService = inject(NotificationService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly tokenStorageService = inject(TokenStorageService);
  private readonly userService = inject(UserService);

  public constructor() {
    this.initializeTheme();
    this.user = undefined;

    this.route.queryParams
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(
        ({ dataSource, holdingDetailDialog, symbol }: GfAppQueryParams) => {
          if (dataSource && holdingDetailDialog && symbol) {
            this.openHoldingDetailDialog({
              dataSource,
              symbol
            });
          }
        }
      );

    addIcons({ openOutline });
  }

  @HostBinding('class.has-info-message') get getHasMessage() {
    return this.hasInfoMessage;
  }

  public ngOnInit() {
    this.deviceType = this.deviceService.getDeviceInfo().deviceType;
    this.info = this.dataService.fetchInfo();

    // Gates the terms-of-service step of the registration dialog. This
    // derivation used to live on the register page, which owned the account
    // creation flow before the shell absorbed it (see `onCreateAccount`).
    this.hasPermissionForSubscription = hasPermission(
      this.info?.globalPermissions,
      permissions.enableSubscription
    );

    this.impersonationStorageService
      .onChangeHasImpersonation()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((impersonationId) => {
        this.hasImpersonationId = !!impersonationId;
      });

    this.userService.stateChanged
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((state) => {
        this.user = state.user;

        this.canCreateAccount = hasPermission(
          this.user?.permissions,
          permissions.createUserAccount
        );

        this.hasInfoMessage =
          this.canCreateAccount || !!this.user?.systemMessage;

        this.hasPromotion = this.user
          ? !!this.user.subscription?.offer?.coupon ||
            !!this.user.subscription?.offer?.durationExtension
          : !!this.info?.subscriptionOffer?.coupon ||
            !!this.info?.subscriptionOffer?.durationExtension;

        this.initializeTheme(this.user?.settings.colorScheme);

        this.changeDetectorRef.markForCheck();
      });
  }

  public onClickSystemMessage() {
    const systemMessage = this.user?.systemMessage;

    if (!systemMessage) {
      return;
    }

    // A system message is surfaced exclusively through the notification
    // service. Its optional `routerLink` is deliberately ignored: on a
    // single-canvas shell there is no screen to navigate to, so honouring it
    // would resolve to a route that no longer exists.
    this.notificationService.alert({
      title: systemMessage.message
    });
  }

  /**
   * Opens the account registration dialog and, once an access token has been
   * issued, adopts it for the current session.
   *
   * This flow was migrated verbatim from the deleted register page, which was
   * the only way to create an account before the navigation surface collapsed
   * onto a single canvas. Two adaptations were required:
   *
   * - the token is persisted with `staySignedIn` forced on, matching the
   *   register page's deliberate decision not to consult the stay-signed-in
   *   setting for a freshly created account;
   * - the register page navigated to `/` afterwards. `/` is already the
   *   current — and only — route, so the navigation is replaced by a forced
   *   user re-fetch. That is what drives the `stateChanged` subscription above
   *   to recompute `canCreateAccount`, `hasInfoMessage` and `hasPromotion`,
   *   which in turn dismisses the live-demo banner.
   */
  public onCreateAccount() {
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

  public onSignOut() {
    this.userService.signOut();

    document.location.href = `/${document.documentElement.lang}`;
  }

  private initializeTheme(userPreferredColorScheme?: ColorScheme) {
    const isDarkTheme = userPreferredColorScheme
      ? userPreferredColorScheme === 'DARK'
      : window.matchMedia('(prefers-color-scheme: dark)').matches;

    this.toggleTheme(isDarkTheme);

    window.matchMedia('(prefers-color-scheme: dark)').addListener((event) => {
      if (!this.user?.settings.colorScheme) {
        this.toggleTheme(event.matches);
      }
    });
  }

  private openHoldingDetailDialog({
    dataSource,
    symbol
  }: {
    dataSource: DataSource;
    symbol: string;
  }) {
    this.userService
      .get()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((user) => {
        this.user = user;

        const dialogRef = this.dialog.open(GfHoldingDetailDialogComponent, {
          autoFocus: false,
          data: {
            dataSource,
            symbol,
            baseCurrency: this.user?.settings?.baseCurrency,
            colorScheme: this.user?.settings?.colorScheme,
            deviceType: this.deviceType,
            hasImpersonationId: this.hasImpersonationId,
            hasPermissionToAccessAdminControl: hasPermission(
              this.user?.permissions,
              permissions.accessAdminControl
            ),
            hasPermissionToCreateActivity:
              !this.hasImpersonationId &&
              hasPermission(
                this.user?.permissions,
                permissions.createActivity
              ) &&
              !this.user?.settings?.isRestrictedView,
            hasPermissionToReportDataGlitch: hasPermission(
              this.user?.permissions,
              permissions.reportDataGlitch
            ),
            hasPermissionToUpdateActivity:
              !this.hasImpersonationId &&
              hasPermission(
                this.user?.permissions,
                permissions.updateActivity
              ) &&
              !this.user?.settings?.isRestrictedView,
            locale: this.user?.settings?.locale
          },
          height: this.deviceType === 'mobile' ? '98vh' : '80vh',
          width: this.deviceType === 'mobile' ? '100vw' : '50rem'
        });

        dialogRef
          .afterClosed()
          .pipe(takeUntilDestroyed(this.destroyRef))
          .subscribe(() => {
            void this.router.navigate([], {
              queryParams: {
                dataSource: null,
                holdingDetailDialog: null,
                symbol: null
              },
              queryParamsHandling: 'merge',
              relativeTo: this.route
            });
          });
      });
  }

  private toggleTheme(isDarkTheme: boolean) {
    const themeColor = getCssVariable(
      isDarkTheme ? '--dark-background' : '--light-background'
    );

    if (isDarkTheme) {
      this.document.body.classList.add('theme-dark');
      this.document.body.classList.remove('theme-light');
    } else {
      this.document.body.classList.add('theme-light');
      this.document.body.classList.remove('theme-dark');
    }

    this.document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute('content', themeColor);
  }
}
