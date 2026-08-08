import {
  getCssVariable,
  isKnownDataSource,
  reportSanitizedError
} from '@ghostfolio/common/helper';
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

// Type-only, both of them. Each dialog class is resolved on demand where it is
// opened, so naming one here as a value would put its whole graph back into the
// shell's chunk. A single-route table declares no lazy boundary, so the code
// splitting has to be established at each of those call sites instead.
import type {
  HoldingDetailDialogParams,
  HoldingDetailDialogResult
} from './components/holding-detail-dialog/interfaces/interfaces';
import type { UserAccountRegistrationDialogParams } from './components/user-account-registration-dialog/interfaces/interfaces';
import { LazyDialogService } from './core/lazy-dialog.service';
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

  /**
   * Whether the registration dialog's chunk is currently being resolved.
   *
   * Bound to the one control that starts it, so a slow load cannot be clicked
   * twice into opening two dialogs, and so the visitor can see that their press was
   * received. Held here rather than read from the loader because it is this
   * component's rendering state; the loader's own deduplication covers the case of
   * two different components asking at once.
   */
  public isCreatingAccount = false;

  public user: User | undefined;

  /**
   * Whether the operating system's colour preference is already being watched.
   *
   * A latch rather than a counter, because exactly one listener is wanted for the
   * shell's lifetime. The theme is applied on every emission of the viewer's
   * record, so without this the listener was re-registered each time.
   */
  private hasObservedSystemColorScheme = false;

  private readonly changeDetectorRef = inject(ChangeDetectorRef);
  /**
   * Injected for exactly two reasons, neither of which reads, writes or holds a
   * layout — the canvas owns all three. `onCreateAccount()` has to announce an
   * identity transition before it replaces the bearer token, and `onSignOut()` has
   * to flush an arrangement still inside its debounce before it replaces the
   * document.
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
  private readonly lazyDialogService = inject(LazyDialogService);
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

              // Voided rather than awaited: the handler resolves the dialog's own
              // chunk before opening it, so it is asynchronous, and nothing here
              // depends on the dialog having opened. The address travels with the
              // request so the handler can tell its own request apart from a newer
              // one, and can hand the address back if its chunk never arrives.
              void this.openHoldingDetailDialog({
                address,
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
   * No navigation follows it. `/` is already the current — and only — route, so
   * the account is adopted by forcing a re-read of the viewer instead. That read
   * is what drives the `stateChanged` subscription above to recompute
   * `canCreateAccount` and `hasInfoMessage`, which in turn dismisses the
   * live-demo banner.
   *
   * Having nowhere to navigate to is what makes the order below load-bearing. The
   * dashboard the visitor is looking at stays mounted across the adoption, so
   * without an explicit hand-over it would still be live — along with any
   * arrangement change it had scheduled but not yet written — while the new
   * account's token is the one authorising requests, and would write the previous
   * viewer's layout to the new account. Replacing the token is therefore
   * performed as an explicit identity transition, in this order:
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
  public async onCreateAccount() {
    // Resolved on demand rather than imported at the top of the file. This dialog
    // reaches a large graph of its own and is opened only when a visitor asks to
    // create an account, so a static reference would place all of it in the
    // initial bundle for every visitor - the canvas is the one screen the
    // application has, so there is no route boundary to do this for us.
    //
    // Routed through the shared loader, which is what makes the load safe as well
    // as lazy: concurrent activations share one chunk request, a rejected one is
    // reported and shown to the visitor rather than left as an unhandled
    // rejection, and the pending entry is released either way so the control keeps
    // working. `isCreatingAccount` is this component's own share of that - it is
    // what disables the banner control, so a slow chunk cannot be clicked into
    // opening two dialogs.
    if (this.isCreatingAccount) {
      return;
    }

    this.isCreatingAccount = true;

    this.changeDetectorRef.markForCheck();

    const GfUserAccountRegistrationDialogComponent =
      await this.lazyDialogService.load(
        'user-account-registration-dialog',
        () =>
          import('./components/user-account-registration-dialog/user-account-registration-dialog.component').then(
            (chunk) => {
              return chunk.GfUserAccountRegistrationDialogComponent;
            }
          )
      );

    this.isCreatingAccount = false;

    this.changeDetectorRef.markForCheck();

    // Nothing to open, and nothing to say: the loader has already reported the
    // failure and told the visitor about it.
    if (!GfUserAccountRegistrationDialogComponent) {
      return;
    }

    // The third type argument is the token the dialog resolves with, or nothing
    // when it is cancelled - its template closes on `authToken` and on
    // `undefined` respectively. Declared rather than inferred, so the token is
    // read as a string instead of as `any`.
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
              // Reported through the sanitized channel rather than logged raw. This
              // is the continuation of creating an account, so the failure is
              // credential-adjacent: an `HttpErrorResponse` carries the request URL
              // and whatever the server put in the body, and the console is readable
              // by every script on the page, captured verbatim by session-replay
              // tooling and outlives the session in a saved log. A fixed event
              // identifier and the numeric status are what an operator can act on.
              reportSanitizedError('GF-APP-USER-CREATE-READ-FAILED', error);

              // Reloading is what recovers it: the token is already stored, so
              // resolution restarts from it - which is precisely the step that
              // failed.
              window.location.reload();
            }
          });
      });
  }

  /**
   * Signs the viewer out, but not before whatever they last arranged has been
   * stored.
   *
   * The release comes first, and the ordering is load-bearing twice over: a
   * document-level navigation replaces the document rather than routing within it,
   * so no teardown downstream of this line ever runs and an arrangement still
   * inside its 500ms debounce would be dropped in silence; and `signOut()` clears
   * the token the write is authorised with, so releasing after it would send a
   * request that cannot succeed.
   *
   * It adds no write origin. The arrangement was produced by the grid and is
   * already travelling the layout service's one persistence pipeline; this only
   * asks that pipeline to stop waiting out its debounce.
   *
   * Releasing it first is not sufficient on its own, which is why the departure now
   * WAITS for it. An `HttpClient` request is not guaranteed to survive the
   * document being replaced, so a write merely started before the assignment could
   * still be abandoned in flight - the same silent loss, moved a few microseconds
   * later. Holding the departure until the layout service reports the write
   * settled is what closes that window, and the wait is bounded by the service so
   * a request that never answers cannot strand the control.
   *
   * A failure is answered rather than absorbed. Signing out anyway is right - a
   * viewer who asks to leave must always be able to, and an arrangement that
   * cannot be stored would otherwise trap them here indefinitely - but leaving
   * silently would let them believe an arrangement they can still see had been
   * saved. So they are told, and the departure completes when they acknowledge it.
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

  /**
   * Discards the session and reloads the application at the locale root.
   *
   * Shared by both endings of {@link onSignOut} so that the order the sign-out
   * depends on - credentials cleared, then the document replaced - is written
   * once. A document-level assignment rather than a router navigation, deliberately:
   * it is what discards every in-memory cache belonging to the identity that just
   * left.
   */
  private leaveForLocaleRoot() {
    this.userService.signOut();

    document.location.href = `/${document.documentElement.lang}`;
  }

  private initializeTheme(userPreferredColorScheme?: ColorScheme) {
    const isDarkTheme = userPreferredColorScheme
      ? userPreferredColorScheme === 'DARK'
      : window.matchMedia('(prefers-color-scheme: dark)').matches;

    this.toggleTheme(isDarkTheme);

    this.observeSystemColorScheme();
  }

  /**
   * Follows the operating system's colour preference, for as long as the viewer
   * expresses none of their own.
   *
   * Subscribed exactly once, which is the whole point of it being separate from
   * applying the theme. Applying it runs on every emission of the viewer's record,
   * and a great many things refresh that record - a date range, a filter, adopting
   * a token - so registering the listener alongside the theme it applies would add
   * one more listener every time, none of them released, each re-running the same
   * work for the lifetime of the session.
   *
   * `addEventListener` rather than the deprecated `addListener`, so the listener
   * can be released with the component; `addListener` offers no removal that
   * `DestroyRef` could call.
   */
  private observeSystemColorScheme() {
    if (this.hasObservedSystemColorScheme) {
      return;
    }

    this.hasObservedSystemColorScheme = true;

    const query = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = (event: MediaQueryListEvent) => {
      // Only while the viewer has expressed no preference of their own. An
      // explicit choice outranks the system's, exactly as it did before.
      if (!this.user?.settings.colorScheme) {
        this.toggleTheme(event.matches);
      }
    };

    query.addEventListener('change', onChange);

    this.destroyRef.onDestroy(() => {
      query.removeEventListener('change', onChange);
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

  /**
   * @param address the `dataSource:symbol` pair this request was made for, as it
   * was recorded on {@link openedHoldingDetailAddress} before the chunk was asked
   * for. Passed in rather than recomposed, because the recorded address is what the
   * two checks below compare against: the chunk resolves on a later tick, and by
   * then the address may have moved on or the request may have failed.
   */
  private async openHoldingDetailDialog({
    address,
    dataSource,
    symbol
  }: {
    address: string;
    dataSource: DataSource;
    symbol: string;
  }) {
    // Resolved on demand for the same reason as the registration dialog above:
    // this dialog pulls in a chart, an activities table and a market-data editor,
    // and it is opened only when a query parameter names a holding. Loading it here
    // keeps that graph out of every visitor's initial bundle, and routing the load
    // through the shared loader is what makes a slow or failed load safe: one chunk
    // request is shared, a rejection is reported and shown, and the pending entry is
    // released either way.
    const GfHoldingDetailDialogComponent = await this.lazyDialogService.load(
      'holding-detail-dialog',
      () =>
        import('./components/holding-detail-dialog/holding-detail-dialog.component').then(
          (chunk) => {
            return chunk.GfHoldingDetailDialogComponent;
          }
        )
    );

    // The address is RELEASED on failure, and that is the point of holding it at
    // all. It is recorded before the chunk is asked for - it has to be, or two
    // emissions of the same parameters would both start a load - so a rejected load
    // that left it standing made this application permanently unable to open that
    // holding again: every later request for it matched the recorded address and was
    // guarded away, with no dialog ever having opened. Released only if it is still
    // this request's address, so a newer request's record is not taken with it.
    if (!GfHoldingDetailDialogComponent) {
      if (this.openedHoldingDetailAddress === address) {
        this.openedHoldingDetailAddress = null;
      }

      return;
    }

    // Superseded while the chunk was resolving: the viewer asked for a different
    // holding, and that request has recorded its own address and is opening its own
    // dialog. Opening this one as well would leave two dialogs stacked, with the
    // older asset on top.
    if (this.openedHoldingDetailAddress !== address) {
      return;
    }

    this.userService
      .get()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((user) => {
        this.user = user;

        // `InstanceType<typeof …>` rather than the bare class name: the dynamic
        // import above binds a value, not a type alias, and this generic parameter
        // wants the component's instance type.
        const dialogRef = this.dialog.open<
          InstanceType<typeof GfHoldingDetailDialogComponent>,
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
            // Clearing regardless would leave the administration module with a
            // request to open an asset profile dialog for no asset.
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
