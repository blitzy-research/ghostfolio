import { DashboardIntentService } from '@ghostfolio/client/core/dashboard-intent.service';
import { LayoutService } from '@ghostfolio/client/core/layout.service';
import { DashboardModuleType } from '@ghostfolio/client/dashboard/enums/dashboard-module-type';
import { ImpersonationStorageService } from '@ghostfolio/client/services/impersonation-storage.service';
import { UserService } from '@ghostfolio/client/services/user/user.service';
import type { UpdateUserSettingDto } from '@ghostfolio/common/dtos';
import { Filter, InfoItem, User } from '@ghostfolio/common/interfaces';
import { hasPermission, permissions } from '@ghostfolio/common/permissions';
import { publicRoutes } from '@ghostfolio/common/routes/routes';
import { ColorScheme, DateRange } from '@ghostfolio/common/types';
import { GfAssistantComponent } from '@ghostfolio/ui/assistant/assistant.component';
import { GfLogoComponent } from '@ghostfolio/ui/logo';
import { GfPremiumIndicatorComponent } from '@ghostfolio/ui/premium-indicator';
import { DataService } from '@ghostfolio/ui/services';

import { CommonModule } from '@angular/common';
import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  CUSTOM_ELEMENTS_SCHEMA,
  DestroyRef,
  DOCUMENT,
  HostListener,
  Inject,
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
  moonOutline,
  optionsOutline,
  personCircleOutline,
  radioButtonOffOutline,
  radioButtonOnOutline,
  sunnyOutline
} from 'ionicons/icons';
import { DeviceDetectorService } from 'ngx-device-detector';

