import { getCssVariable, isKnownDataSource } from '@ghostfolio/common/helper';
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
import {
  HoldingDetailDialogParams,
  HoldingDetailDialogResult
} from './components/holding-detail-dialog/interfaces/interfaces';
import { UserAccountRegistrationDialogParams } from './components/user-account-registration-dialog/interfaces/interfaces';
import { GfUserAccountRegistrationDialogComponent } from './components/user-account-registration-dialog/user-account-registration-dialog.component';
import { GfDashboardLayoutService } from './dashboard/services/dashboard-layout.service';
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
  public info: InfoItem;
  public user: User | undefined;

  private readonly changeDetectorRef = inject(ChangeDetectorRef);
  /**
   * Injected for exactly one reason: `onCreateAccount()` has to announce an
   * identity transition before it replaces the bearer token. No layout is read,
   * written or held here — the canvas owns all three.
   */
  private readonly dashboardLayoutService = inject(GfDashboardLayoutService);
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

  /**
   * The asset the holding detail dialog is currently open for, or `null`.
   *
   * The shell is mounted for the whole session and observes a URL that every placed
   * module writes to, so its query-parameter handler is re-notified constantly for
   * reasons that have nothing to do with it. This is what keeps those notifications
   * from stacking copies of a dialog that is already open, while still honouring a
   * request for a different asset.
   */
  private openedHoldingDetailAddress: string = null;

  public constructor() {
    this.initializeTheme();
    this.user = undefined;

    // Two dialogs are opened from here rather than from a module, and for the
    // same reason: each is requested from places that cannot know which modules a
    // viewer has placed - the shared holdings and accounts tables, the assistant,
    // the allocations charts - while the shell is the one thing that is always
    // mounted. Handling them here also means each opens exactly once, which a
    // module-level handler could not guarantee now that every module shares one
    // URL: two co-mounted modules reading the same flag opened two dialogs from a
    // single selection.
    this.route.queryParams
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(
        ({ dataSource, holdingDetailDialog, symbol }: GfAppQueryParams) => {
          // This is the one place where an asset identifier crosses from the
          // address bar into the application, so it is where that identifier is
          // vetted. Both members are declared as their domain types on
          // `GfAppQueryParams`, but a query parameter is a string a visitor
          // chose, and the compiler cannot enforce a claim made about it.
          if (
            holdingDetailDialog &&
            isKnownDataSource(dataSource) &&
            this.isUsableSymbol(symbol)
          ) {
            // Guarded against being told the same thing twice. Every producer on
            // this URL merges rather than replaces - it has to, or it would drop a
            // sibling module's parameters and the shared-portfolio identifier - so
            // this stream emits again whenever any module writes to the URL for a
            // reason of its own. Without the guard each of those emissions would
            // open a second copy of the dialog that is already up. Keyed on the
            // asset rather than held as a flag, so asking for a *different* holding
            // while one is open is still a genuine second request.
            const address = `${dataSource}:${symbol}`;

            if (this.openedHoldingDetailAddress !== address) {
              this.openedHoldingDetailAddress = address;

              this.openHoldingDetailDialog({
                dataSource,
                symbol
              });
            }
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

        // A promotion is not derived here. The one affordance that surfaces it
        // lives in the dashboard toolbar, which derives it from the same two
        // sources for itself; deriving it a second time in a shell that renders
        // nothing from it would be state with no reader.
        this.initializeTheme(this.user?.settings.colorScheme);

        this.changeDetectorRef.markForCheck();
      });
  }

  public onClickSystemMessage() {
    const systemMessage = this.user?.systemMessage;

    if (!systemMessage) {
      return;
    }

    // The message's optional `routerLink` is deliberately ignored: the
    // application resolves to a single route, so there is nothing to navigate to.
    this.notificationService.alert({
      title: systemMessage.message
    });
  }

  /**
   * The issued token is persisted with `staySignedIn` forced on, because a
   * freshly created account has no stay-signed-in setting to consult yet.
   *
   * This flow was migrated from the deleted register page, which was the only way
   * to create an account before the navigation surface collapsed onto a single
   * canvas. Three adaptations were required:
   *
   * - the token is persisted with `staySignedIn` forced on, matching the
   *   register page's deliberate decision not to consult the stay-signed-in
   *   setting for a freshly created account;
   * - the register page navigated to `/` afterwards. `/` is already the
   *   current — and only — route, so the navigation is replaced by a forced
   *   user re-fetch. That is what drives the `stateChanged` subscription above
   *   to recompute `canCreateAccount` and `hasInfoMessage`, which in turn
   *   dismisses the live-demo banner.
   *
   * The third is the consequential one, and it is what the collapsed route table
   * forces. The register page was a *screen*: adopting a token there
   * navigated away from it, so nothing belonging to whoever was looking before
   * survived. On one canvas there is nowhere to navigate to, so the dashboard
   * that was already on screen — and any arrangement change it had scheduled but
   * not yet written — would otherwise still be live while the new account's token
   * is the one authorising requests, and would write the previous viewer's layout
   * to the new account. Replacing the token is therefore performed as an explicit
   * identity transition, in this order:
   *
   * 1. announce it, which withdraws layout write authorisation, discards
   *    anything still pending and suspends the canvas;
   * 2. store the token;
   * 3. read the viewer it belongs to, which re-arms the canvas by hydrating it.
   *
   * A failed read is handled rather than ignored, because leaving it unhandled is
   * exactly the state that must not persist: the store keeps the previous viewer
   * on a failed forced fetch, so the canvas would go on showing their modules
   * under the new account's credential. Reloading discards every in-memory cache
   * and restarts resolution from the stored token — the same remedy, for the same
   * reason, as switching the impersonated identity.
   */
  public onCreateAccount() {
    // The third type argument is the token the dialog resolves with, or nothing
    // when it is cancelled - its template closes on `authToken` and on
    // `undefined` respectively. Declared rather than inferred, so the token is
    // read as a string instead of as `any`.
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

  /**
   * Whether a value taken from the address bar can be used as an asset symbol.
   *
   * Only emptiness is rejected, and that is a deliberate limit rather than an
   * oversight. Symbols are not drawn from a closed vocabulary — a manually
   * maintained asset carries whatever symbol its owner gave it, punctuation
   * included — so any character allowlist here would reject legitimate
   * holdings. What makes an arbitrary symbol safe to send is that the data
   * façade percent-encodes it into a single path segment; this check only keeps
   * a blank parameter from opening an empty dialog.
   */
  private isUsableSymbol(aValue: unknown): aValue is string {
    return typeof aValue === 'string' && aValue.trim().length > 0;
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

        const dialogRef = this.dialog.open<
          GfHoldingDetailDialogComponent,
          HoldingDetailDialogParams,
          HoldingDetailDialogResult | undefined
        >(GfHoldingDetailDialogComponent, {
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
          .subscribe((result) => {
            this.openedHoldingDetailAddress = null;

            // `dataSource` and `symbol` are shared, not owned. This dialog is the
            // only owner of `holdingDetailDialog`, so that key always goes; the pair
            // goes with it on an ordinary close and is deliberately left standing
            // when the dialog closed itself in order to hand the same asset on to
            // the market data administration module, which reads exactly that pair.
            // Clearing regardless is what previously left the administration module
            // with a request to open an asset profile dialog for no asset.
            void this.router.navigate([], {
              queryParams: result?.hasHandedOverAssetProfile
                ? { holdingDetailDialog: null }
                : {
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
