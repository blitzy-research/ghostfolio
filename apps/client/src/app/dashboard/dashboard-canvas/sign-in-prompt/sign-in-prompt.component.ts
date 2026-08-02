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

/**
 * Unauthenticated state of the single root route.
 *
 * The single-canvas refactor collapses the former route-per-screen navigation
 * surface into one root route, and the public marketing surface (landing,
 * pricing, features, blog, FAQ, resources, about, open-startup, registration
 * and demo entry points) is removed outright. There is therefore nowhere left
 * to redirect an anonymous visitor to: the guard always resolves, and the
 * canvas host renders this component whenever the user store resolves to a
 * null user and no public-access identifier is present on the URL.
 *
 * Scope is deliberately minimal — a brand mark and the authentication
 * affordances, nothing more. No hero art, no feature list, no pricing or
 * about copy: none of that is specified, and inventing it would recreate the
 * marketing surface the refactor removes.
 *
 * ## Why a single "Sign in" action covers three authentication paths
 *
 * `GfLoginWithAccessTokenDialogComponent` renders the security-token field,
 * the Google anchor, the OpenID Connect anchor and the stay-signed-in
 * checkbox inside its own template, each already gated on the matching
 * global permission it receives through
 * {@link LoginWithAccessTokenDialogParams}. Duplicating those anchors here
 * would fork the markup and the gating for no benefit, so this component
 * resolves the four global permission probes it needs and hands them to the
 * dialog.
 *
 * ## Construction is intentionally side-effect free
 *
 * The predecessor registration route shell cleared the active session from
 * its own constructor. That was safe for a dedicated route only an anonymous
 * visitor could reach; on the collapsed root route it would destroy a live
 * session for anyone who rendered this component transiently — for instance
 * during the window before the user store resolves. This constructor
 * therefore captures dependencies and does nothing else, and no method here
 * mutates session state except in direct response to a completed
 * authentication.
 *
 * ## Re-hydration is the canvas host's responsibility
 *
 * `/` is already the active route, so the router call at the end of
 * {@link setToken} is a no-op that neither recreates the canvas host nor
 * re-runs its initialisation. The canvas host closes that gap by observing
 * the user store and force-refreshing the persisted layout on any transition
 * to an authenticated user. This component deliberately does not compensate
 * with a page reload, does not touch the layout-persistence layer and does
 * not observe the user store itself — a second re-hydration trigger would
 * duplicate the host's own.
 *
 * The canvas host renders this component with no bindings at all, so it
 * declares no inputs and no outputs; every affordance it offers is
 * self-contained.
 */
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
   * Device class reported by the detector, used solely to size the account
   * registration dialog. It drives no layout decision in this component's own
   * template: the canvas is explicitly non-responsive.
   */
  public deviceType: string;

  /** Whether the deployment offers Google as a sign-in provider. */
  public hasPermissionForAuthGoogle: boolean;

  /** Whether the deployment offers OpenID Connect as a sign-in provider. */
  public hasPermissionForAuthOidc: boolean;

  /** Whether the deployment accepts security-token sign-in. */
  public hasPermissionForAuthToken: boolean;

  /**
   * Whether the deployment runs subscriptions. Surfaced to the registration
   * dialog, which requires terms-of-service acceptance when it is granted.
   */
  public hasPermissionForSubscription: boolean;

  /** Whether the deployment permits self-service account creation. */
  public hasPermissionToCreateUser: boolean;

  /**
   * Dependencies only. Deliberately free of side effects — see the class
   * documentation above for why any session mutation here would be unsafe.
   */
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

  /**
   * Resolves the global permissions that decide which authentication paths are
   * offered.
   *
   * `fetchInfo()` is synchronous — it reads the bootstrap payload the server
   * embeds in the document, clones it and filters the global permissions by
   * campaign source — so there is nothing to await or subscribe to here.
   * `hasPermission` is a plain membership test, so each probe is read as
   * "this capability is enabled" and is never negated.
   *
   * `markForCheck()` closes the method because the component is `OnPush`: it
   * guarantees the six resolved fields are picked up even when initialisation
   * is reached outside the first change-detection pass.
   */
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
   * Opens the access-token dialog and exchanges a submitted security token for
   * a session.
   *
   * Carried over unchanged from the deleted navigation chrome, which owned the
   * only implementation of this flow. Two details are load-bearing:
   *
   * - The two `$localize` messages are reused character-for-character from
   *   that original and carry no explicit identifier. Angular derives the
   *   translation identifier from the message text, so altering a single
   *   character would mint an untranslated unit across every locale catalogue
   *   and silently regress the translated builds.
   * - `catchError` maps a rejected token to `EMPTY` rather than rethrowing.
   *   That keeps the outer subscription alive, so a visitor who mistypes their
   *   token can simply try again; propagating the error would tear the
   *   subscription down and leave the button inert.
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
   * Opens the account registration dialog and adopts the session it returns.
   *
   * Two departures from the deleted registration route shell are intentional:
   *
   * - The session is persisted with stay-signed-in forced on, rather than
   *   derived from the stored preference the way {@link setToken} does. A
   *   freshly created account has no stored preference yet, and the security
   *   token shown by the dialog is the only copy the user will ever be given,
   *   so the durable store is the correct destination. This asymmetry is
   *   inherited from the original flow and preserved deliberately.
   * - The original navigated to `/` afterwards. On the collapsed root route
   *   that is a no-op, so this forces a user re-fetch instead; the canvas
   *   host's own user-store subscription then moves the root out of this
   *   unauthenticated state.
   *
   * The dialog is opened with closing suppressed because abandoning it midway
   * would discard an already-provisioned account together with the only copy
   * of its security token.
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
   * Persists an authentication token and settles the resulting session.
   *
   * Carried over unchanged from the deleted navigation chrome. Durability
   * honours the stored stay-signed-in preference: the token always reaches
   * session storage, and local storage as well only when the visitor asked to
   * stay signed in.
   *
   * When the authenticated user's language differs from the document's, the
   * hard relocation to the sibling locale is required — locales are deployed
   * under distinct base paths, so reaching the other one is a document load
   * rather than an in-application transition. Otherwise the router call is
   * retained exactly as it was; on the collapsed root route it resolves to a
   * no-op, and the canvas host owns re-hydration (see the class
   * documentation).
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
