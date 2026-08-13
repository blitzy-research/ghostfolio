import { DashboardIntentService } from '@ghostfolio/client/core/dashboard-intent.service';
import { LayoutService } from '@ghostfolio/client/core/layout.service';
import { DashboardModuleType } from '@ghostfolio/client/dashboard/enums/dashboard-module-type';
import { GfDashboardLayoutService } from '@ghostfolio/client/dashboard/services/dashboard-layout.service';
import { ImpersonationStorageService } from '@ghostfolio/client/services/impersonation-storage.service';
import { UserService } from '@ghostfolio/client/services/user/user.service';
import type { UpdateUserSettingDto } from '@ghostfolio/common/dtos';
import { reportSanitizedError } from '@ghostfolio/common/helper';
import { Filter, InfoItem, User } from '@ghostfolio/common/interfaces';
import { hasPermission, permissions } from '@ghostfolio/common/permissions';
import { publicRoutes } from '@ghostfolio/common/routes/routes';
import { ColorScheme, DateRange } from '@ghostfolio/common/types';
import { GfAssistantComponent } from '@ghostfolio/ui/assistant/assistant.component';
import { GfLogoComponent } from '@ghostfolio/ui/logo';
import { NotificationService } from '@ghostfolio/ui/notifications';
import { GfPremiumIndicatorComponent } from '@ghostfolio/ui/premium-indicator';
import { DataService } from '@ghostfolio/ui/services';

import { CommonModule } from '@angular/common';
import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  CUSTOM_ELEMENTS_SCHEMA,
  DestroyRef,
  HostListener,
  Input,
  OnInit,
  ViewChild
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { MatBadgeModule } from '@angular/material/badge';
import { MatButtonModule } from '@angular/material/button';
import { MatMenuModule, MatMenuTrigger } from '@angular/material/menu';
import { MatToolbarModule } from '@angular/material/toolbar';
import { IonIcon } from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import {
  closeOutline,
  menuOutline,
  optionsOutline,
  personCircleOutline,
  radioButtonOffOutline,
  radioButtonOnOutline
} from 'ionicons/icons';
import { DeviceDetectorService } from 'ngx-device-detector';

/**
 * Non-navigational control bar for the single-canvas dashboard: the assistant,
 * the date range, the portfolio filters, identity switching, signing out, and
 * the promotion derivation behind the premium indicator. Every one of them acts
 * in place, and nothing here addresses a screen - no link directive is
 * imported, no route constant is read and no router is injected. The single
 * address that survives leaves the application altogether, for the externally
 * hosted plan page.
 *
 * Access-token sign-in is deliberately absent. It belongs to the signed-out
 * state, which on this canvas is `GfSignInPromptComponent` - owner of the
 * dialog, the token exchange and the stay-signed-in preference. This bar
 * renders only for a resolved viewer, so a sign-in control here would be an
 * unreachable second copy of a flow that must have exactly one. The one dialog
 * this class does open belongs to signing out, reporting on the way that the
 * last arrangement could not be stored.
 *
 * Appearance is likewise not this bar's to change: `colorScheme` has three
 * states, the third being "follow the operating system", so a single toggle
 * icon could only ever offer two of the three and would quietly take the
 * system-following state away from whoever pressed it. Applying the theme stays
 * the shell's job and choosing it stays the account settings module's.
 *
 * It takes no inputs and emits no outputs - every value is resolved here from
 * the service that owns it - and holds no layout state: cell coordinates, cell
 * sizes and catalog visibility belong to the canvas, and no arrangement is
 * saved from here. {@link onSelectModule} forwards a discriminator onto the
 * intent bus without resolving it, because resolving one is the module
 * registry's job.
 */
@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    CommonModule,
    GfAssistantComponent,
    GfLogoComponent,
    GfPremiumIndicatorComponent,
    IonIcon,
    MatBadgeModule,
    MatButtonModule,
    MatMenuModule,
    MatToolbarModule
  ],
  schemas: [CUSTOM_ELEMENTS_SCHEMA],
  selector: 'gf-dashboard-toolbar',
  styleUrls: ['./dashboard-toolbar.scss'],
  templateUrl: './dashboard-toolbar.html'
})
export class GfDashboardToolbarComponent implements OnInit {
  /**
   * Whether a refresh of every placed module is currently running.
   *
   * An input rather than state of this bar's own, because the request travels one
   * way: this bar publishes it onto the shared reload bus and the canvas is what
   * knows when the last module has finished. Bound to the control's disabled and
   * busy states so a refresh cannot be started twice and does not look untouched
   * while it runs.
   */
  @Input() isRefreshing = false;