/**
 * Non-navigational control bar for the single-canvas dashboard: the assistant, the
 * date range, the portfolio filters, identity switching, access-token sign-in,
 * signing out, and the promotion derivation behind the premium indicator. Every one
 * of them acts in place, and nothing here addresses a screen.
 *
 * The application now resolves to one canvas, so the page chrome that used to
 * select a screen has no remaining job. What it did carry, besides navigation,
 * were capabilities that are not navigational at all, and the ones a signed-in
 * viewer needs are rehomed here unchanged: the assistant, the date range, the
 * portfolio filters, identity switching and signing out - plus the promotion
 * badge and the premium indicator that sat alongside them. Every one of them
 * acts in place. Nothing here addresses a screen.
 *
 * Access-token sign-in is the one capability of the deleted chrome that is
 * deliberately absent, and its absence is not a gap. In the chrome it lived
 * exclusively in the signed-out branch, alongside "Get Started" - there was
 * nothing to sign in to while already signed in - and on this canvas that branch
 * is `GfSignInPromptComponent`, which owns the dialog, the token exchange and the
 * stay-signed-in preference. This bar renders only for a resolved viewer, so a
 * sign-in control here could never be reached; carrying one would be an
 * unreachable second copy of a flow that must have exactly one.
 *
 * Access-token sign-in is the one rescued capability deliberately not carried
 * here. In the chrome this bar replaces it was rendered inside the signed-out
 * branch only; on the canvas that branch is a sibling component mounted instead
 * of the canvas body, and the flow lives there in full. A second copy on a bar
 * that renders only once a viewer has resolved would be unreachable, so this
 * class holds no sign-in dialog, no token storage and no notification surface.
 *
 * It takes no inputs and emits no outputs - every value is resolved here from the
 * service that owns it - and holds no layout state: cell coordinates, cell sizes
 * and catalog visibility belong to the canvas, and no arrangement is saved from
 * here. {@link onSelectModule} forwards a discriminator onto the intent bus without
 * resolving it, because resolving one is the module registry's job.
 *
 * - **Nothing here addresses a screen.** No in-application link directive is
 *   imported, no route constant is read, and no router is injected. The single
 *   address that survives leaves this application altogether, for the externally
 *   hosted plan page, so it is an ordinary absolute target (`pricingUrl`).
 * - **No inputs and no outputs.** The values the deleted chrome received from
 *   the shell were derived from the URL, and the shell no longer derives them
 *   because there is no longer a route table to derive them from. Everything is
 *   therefore resolved here, from the services that own it. The canvas mounts
 *   `<gf-dashboard-toolbar />` and passes nothing.
 * - **No layout state.** Cell coordinates, cell sizes and catalog visibility
 *   belong to the canvas that mounts this component. None of them is read or
 *   written here, and no arrangement is ever saved from here.
 * - **No module registration.** {@link onSelectModule} forwards a module
 *   discriminator onto a neutral intent bus without resolving it. Resolving a
 *   discriminator to a component is the module registry's responsibility.
 *
 * Only the signed-in half of the former chrome lives here; the signed-out state
 * is the sibling component the canvas renders instead of the canvas body. The
 * template's `@if (user)` guard is still required, because the viewer is
 * resolved asynchronously and the bar has to render as empty chrome until it
 * arrives rather than fault on the first pass. It is also why every member here
 * is reachable from that template: a capability with no control on it would be
 * dead weight, and the one that was has been removed rather than left behind.
 *
 * Every visible chrome value - surface colour, glyph metric, dark-theme mirror -
 * lives in `dashboard-toolbar.scss` as a Material 3 system token with a
 * repository-traceable fallback. This class carries no presentational literal.
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
  @ViewChild('assistant') assistantElement: GfAssistantComponent;
  @ViewChild('assistantTrigger') assistentMenuTriggerElement: MatMenuTrigger;

  /**
   * The two names the appearance control takes, one per direction.
   *
   * Held here rather than declared on the element because `i18n-aria-label`
   * localizes only a STATIC attribute; the name has to change with the current
   * appearance, so it is bound, and a bound attribute has to be localized in code.
   *
   * Both name the action rather than the state, so the control reads as a command
   * in either direction. They are separate messages rather than one with an
   * interpolated word, because a translator needs the whole sentence to inflect it.
   */
  public readonly darkAppearanceLabel = $localize`Switch to dark appearance`;

  public deviceType: string;
  public hasFilters: boolean;
  /**
   * Whether the dark appearance is the one currently painted.
   *
   * Read from the class the shell maintains on `<body>`, deliberately, because that
   * class IS the effective answer. The setting alone cannot give it: `colorScheme`
   * is allowed to be unset, and an unset one means "follow the operating system" -
   * so deciding from the setting would require this component to repeat the shell's
   * media-query fallback and then keep the copy in step with it. Reading what the
   * shell decided instead leaves exactly one place that resolves the appearance.
   *
   * Refreshed on every emission of the viewer's record, which is precisely when the
   * shell re-applies the theme, so the icon and the label can never describe a
   * previous appearance.
   */
  public isDarkTheme: boolean;

  /** Companion of {@link darkAppearanceLabel} for the other direction. */
  public readonly lightAppearanceLabel = $localize`Switch to light appearance`;
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

  /**
   * Deployment-wide capabilities and the fallback promotion offer. Held rather
   * than re-read because `DataService.fetchInfo()` deep-clones on every call.
   */
  private info: InfoItem;

  public constructor(
    private changeDetectorRef: ChangeDetectorRef,
    private dashboardIntentService: DashboardIntentService,
    private dataService: DataService,
    private destroyRef: DestroyRef,
    private deviceService: DeviceDetectorService,
    @Inject(DOCUMENT) private document: Document,
    private impersonationStorageService: ImpersonationStorageService,
    private layoutService: LayoutService,
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
      moonOutline,
      optionsOutline,
      personCircleOutline,
      radioButtonOffOutline,
      radioButtonOnOutline,
      sunnyOutline
    });

    // Subscribed here rather than in `ngOnInit` because both streams emit
    // synchronously on subscribe, so the fields they populate are settled before the
    // first render rather than one change-detection pass behind it.
    //
    // That first emission necessarily carries no viewer, so every derivation below
    // has to be correct while nothing is known yet - hence the `?.` reads, and hence
    // `hasPromotion` consulting `info` before `ngOnInit` has assigned it. Absent a
    // viewer and absent deployment info the answer is `false`, which is correct.
    this.userService.stateChanged
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((state) => {
        this.user = state.user;

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

        // Read after the shell has applied the theme for this same emission, so
        // the control describes the appearance that is actually painted.
        this.isDarkTheme = this.document.body.classList.contains('theme-dark');

        this.hasPromotion = this.user
          ? !!this.user.subscription?.offer?.coupon ||
            !!this.user.subscription?.offer?.durationExtension
          : !!this.info?.subscriptionOffer?.coupon ||
            !!this.info?.subscriptionOffer?.durationExtension;

        if (this.user) {
          // The plan page is hosted outside this application, so it is reached
          // by an absolute address in the viewer's own language rather than by
          // a route. Guarded because there is no language to read until a
          // viewer resolves.
          const languageCode = this.user.settings.language;

          this.pricingUrl = `https://ghostfol.io/${languageCode}/${publicRoutes.pricing.path}`;
        }

        this.changeDetectorRef.markForCheck();
      });
  }

  /**
   * Opens the assistant on `/`, the shortcut the deleted chrome established.
   *
   * Every clause is load-bearing. The two element exclusions keep the shortcut
   * from stealing a literal slash while the viewer is typing, `instanceof
   * Element` is what makes `nodeName` safe to read at all, the permission check
   * stops the shortcut opening a panel the viewer may not have, and
   * `preventDefault()` suppresses the character that would otherwise be
   * inserted. The assistant's own key handling is bound to `document` and
   * returns early unless it is already open, so the two never contend.
   */
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

  /**
   * Resolves what does not depend on the viewer: the device class the assistant
   * sizes itself with, and the one deployment-wide capability this bar gates on.
   *
   * `fetchInfo()` is synchronous and deep-clones its result, so it is called
   * exactly once and the result retained on {@link info}.
   */
  public ngOnInit() {
    this.info = this.dataService.fetchInfo();

    this.deviceType = this.deviceService.getDeviceInfo().deviceType;

    this.hasPermissionForSubscription = hasPermission(
      this.info.globalPermissions,
      permissions.enableSubscription
    );

    this.changeDetectorRef.markForCheck();
  }

  /**
   * Dismisses the panel that hosts the assistant, in response to the assistant
   * asking to be dismissed.
   *
   * Optional because the assistant can request this before the panel it lives
   * in has been projected, in which case there is nothing to close.
   */
  public closeAssistant() {
    this.assistentMenuTriggerElement?.closeMenu();
  }

  /**
   * The reload is intentional: every service reads identity from storage on the way
   * to its first request, so restarting the application is the only way to
   * guarantee nothing is left holding the previous identity's data.
   */
  public impersonateAccount(aId: string) {
    if (aId) {
      this.impersonationStorageService.setId(aId);
    } else {
      this.impersonationStorageService.removeId();
    }

    window.location.reload();
  }

  /**
   * Persists the selected date range, then forces a re-read of the viewer.
   *
   * The forced re-read is what propagates the new range to everything drawing
   * from the viewer's settings; without it the write would land on the server
   * and nothing on screen would follow it.
   */
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

  /**
   * Switches the viewer between the light and dark appearance.
   *
   * Written through the viewer's own `colorScheme` setting - the very setting the
   * account-settings appearance control writes - rather than by touching the theme
   * directly. That is what makes this a toolbar affordance for an existing
   * preference instead of a second, competing theme mechanism: the two controls
   * cannot disagree, the choice survives a reload, and it follows the viewer to
   * another browser.
   *
   * Applying it stays the shell's job. Re-reading the viewer is what hands the new
   * value to the shell, which re-applies the theme on every emission of that
   * record; nothing here adds or removes a class.
   *
   * Note what this deliberately cannot do: return to "follow the system", which is
   * the third state the setting supports and which the account-settings control
   * keeps. A toolbar toggle answers one question - light or dark - and offering a
   * tri-state cycle from a single icon would leave the viewer guessing which of
   * three states one more press lands on.
   */
  public onToggleTheme() {
    const colorScheme: ColorScheme = this.isDarkTheme ? 'LIGHT' : 'DARK';

    this.dataService
      .putUserSetting({ colorScheme })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => {
        this.userService
          .get(true)
          .pipe(takeUntilDestroyed(this.destroyRef))
          .subscribe();
      });
  }

  /**
   * Persists the selected portfolio filters, then forces a re-read of the
   * viewer.
   *
   * The array-versus-scalar split below is not an inconsistency to tidy up: it
   * is the persisted shape, and `UserService.getFilters()` reads it back exactly
   * this way - taking the first element for accounts, asset classes and tags,
   * and the bare value for data source and symbol. `UpdateUserSettingDto` types
   * the five keys accordingly, so a mismatch is a compile error rather than a
   * filter that silently fails to round-trip.
   *
   * Equally deliberate is the truthiness test rather than a nullish one: a
   * cleared filter arrives with an empty id and has to erase the stored value,
   * which `??` would not do.
   */
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

  public onLogoClick() {
    this.layoutService.getShouldReloadSubject().next();
  }

  public onMenuClosed() {
    this.isMenuOpen = false;
  }

  public onMenuOpened() {
    this.isMenuOpen = true;
  }

  /**
   * Prepares the assistant as its panel opens. Populating on open rather than
   * on construction keeps the assistant's own data off the first render of the
   * bar.
   */
  public onOpenAssistant() {
    this.assistantElement.initialize();
  }

  /**
   * The discriminator is forwarded exactly as received and never resolved here: which
   * component backs a module, whether it is already on the canvas and where it would
   * go are all the canvas's to answer. Publishing onto the bus in `core/` rather than
   * calling the canvas is what keeps this component free of any reference to it.
   */
  public onSelectModule(moduleType: DashboardModuleType) {
    this.dashboardIntentService.getRevealModuleSubject().next(moduleType);
  }

  /**
   * `signOut()` clears storage and cookies and resets the user store, after which the
   * canvas sees a null viewer and falls through to its signed-out state. The
   * document-level navigation that follows is a full load of the locale root, which is
   * deliberate: it discards every in-memory cache belonging to the identity that just
   * left.
   */
  public onSignOut() {
    this.userService.signOut();

    document.location.href = `/${document.documentElement.lang}`;
  }
}
