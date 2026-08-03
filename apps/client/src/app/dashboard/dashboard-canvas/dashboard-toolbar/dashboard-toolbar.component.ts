import { LoginWithAccessTokenDialogParams } from '@ghostfolio/client/components/login-with-access-token-dialog/interfaces/interfaces';
import { GfLoginWithAccessTokenDialogComponent } from '@ghostfolio/client/components/login-with-access-token-dialog/login-with-access-token-dialog.component';
import { DashboardIntentService } from '@ghostfolio/client/core/dashboard-intent.service';
import { LayoutService } from '@ghostfolio/client/core/layout.service';
import { DashboardModuleType } from '@ghostfolio/client/dashboard/enums/dashboard-module-type';
import { ImpersonationStorageService } from '@ghostfolio/client/services/impersonation-storage.service';
import {
  KEY_STAY_SIGNED_IN,
  SettingsStorageService
} from '@ghostfolio/client/services/settings-storage.service';
import { TokenStorageService } from '@ghostfolio/client/services/token-storage.service';
import { UserService } from '@ghostfolio/client/services/user/user.service';
import { UpdateUserSettingDto } from '@ghostfolio/common/dtos';
import { Filter, InfoItem, User } from '@ghostfolio/common/interfaces';
import { hasPermission, permissions } from '@ghostfolio/common/permissions';
import { publicRoutes } from '@ghostfolio/common/routes/routes';
import { DateRange } from '@ghostfolio/common/types';
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
  OnInit,
  ViewChild
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { MatBadgeModule } from '@angular/material/badge';
import { MatButtonModule } from '@angular/material/button';
import { MatDialog } from '@angular/material/dialog';
import { MatMenuModule, MatMenuTrigger } from '@angular/material/menu';
import { MatToolbarModule } from '@angular/material/toolbar';
import { Router } from '@angular/router';
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
import { EMPTY } from 'rxjs';
import { catchError } from 'rxjs/operators';