  @ViewChild('assistant') assistantElement: GfAssistantComponent;
  @ViewChild('assistantTrigger') assistentMenuTriggerElement: MatMenuTrigger;

  public readonly accountLabel = $localize`Account`;

  /**
   * The three appearance choices, in the order the account-settings screen has
   * always listed them.
   *
   * The wordings are the same three source messages that screen already uses, which
   * is deliberate and is what keeps all twelve locales translated: an Angular message
   * id is a hash of the text, so `Auto`, `Light` and `Dark` written here resolve to
   * the units those options resolve to rather than introducing three new ones.
   *
   * Declared as data rather than three copies of the same markup, so the row, its
   * radio state and its glyph are written once and cannot drift between the options.
   */
  public readonly colorSchemeOptions: {
    label: string;
    value: ColorScheme | null;
  }[] = [
    { label: $localize`Auto`, value: null },
    { label: $localize`Light`, value: 'LIGHT' },
    { label: $localize`Dark`, value: 'DARK' }
  ];

  public deviceType: string;
  public hasFilters: boolean;

  public readonly impersonationStatusLabel = $localize`Viewing another account`;

  /**
   * The assistant button's name, in each of the two states its badge distinguishes.
   *
   * The badge is a dot rather than a count, and a description ON the badge is the wrong
   * place for the state: a fixed one is announced even while the dot is suppressed,
   * because suppression is presentational. Naming the BUTTON instead means the state is
   * re-announced whenever it changes and disappears with the dot, and it needs no second
   * element to carry it.
   *
   * Two whole sentences rather than one with a fragment appended, because a translator
   * needs the complete string to order it naturally.
   */
  public readonly assistantLabel = $localize`Assistant`;

  public readonly assistantWithFiltersLabel = $localize`Assistant, filters are in force`;

  public hasImpersonationId: boolean;
  public hasPermissionForSubscription: boolean;
  public hasPermissionToAccessAdminControl: boolean;
  public hasPermissionToAccessAssistant: boolean;
  public hasPermissionToChangeDateRange: boolean;
  public hasPermissionToChangeFilters: boolean;
  public hasPromotion: boolean;
  public impersonationId: string;
  public isMenuOpen: boolean;
  public pricingUrl: string;
  public user: User;

  private info: InfoItem;

  public constructor(
    private changeDetectorRef: ChangeDetectorRef,
    private dashboardIntentService: DashboardIntentService,

    // Injected for one purpose only: signing out has to release the debounced
    // write before the document is replaced. See {@link onSignOut}.
    private dashboardLayoutService: GfDashboardLayoutService,
    private dataService: DataService,
    private destroyRef: DestroyRef,
    private deviceService: DeviceDetectorService,
    private impersonationStorageService: ImpersonationStorageService,
    private layoutService: LayoutService,

    // Used only to report a failed release on the way out, so a viewer is never
    // told their arrangement was stored when it was not.
    private notificationService: NotificationService,
    private userService: UserService
  ) {
    this.impersonationStorageService
      .onChangeHasImpersonation()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((impersonationId) => {
        this.hasImpersonationId = !!impersonationId;
        this.impersonationId = impersonationId;
      });

    addIcons({
      closeOutline,
      menuOutline,
      optionsOutline,
      personCircleOutline,
      radioButtonOffOutline,
      radioButtonOnOutline
    });

    this.userService.stateChanged
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((state) => {
        this.user = state.user;

        this.releaseUnheldImpersonation();

        this.hasFilters = this.userService.hasFilters();

        this.hasPermissionToAccessAdminControl = hasPermission(
          this.user?.permissions,
          permissions.accessAdminControl
        );

        this.hasPermissionToAccessAssistant = hasPermission(
          this.user?.permissions,
          permissions.accessAssistant
        );

        this.hasPermissionToChangeDateRange = !!this.user;
        this.hasPermissionToChangeFilters = !!this.user;

        // Derived from the viewer's own subscription where there is one, and
        // from the deployment's offer otherwise, so the badge is right both
        // before and after a viewer resolves.
        this.hasPromotion = this.user
          ? !!this.user.subscription?.offer?.coupon ||
            !!this.user.subscription?.offer?.durationExtension
          : !!this.info?.subscriptionOffer?.coupon ||
            !!this.info?.subscriptionOffer?.durationExtension;

        if (this.user) {
          const languageCode = this.user.settings.language;

          // An absolute, externally hosted address rather than an
          // in-application one: the plan page is not part of this application.
          this.pricingUrl = `https://ghostfol.io/${languageCode}/${publicRoutes.pricing.path}`;
        }

        this.changeDetectorRef.markForCheck();
      });
  }

  // Bound on the window so the hotkey works wherever focus is, and suppressed
  // while focus is in a text field so typing a slash still types a slash.
  @HostListener('window:keydown', ['$event'])
  public openAssistantWithHotKey(event: KeyboardEvent) {
    if (
      event.key === '/' &&
      event.target instanceof Element &&
      event.target?.nodeName?.toLowerCase() !== 'input' &&
      event.target?.nodeName?.toLowerCase() !== 'textarea' &&
      this.hasPermissionToAccessAssistant
    ) {
      this.assistantElement.setIsOpen(true);
      this.assistentMenuTriggerElement.openMenu();

      event.preventDefault();
    }
  }

  public ngOnInit() {
    this.info = this.dataService.fetchInfo();

    this.deviceType = this.deviceService.getDeviceInfo().deviceType;

    this.hasPermissionForSubscription = hasPermission(
      this.info.globalPermissions,
      permissions.enableSubscription
    );

    this.changeDetectorRef.markForCheck();
  }

  public closeAssistant() {
    this.assistentMenuTriggerElement?.closeMenu();
  }

  // A full reload rather than a re-fetch: impersonation changes what every
  // request returns, and every module already mounted holds data read as the
  // previous identity.
  public impersonateAccount(aId: string) {
    if (aId) {
      this.impersonationStorageService.setId(aId);
    } else {
      this.impersonationStorageService.removeId();
    }

    window.location.reload();
  }