/**
 * Non-navigational control bar for the single-canvas dashboard.
 *
 * The application now resolves to one canvas, so the page chrome that used to
 * select a screen has no remaining job. What it did carry, besides navigation,
 * were six capabilities that are not navigational at all, and those are rehomed
 * here unchanged: the assistant, the date range, the portfolio filters,
 * identity switching, access-token sign-in and signing out - plus the promotion
 * derivation and the premium indicator that sat alongside them. Every one of
 * them acts in place. Nothing here addresses a screen.
 *
 * Consequences of that, each deliberate:
 *
 * - **Nothing here addresses a screen.** No in-application link directive is
 *   imported and no route constant is read. The single address that survives
 *   leaves this application altogether, for the externally hosted plan page, so
 *   it is an ordinary absolute target (`pricingUrl`). `Router` is still
 *   injected, because {@link setToken} has to hand off to the root route after a
 *   successful token exchange, but that is its only use.
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
 * is a sibling component the canvas renders instead of the canvas body. The
 * template's `@if (user)` guard is still required, because the viewer is
 * resolved asynchronously and the bar has to render as empty chrome until it
 * arrives rather than fault on the first pass.
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
  openAssistantWithHotKey(event: KeyboardEvent) {
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

  @ViewChild('assistant') assistantElement: GfAssistantComponent;
  @ViewChild('assistantTrigger') assistentMenuTriggerElement: MatMenuTrigger;

  public deviceType: string;
  public hasFilters: boolean;
  public hasImpersonationId: boolean;
  public hasPermissionForAuthGoogle: boolean;
  public hasPermissionForAuthOidc: boolean;
  public hasPermissionForAuthToken: boolean;
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
    private dialog: MatDialog,
    private impersonationStorageService: ImpersonationStorageService,
    private layoutService: LayoutService,
    private notificationService: NotificationService,
    private router: Router,
    private settingsStorageService: SettingsStorageService,
    private tokenStorageService: TokenStorageService,
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

    // Subscribed here rather than in `ngOnInit` because both streams above and
    // below emit synchronously on subscribe - the impersonation store is seeded
    // from local storage and the user store is dispatched through a
    // `BehaviorSubject` that its own constructor has already primed - so the
    // fields they populate are settled before the first render rather than one
    // change-detection pass behind it.
    //
    // That first synchronous emission necessarily carries no viewer, because
    // the user store primes itself with `undefined` and the fetch that replaces
    // it has not resolved yet. Every derivation below therefore has to be
    // correct for the not-yet-resolved case as well, which is why each reads
    // through `?.` and why `hasPromotion` may consult `info` before `ngOnInit`
    // has assigned it: absent a viewer and absent deployment info the answer is
    // `false`, which is the right answer while nothing is known. Every later
    // emission arrives after `ngOnInit`, with `info` populated.
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

        // These two were previously derived from the active route, in the shell
        // that no longer has one. On a single canvas there is no screen to
        // qualify the capability, so it reduces to whether there is a viewer to
        // act for at all - which is also the condition under which the
        // assistant that consumes them is rendered.
        this.hasPermissionToChangeDateRange = !!this.user;
        this.hasPermissionToChangeFilters = !!this.user;

        // A viewer's own offer wins; the deployment-wide offer is the fallback
        // for anyone without one.
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
   * Resolves what does not depend on the viewer: the device class the assistant
   * sizes itself with, and the capabilities the deployment grants globally.
   *
   * `fetchInfo()` is synchronous and deep-clones its result, so it is called
   * exactly once and the result retained on {@link info}.
   */
  public ngOnInit() {
    this.info = this.dataService.fetchInfo();

    const { globalPermissions } = this.info;

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
   * Adopts another identity, or returns to the viewer's own when passed
   * nothing.
   *
   * The reload is intentional and is the behaviour being preserved: identity is
   * read from storage by every service on the way to its first request, so the
   * only way to guarantee that nothing is left holding data belonging to the
   * previous identity is to start the application again.
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

  /**
   * Reloads the content in place.
   *
   * Previously conditional on standing on one of two screens. There is now one
   * canvas and no screen to be standing on, so the condition is gone and the
   * mark reloads unconditionally - which is what it already did everywhere the
   * mark was reachable. Note that it reloads rather than navigates: activating
   * it changes no address.
   */
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
   * Publishes a request to reveal a module, in place of the navigation this
   * would once have been.
   *
   * The discriminator is forwarded exactly as received and is never resolved
   * here: this component does not know which component backs a module, does not
   * know whether the module is already on the canvas, and does not decide where
   * it would go. The canvas observes the bus and answers all three questions.
   * Forwarding through a bus in `core/` rather than calling the canvas is what
   * keeps that ignorance structural - the dependency points away from the
   * canvas layer, and the workspace's module-boundary rule fails the build if
   * it ever points back.
   */
  public onSelectModule(moduleType: DashboardModuleType) {
    this.dashboardIntentService.getRevealModuleSubject().next(moduleType);
  }

  /**
   * Signs the viewer out.
   *
   * The work itself used to live in the shell, which received this as an event;
   * with the chrome gone there is no shell listener left, so it is performed
   * here. `signOut()` clears storage and cookies and resets the user store,
   * after which the canvas sees a null viewer and falls through to the
   * signed-out state. The document-level navigation that follows is a full load
   * of the locale root, which is deliberate: it discards every in-memory cache
   * belonging to the identity that just left.
   */
  public onSignOut() {
    this.userService.signOut();

    document.location.href = `/${document.documentElement.lang}`;
  }

  /**
   * Offers the shared sign-in dialog, which renders all three authentication
   * paths itself from the capabilities passed to it - security token, Google
   * and OIDC - so none of them is handled here.
   *
   * The dialog resolves with a token only when one was entered; closing it any
   * other way resolves with nothing, which the guard below covers. A rejected
   * token is reported and then swallowed with `EMPTY`, placed ahead of the
   * lifecycle operator so the stream survives and a second attempt still works;
   * letting the error through would tear the subscription down and leave the
   * dialog unusable until the bar was rebuilt.
   *
   * The two message strings are reused verbatim from the chrome this bar
   * replaces, and carry no explicit identifier, so their existing translations
   * in all thirteen locale catalogues continue to apply.
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
   * Stores a freshly issued token, honouring the stay-signed-in preference, and
   * then reads the viewer it belongs to.
   *
   * A viewer whose language differs from the document's is sent to their own
   * locale with a document-level load, because each locale is deployed under its
   * own base path and cannot be reached from within this one. Otherwise the root
   * route is requested, which resolves to the canvas.
   *
   * On the collapsed route table that request is already satisfied, so it does
   * not rebuild anything - and it deliberately is not made to. Re-reading the
   * viewer is itself the signal: it dispatches through the user store, and the
   * canvas observes that store and rehydrates from it. Forcing a reload here
   * would discard work the viewer had not saved for no gain.
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