  /**
   * Stores the viewer's appearance choice, or clears it for `Auto`.
   *
   * `null` is a value here rather than a missing one: it is how the absence of a
   * preference is stored, and it is what puts the canvas back under the operating
   * system's control. The setting DTO marks the field optional, which in
   * `class-validator` means `null` passes untouched rather than being rejected - the
   * account-settings screen has always cleared it the same way.
   *
   * The theme is not applied here. The shell paints from the viewer's `colorScheme`
   * whenever the viewer changes, so re-reading the viewer is what makes the choice
   * visible - and it is also what keeps the module hosting the same setting in step,
   * rather than leaving two controls disagreeing about what is stored.
   */
  public onChangeColorScheme(aColorScheme: ColorScheme | null) {
    this.dataService
      .putUserSetting({ colorScheme: aColorScheme })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => {
        this.userService
          .get(true)
          .pipe(takeUntilDestroyed(this.destroyRef))
          .subscribe();
      });
  }

  public onDateRangeChange(dateRange: DateRange) {
    this.dataService
      .putUserSetting({ dateRange })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => {
        this.userService
          .get(true)
          .pipe(takeUntilDestroyed(this.destroyRef))
          .subscribe();
      });
  }

  public onFiltersChanged(filters: Filter[]) {
    const userSetting: UpdateUserSettingDto = {};

    for (const filter of filters) {
      if (filter.type === 'ACCOUNT') {
        userSetting['filters.accounts'] = filter.id ? [filter.id] : null;
      } else if (filter.type === 'ASSET_CLASS') {
        userSetting['filters.assetClasses'] = filter.id ? [filter.id] : null;
      } else if (filter.type === 'DATA_SOURCE') {
        userSetting['filters.dataSource'] = filter.id ? filter.id : null;
      } else if (filter.type === 'SYMBOL') {
        userSetting['filters.symbol'] = filter.id ? filter.id : null;
      } else if (filter.type === 'TAG') {
        userSetting['filters.tags'] = filter.id ? [filter.id] : null;
      }
    }

    this.dataService
      .putUserSetting(userSetting)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => {
        this.userService
          .get(true)
          .pipe(takeUntilDestroyed(this.destroyRef))
          .subscribe();
      });
  }

  // Refreshes what the viewer has placed rather than navigating anywhere: the
  // canvas answers this bus by re-mounting every mounted module. Guarded on the
  // busy state as well as disabled in the template, because a control can be
  // activated by a keyboard while a browser is still applying the disabled
  // attribute, and a second publication would restart a refresh already running.
  public onLogoClick() {
    if (this.isRefreshing) {
      return;
    }

    this.layoutService.getShouldReloadSubject().next();
  }

  /**
   * Drops a stored impersonation the viewer no longer holds a grant for.
   *
   * The indicator said "Viewing another account" for as long as an identifier sat
   * in local storage, and nothing ever checked that the identifier still meant
   * anything. It routinely stops meaning something: the grant is the other
   * account's to revoke, and the server answers an identifier it cannot honour by
   * simply serving the viewer's OWN data - with no error and no status to react to.
   * So the viewer was looking at their own dashboard while being told, in the
   * toolbar and in the account menu, that they were looking at somebody else's.
   *
   * The check is against the very list the menu offers, which is the right
   * authority for it: an identifier that is not among the viewer's grants is one
   * the server will not honour either. It runs on every viewer emission rather than
   * once, because a grant can be revoked while the canvas is up.
   *
   * Deliberately silent about the grants not having ARRIVED. `access` is absent
   * until the viewer is read, and treating that as "not held" would clear a
   * perfectly good impersonation on every boot.
   *
   * The permission exemption is not a loosening of the check, it is the other half
   * of the same server-side predicate: a viewer who may impersonate everybody is
   * honoured on a bare account identifier, which is what the user administration
   * module stores and which is deliberately NOT a grant identifier. Without the
   * exemption this method would revoke exactly the impersonation that works.
   */
  private releaseUnheldImpersonation() {
    const impersonationId = this.impersonationStorageService.getId();

    if (!impersonationId || !this.user?.access) {
      return;
    }

    if (hasPermission(this.user.permissions, permissions.impersonateAllUsers)) {
      return;
    }

    const isHeld = this.user.access.some(({ id }) => id === impersonationId);

    if (isHeld) {
      return;
    }

    // No reload, and that is the point: the requests this page has already made
    // were served as the viewer themselves, so what is on screen is already
    // correct. Only the claim that it is not needs withdrawing.
    this.impersonationStorageService.removeId();
  }

  public onMenuClosed() {
    this.isMenuOpen = false;
  }

  public onMenuOpened() {
    this.isMenuOpen = true;
  }

  public onOpenAssistant() {
    this.assistantElement.initialize();
  }

  // Published as a bare discriminator onto the neutral intent bus. This bar
  // neither resolves a module nor knows whether one is placed - the canvas
  // reveals it or places it, and the registry resolves it.
  public onSelectModule(moduleType: DashboardModuleType) {
    this.dashboardIntentService.getRevealModuleSubject().next(moduleType);
  }

  /**
   * Releases the debounced layout write BEFORE the document is replaced, and
   * waits for it. Signing out replaces the whole document, so nothing scheduled
   * for the end of a quiet period would ever run: a change made in the last
   * debounce window would be lost with no request, no error and no retry.
   *
   * A failed release is reported rather than swallowed, and the departure still
   * happens once the viewer has acknowledged it - refusing to sign out because
   * a layout write failed would be the wrong trade.
   */
  public onSignOut() {
    this.dashboardLayoutService.releasePendingSave().subscribe({
      complete: () => {
        this.leaveForLocaleRoot();
      },
      error: (error: unknown) => {
        reportSanitizedError(
          'GF-DASHBOARD-LAYOUT-SIGN-OUT-FLUSH-FAILED',
          error
        );

        this.notificationService.alert({
          discardFn: () => {
            this.leaveForLocaleRoot();
          },
          message: $localize`Your most recent dashboard changes could not be saved.`,
          title: $localize`Oops! Something went wrong.`
        });
      }
    });
  }

  // A hard document navigation rather than a router call: the locale prefix is
  // part of the deployed base href, so returning to the locale root means
  // replacing the document.
  private leaveForLocaleRoot() {
    this.userService.signOut();

    document.location.href = `/${document.documentElement.lang}`;
  }
}
