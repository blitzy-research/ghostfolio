import { permissions } from '@ghostfolio/common/permissions';
import type { AlertParams } from '@ghostfolio/ui/notifications';
import { NotificationService } from '@ghostfolio/ui/notifications';
import { DataService } from '@ghostfolio/ui/services';

import { CUSTOM_ELEMENTS_SCHEMA } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { MatDialog } from '@angular/material/dialog';
import { ActivatedRoute, Router, RouterOutlet } from '@angular/router';
import { DeviceDetectorService } from 'ngx-device-detector';
import {
  BehaviorSubject,
  EMPTY,
  Observable,
  of,
  Subject,
  throwError
} from 'rxjs';

import { GfAppComponent } from './app.component';
import { GfHoldingDetailDialogComponent } from './components/holding-detail-dialog/holding-detail-dialog.component';
import { GfUserAccountRegistrationDialogComponent } from './components/user-account-registration-dialog/user-account-registration-dialog.component';
import { LazyDialogService } from './core/lazy-dialog.service';
import { GfDashboardLayoutService } from './dashboard/services/dashboard-layout.service';
import { ImpersonationStorageService } from './services/impersonation-storage.service';
import { TokenStorageService } from './services/token-storage.service';
import { UserService } from './services/user/user.service';

/**
 * The application shell.
 *
 * It owns three responsibilities, and each of them is a silent failure waiting to
 * happen:
 *
 * 1. **The holding-detail dialog is opened from a query parameter.** This is the
 *    workspace's route-agnostic dialog convention: a producer anywhere in the
 *    application rewrites the current URL, and the shell is the consumer. The
 *    dialog's inputs are derived from the viewer's own permissions and settings,
 *    and its clean-up nulls exactly three parameters while merging the rest -
 *    dropping the merge would close every co-mounted module's dialog along with
 *    this one.
 * 2. **Account registration.** Its two dialog inputs, its device-dependent sizing
 *    and - most importantly - the token adoption followed by a *forced* viewer
 *    re-fetch, which is what dismisses the live-demo banner.
 * 3. **A system message is surfaced without navigating.** Its optional
 *    `routerLink` is deliberately ignored, because this application addresses no
 *    screen; honouring it would resolve to nothing.
 *
 * The `Router` is a recording stub throughout, because on a single-canvas shell
 * no navigation selects a screen - the query parameters are the whole message.
 * `MatDialog` is a stub as well: what matters is the request the shell makes and
 * what it does with the answer, not the dialog's own rendering, which each dialog
 * component's own suite owns.
 */
describe('GfAppComponent', () => {
  /**
   * The fragment jsdom uses to report an attempted document navigation.
   *
   * Both departures this shell performs - reloading after a failed forced read,
   * and leaving for the locale root on sign-out - go through `Location`, which
   * jsdom implements as `[LegacyUnforgeable]`: it can be neither redefined nor
   * spied, so `Object.defineProperty(window, 'location', …)` throws and
   * `jest.spyOn(window.location, 'reload')` throws. The report jsdom emits on its
   * virtual console is the one observable signal, and it arrives here as a
   * `console.error`. Matched on rather than compared, because the report is a
   * stack rather than a bare message.
   *
   * jsdom performs no navigation at all when the target resolves to the URL the
   * document is already on, so an *empty* attempt list is itself an exact
   * assertion about the address that was assigned.
   */
  const JSDOM_NAVIGATION_REPORT = 'Not implemented: navigation';

  /** The diagnostic the shell writes when the forced read of a new account fails. */
  const FORCED_READ_DIAGNOSTIC =
    'Failed to read the newly created user account';

  /**
   * The sanitized marker the shell reports when the arrangement could not be
   * stored on the way out. Named once, because two tests provoke it deliberately
   * and both have to declare it as expected.
   */
  const SIGN_OUT_FLUSH_FAILED_REPORT =
    'GF-DASHBOARD-LAYOUT-SIGN-OUT-FLUSH-FAILED';

  let dialogAfterClosed: Observable<unknown>;
  let dialogOpen: jest.Mock;

  /**
   * Every dialog the shell asked for, recorded through a typed side effect.
   *
   * Read back off `dialogOpen.mock.calls` instead, the element type is `any` and
   * every assertion about the component or its configuration stops being checked
   * by the compiler - which is exactly the kind of assertion that keeps passing
   * after the thing it describes has been renamed.
   */
  let dialogRequests: {
    component: unknown;
    config: {
      data?: Record<string, unknown>;
      disableClose?: boolean;
      height?: string;
      width?: string;
    };
  }[];
  let fixture: ComponentFixture<GfAppComponent>;
  /**
   * The layout service, stubbed rather than real, because the shell's two uses of
   * it are both about ORDER: announcing an identity transition before a token is
   * replaced, and holding a departure open until a queued arrangement has been
   * written. Neither is observable from the real service without also standing in
   * for the data facade it writes through.
   */
  let dashboardLayoutServiceMock: {
    beginIdentityTransition: jest.Mock;
    releasePendingSave: jest.Mock<Observable<void>, []>;
  };

  let notificationServiceMock: { alert: jest.Mock<void, [AlertParams]> };
  let queryParams: BehaviorSubject<Record<string, unknown>>;
  let routerMock: { navigate: jest.Mock };

  /** Every navigation the shell requested, recorded with its real types. */
  let navigations: {
    commands: unknown[];
    extras: {
      queryParams?: Record<string, unknown>;
      queryParamsHandling?: string;
    };
  }[];
  let stateChanged: BehaviorSubject<{ user: unknown }>;
  let signOut: jest.Mock;
  let tokenStorageServiceMock: { saveToken: jest.Mock };
  let userServiceGet: jest.Mock;
  let userServiceSignOut: jest.Mock;

  /** Records ordering between effects that would otherwise be unordered. */
  let callOrder: string[];

  let consoleErrorSpy: jest.SpyInstance;

  /** Every document navigation jsdom reported, and nothing else. */
  let navigationAttempts: string[];

  /** Every diagnostic the shell itself wrote, captured rather than printed. */
  let shellDiagnostics: unknown[][];

  /**
   * Every report that reached `console.error` and was none of the above.
   *
   * Asserted empty after each test, minus whatever that test declared in
   * {@link expectedErrorReports}, so an error raised anywhere inside an Angular
   * event listener - where the framework catches it and logs it through its own
   * `ErrorHandler` - fails the test that provoked it rather than merely appearing
   * in the output.
   */
  let errorReports: string[];

  /** Sanitized markers a test provokes on purpose, declared by that test. */
  let expectedErrorReports: string[];

  let colorSchemeListeners: ((event: { matches: boolean }) => void)[];
  let originalDocumentLanguage: string;
  let originalMatchMedia: typeof window.matchMedia;

  /**
   * The shared lazy-dialog loader, stubbed so that a chunk load can be made slow or
   * made to fail on demand.
   *
   * By default it simply performs the loader it is handed, which is what the real
   * service does on the happy path - so every existing expectation about which
   * component was opened still holds against the real class. Deduplication and the
   * visible failure report are the service's own contract and are asserted in its
   * own suite; what is asserted here is what the SHELL does with a slow or failed
   * load.
   */
  let lazyDialogServiceMock: {
    isLoading: jest.Mock<boolean, [string]>;
    load: jest.Mock<Promise<unknown>, [string, () => Promise<unknown>]>;
  };

  const createViewer = (viewer: Record<string, unknown> = {}) => {
    return {
      permissions: [],
      settings: { baseCurrency: 'CHF', colorScheme: 'LIGHT', locale: 'en-GB' },
      ...viewer
    };
  };

  const createComponent = async ({
    deviceType = 'desktop',
    viewer = null
  }: { deviceType?: string; viewer?: Record<string, unknown> | null } = {}) => {
    callOrder = [];
    dialogAfterClosed = of(undefined);

    dialogRequests = [];
    dialogOpen = jest.fn(
      (
        component: unknown,
        config: {
          data?: Record<string, unknown>;
          disableClose?: boolean;
          height?: string;
          width?: string;
        }
      ) => {
        dialogRequests.push({ component, config });

        return { afterClosed: () => dialogAfterClosed };
      }
    );

    lazyDialogServiceMock = {
      isLoading: jest.fn<boolean, [string]>(() => false),
      load: jest.fn((_aKey: string, aLoad: () => Promise<unknown>) => aLoad())
    };

    dashboardLayoutServiceMock = {
      // Recorded in the ordering list, because the announcement has to come BEFORE
      // the token is replaced: it withdraws layout write authorisation for the
      // interval in which the new credential is in storage and the viewer it
      // belongs to is not yet resolved. A call count alone cannot express that.
      beginIdentityTransition: jest.fn(() => {
        callOrder.push('beginIdentityTransition');
      }),
      releasePendingSave: jest.fn<Observable<void>, []>(() => {
        callOrder.push('releasePendingSave');

        return of(undefined);
      })
    };

    notificationServiceMock = { alert: jest.fn<void, [AlertParams]>() };
    queryParams = new BehaviorSubject<Record<string, unknown>>({});
    navigations = [];
    routerMock = {
      navigate: jest.fn(
        (
          commands: unknown[],
          extras: {
            queryParams?: Record<string, unknown>;
            queryParamsHandling?: string;
          } = {}
        ) => {
          callOrder.push('navigate');
          navigations.push({ commands, extras });

          return Promise.resolve(true);
        }
      )
    };
    stateChanged = new BehaviorSubject<{ user: unknown }>({ user: viewer });

    signOut = jest.fn(() => {
      callOrder.push('signOut');
    });

    tokenStorageServiceMock = {
      saveToken: jest.fn(() => {
        callOrder.push('saveToken');
      })
    };

    userServiceGet = jest.fn((force?: boolean) => {
      callOrder.push(force ? 'get(true)' : 'get()');

      return of(createViewer());
    });

    // The same spy the provider is wired with, under the second name the suites use
    // for it. Two doubles would mean the assertions in one group watched a function
    // the component never called.
    userServiceSignOut = signOut;

    await TestBed.configureTestingModule({
      imports: [GfAppComponent],
      providers: [
        {
          provide: ActivatedRoute,
          useValue: { queryParams: queryParams.asObservable() }
        },
        {
          provide: DataService,
          useValue: {
            fetchInfo: () => ({
              globalPermissions: [permissions.enableSubscription]
            })
          }
        },
        {
          provide: DeviceDetectorService,
          useValue: { getDeviceInfo: () => ({ deviceType }) }
        },
        {
          provide: GfDashboardLayoutService,
          useValue: dashboardLayoutServiceMock
        },
        { provide: LazyDialogService, useValue: lazyDialogServiceMock },
        {
          provide: ImpersonationStorageService,
          useValue: { onChangeHasImpersonation: () => of(null) }
        },
        { provide: MatDialog, useValue: { open: dialogOpen } },
        { provide: NotificationService, useValue: notificationServiceMock },
        { provide: Router, useValue: routerMock },
        { provide: TokenStorageService, useValue: tokenStorageServiceMock },
        {
          provide: UserService,
          useValue: {
            get: userServiceGet,
            signOut,
            stateChanged
          }
        }
      ]
    })
      // The outlet is the shell's one remaining router dependency and it stays in
      // production - the router genuinely renders the canvas rather than the canvas
      // being hard-mounted. It is removed here because rendering it would need a
      // route table, and no route table belongs in a spec about the shell.
      //
      // `CUSTOM_ELEMENTS_SCHEMA` comes with it so the now-unclaimed
      // `<router-outlet>` element is tolerated rather than reported as NG0304 on
      // every render. A stand-in component would also work, but only under the
      // selector `router-outlet`, which the workspace's component-selector rule
      // forbids - and suppressing that rule to accommodate a test double is a worse
      // trade than declaring the element unknown.
      .overrideComponent(GfAppComponent, {
        add: { schemas: [CUSTOM_ELEMENTS_SCHEMA] },
        remove: { imports: [RouterOutlet] }
      })
      .compileComponents();

    fixture = TestBed.createComponent(GfAppComponent);

    fixture.detectChanges();

    return fixture.componentInstance;
  };

  /** The dialog request the shell made, or `undefined` if it made none. */
  const openedDialog = () => {
    return dialogRequests.at(-1);
  };

  /**
   * Yields until every pending microtask and macrotask has run.
   *
   * The shell resolves each dialog's own chunk with a dynamic `import()` before
   * opening it - which is what keeps those chunks out of the initial bundle - so a
   * dialog opens on a later tick than the parameter that asked for it. Waiting
   * here is what lets these assertions observe the request rather than race it.
   */
  const settle = () => {
    return new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
  };

  /**
   * Makes every chunk load wait, and hands back the means to answer each one.
   *
   * A dialog's chunk is a network request, so the interesting states are the ones
   * that take time: a second activation arriving while the first is still resolving,
   * and a request superseded by a newer one. Neither is observable with a load that
   * settles immediately.
   */
  const deferChunkLoads = () => {
    const answers: ((component: unknown) => void)[] = [];

    lazyDialogServiceMock.load.mockImplementation(() => {
      return new Promise<unknown>((resolve) => {
        answers.push(resolve);
      });
    });

    return answers;
  };

  beforeEach(() => {
    colorSchemeListeners = [];
    errorReports = [];
    expectedErrorReports = [];
    navigationAttempts = [];
    shellDiagnostics = [];
    originalDocumentLanguage = document.documentElement.lang;

    consoleErrorSpy = jest
      .spyOn(console, 'error')
      .mockImplementation((...args: unknown[]) => {
        // Every argument is folded into the report, not just the first, and that
        // matters for one caller in particular: Angular's own `ErrorHandler` logs
        // `'ERROR'` followed by the error object, so reading the first argument
        // alone would record the word `ERROR` and lose the message that says what
        // actually went wrong.
        //
        // Errors are recognised by their shape rather than with `instanceof`. jsdom
        // raises its navigation report from its own realm, so
        // `detail instanceof Error` is false for the very object that arrives even
        // though an error is precisely what it is - measured, not assumed, and
        // narrowing that way silently stops matching.
        const report = args
          .map((detail) => {
            return Object.prototype.toString.call(detail) === '[object Error]'
              ? `${(detail as Error).name}: ${(detail as Error).message}`
              : typeof detail === 'string'
                ? detail
                : `[${typeof detail}]`;
          })
          .join(' ')
          .trim();

        if (report.includes(JSDOM_NAVIGATION_REPORT)) {
          callOrder.push('navigate');
          navigationAttempts.push(report);

          return;
        }

        // The shell's own diagnostic is captured rather than forwarded, so the
        // expected failure does not print, and - more importantly - so what it
        // said is assertable. Captured symmetrically with the navigation reports:
        // the reload and the diagnostic are two halves of one recovery, and
        // asserting one without the other would leave a silent reload or a silent
        // failure passing.
        if (report.includes(FORCED_READ_DIAGNOSTIC)) {
          shellDiagnostics.push(args);

          return;
        }

        // Everything else is collected and asserted empty after each test rather
        // than forwarded. Forwarding printed the report and let the test pass,
        // which is what let two deliberately provoked sign-out reports appear on a
        // fully green run - and, worse, would have let a genuine error raised
        // inside an Angular event listener do the same, because the framework
        // catches those and hands them to its `ErrorHandler` instead of letting
        // them reach the test.
        errorReports.push(report);
      });

    // jsdom implements no `matchMedia`, and the shell reads the operating system's
    // colour-scheme preference through it on construction. The stub reports the
    // light preference and keeps whatever listener is attached, so the theme
    // behaviour is observable rather than merely survivable.
    //
    // `addEventListener`/`removeEventListener` are what the shell calls, and both
    // halves are provided deliberately: the removal is the only way to assert that
    // the listener is released with the component, which the deprecated
    // `addListener`/`removeListener` pair offers no way to do.
    originalMatchMedia = window.matchMedia;
    window.matchMedia = jest.fn(() => ({
      addEventListener: (
        _type: string,
        listener: (event: { matches: boolean }) => void
      ) => {
        colorSchemeListeners.push(listener);
      },
      matches: false,
      removeEventListener: (
        _type: string,
        listener: (event: { matches: boolean }) => void
      ) => {
        colorSchemeListeners = colorSchemeListeners.filter((registered) => {
          return registered !== listener;
        });
      }
    })) as unknown as typeof window.matchMedia;
  });

  afterEach(() => {
    // Computed before the spy is handed back, so the message a failure produces
    // names the report itself. A failing expectation in a hook fails the test it
    // ran for, which is what makes an unexpected report a failure rather than a
    // line in the output.
    const unexpectedReports = errorReports.filter((report) => {
      return !expectedErrorReports.some((marker) => report.includes(marker));
    });

    window.matchMedia = originalMatchMedia;

    // Restored because the sign-out destination is composed from it, so a test
    // that sets it would otherwise decide where a later test departs to.
    document.documentElement.lang = originalDocumentLanguage;

    document.body.classList.remove('theme-dark', 'theme-light');

    consoleErrorSpy.mockRestore();

    jest.restoreAllMocks();

    expect(unexpectedReports).toEqual([]);
  });

  describe('the holding detail dialog', () => {
    /** The complete parameter triple that addresses the dialog. */
    const holdingParams = {
      dataSource: 'YAHOO',
      holdingDetailDialog: true,
      symbol: 'AAPL'
    };

    it('opens the dialog for a complete request', async () => {
      await createComponent();

      queryParams.next(holdingParams);

      await settle();

      const { component, config } = openedDialog();

      expect(dialogOpen).toHaveBeenCalledTimes(1);
      expect(component).toBe(GfHoldingDetailDialogComponent);
      expect(config.data).toMatchObject({
        dataSource: 'YAHOO',
        symbol: 'AAPL'
      });
    });

    it.each([
      {
        description: 'the data source is missing',
        params: { holdingDetailDialog: true, symbol: 'AAPL' }
      },
      {
        description: 'the symbol is missing',
        params: { dataSource: 'YAHOO', holdingDetailDialog: true }
      },
      {
        description: 'the flag is missing',
        params: { dataSource: 'YAHOO', symbol: 'AAPL' }
      },
      { description: 'nothing was addressed', params: {} }
    ])('opens nothing when $description', async ({ params }) => {
      await createComponent();

      queryParams.next(params);

      // All three members are required together. Two of them are also produced on
      // their own by other flows - a symbol and a data source address the asset
      // profile dialog too - so opening on a partial match would open this dialog
      // over somebody else's.
      expect(dialogOpen).not.toHaveBeenCalled();
    });

    it('derives the dialog inputs from the viewer', async () => {
      await createComponent();

      userServiceGet.mockReturnValue(
        of(
          createViewer({
            permissions: [
              permissions.accessAdminControl,
              permissions.createActivity,
              permissions.reportDataGlitch,
              permissions.updateActivity
            ]
          })
        )
      );

      queryParams.next(holdingParams);

      await settle();

      const { config } = openedDialog();

      // The viewer is re-read at open time rather than taken from the shell's own
      // field, which is what lets a dialog opened after a permission change reflect
      // it.
      expect(config.data).toMatchObject({
        baseCurrency: 'CHF',
        deviceType: 'desktop',
        hasImpersonationId: false,
        hasPermissionToAccessAdminControl: true,
        hasPermissionToCreateActivity: true,
        hasPermissionToReportDataGlitch: true,
        hasPermissionToUpdateActivity: true,
        locale: 'en-GB'
      });
    });

    it('withholds the activity capabilities from a restricted viewer', async () => {
      await createComponent();

      userServiceGet.mockReturnValue(
        of(
          createViewer({
            permissions: [
              permissions.createActivity,
              permissions.updateActivity
            ],
            settings: {
              baseCurrency: 'CHF',
              isRestrictedView: true,
              locale: 'en-GB'
            }
          })
        )
      );

      queryParams.next(holdingParams);

      await settle();

      const { config } = openedDialog();

      expect(config.data.hasPermissionToCreateActivity).toBe(false);
      expect(config.data.hasPermissionToUpdateActivity).toBe(false);
    });

    it('sizes the dialog for the device', async () => {
      await createComponent({ deviceType: 'mobile' });

      queryParams.next(holdingParams);

      await settle();

      const { config } = openedDialog();

      expect(config).toMatchObject({
        autoFocus: false,
        height: '98vh',
        width: '100vw'
      });
    });

    /**
     * A chunk that never arrives must not take the holding with it.
     *
     * The address is recorded BEFORE the chunk is asked for - it has to be, or two
     * emissions of the same parameters would both start a load - so a failed load
     * that left it standing made the application permanently unable to open that
     * holding again: every later request matched the recorded address and was
     * guarded away, with no dialog ever having opened.
     */
    it('lets the same holding be asked for again after a failed load', async () => {
      await createComponent();

      lazyDialogServiceMock.load.mockResolvedValueOnce(null);

      queryParams.next(holdingParams);

      await settle();

      expect(dialogOpen).not.toHaveBeenCalled();

      // Asked for again, exactly as a viewer would by selecting the same holding a
      // second time. The guard is gone with the failure, so the load is attempted
      // again and the dialog opens.
      queryParams.next({});
      queryParams.next(holdingParams);

      await settle();

      expect(lazyDialogServiceMock.load).toHaveBeenCalledTimes(2);
      expect(dialogOpen).toHaveBeenCalledTimes(1);
      expect(openedDialog().component).toBe(GfHoldingDetailDialogComponent);
    });

    it('abandons a request the viewer has already replaced', async () => {
      await createComponent();

      const answers = deferChunkLoads();

      queryParams.next(holdingParams);

      await settle();

      // A different holding, while the first chunk is still resolving.
      queryParams.next({
        dataSource: 'YAHOO',
        holdingDetailDialog: true,
        symbol: 'MSFT'
      });

      await settle();

      expect(answers).toHaveLength(2);

      // Both chunks arrive, oldest last - the order that would otherwise leave two
      // dialogs stacked with the abandoned asset on top.
      answers[1](GfHoldingDetailDialogComponent);

      await settle();

      answers[0](GfHoldingDetailDialogComponent);

      await settle();

      expect(dialogOpen).toHaveBeenCalledTimes(1);
      expect(openedDialog().config.data).toMatchObject({ symbol: 'MSFT' });
    });

    it('clears exactly its own parameters when the dialog closes', async () => {
      await createComponent();

      queryParams.next(holdingParams);

      await settle();

      // The empty command array is the route-agnostic convention - it rewrites the
      // current URL rather than addressing anything - and merging is what preserves
      // every other parameter, a shared portfolio identifier and each co-mounted
      // module's dialog flag among them.
      expect(routerMock.navigate).toHaveBeenCalledTimes(1);
      expect(navigations[0].commands).toEqual([]);
      expect(navigations[0].extras).toMatchObject({
        queryParams: {
          dataSource: null,
          holdingDetailDialog: null,
          symbol: null
        },
        queryParamsHandling: 'merge'
      });
    });
  });

  describe('the system message', () => {
    it('surfaces the message through the notification service', async () => {
      const component = await createComponent();

      stateChanged.next({
        user: createViewer({ systemMessage: { message: 'Under maintenance' } })
      });

      component.onClickSystemMessage();

      expect(notificationServiceMock.alert).toHaveBeenCalledWith({
        title: 'Under maintenance'
      });
    });

    it('ignores the link a system message may carry', async () => {
      const component = await createComponent();

      stateChanged.next({
        user: createViewer({
          systemMessage: {
            message: 'Under maintenance',
            routerLink: ['/admin']
          }
        })
      });

      component.onClickSystemMessage();

      // The link is deliberately dropped: on a single-canvas shell there is no
      // screen to navigate to, so honouring it would resolve to a route that no
      // longer exists.
      expect(routerMock.navigate).not.toHaveBeenCalled();
      expect(notificationServiceMock.alert).toHaveBeenCalledTimes(1);
    });

    it('does nothing at all without a message', async () => {
      const component = await createComponent();

      component.onClickSystemMessage();

      expect(notificationServiceMock.alert).not.toHaveBeenCalled();
      expect(routerMock.navigate).not.toHaveBeenCalled();
    });

    it('renders the message in the banner', async () => {
      await createComponent();

      stateChanged.next({
        user: createViewer({ systemMessage: { message: 'Under maintenance' } })
      });

      fixture.detectChanges();

      expect(
        (fixture.nativeElement as HTMLElement)
          .querySelector('.info-message')
          .textContent.trim()
      ).toBe('Under maintenance');
    });
  });

  describe('creating an account', () => {
    it('opens the registration dialog with the terms step gated by the global permission', async () => {
      const component = await createComponent();

      await component.onCreateAccount();

      const { component: dialogComponent, config } = openedDialog();

      // The shell owns this flow, so the permission gate on it lives here.
      expect(dialogComponent).toBe(GfUserAccountRegistrationDialogComponent);
      expect(config.data).toEqual({
        deviceType: 'desktop',
        needsToAcceptTermsOfService: true
      });
      expect(config.disableClose).toBe(true);
    });

    it.each([
      {
        deviceType: 'desktop',
        expected: { height: undefined, width: '30rem' }
      },
      { deviceType: 'mobile', expected: { height: '98vh', width: '100vw' } }
    ])(
      'sizes the dialog for a $deviceType',
      async ({ deviceType, expected }) => {
        const component = await createComponent({ deviceType });

        await component.onCreateAccount();

        const { config } = openedDialog();

        expect(config.height).toBe(expected.height);
        expect(config.width).toBe(expected.width);
      }
    );

    it('adopts an issued token and then re-reads the viewer, bypassing the cache', async () => {
      const component = await createComponent();

      dialogAfterClosed = of('an-issued-token');

      await component.onCreateAccount();

      // Both halves matter and so does their order. `staySignedIn` is forced on
      // because a freshly created account has no setting to consult; and the forced
      // re-read is what drives the viewer subscription to recompute
      // `canCreateAccount`, which is what dismisses the live-demo banner. An
      // unforced read would be served the cached anonymous viewer and the banner
      // would stay.
      expect(tokenStorageServiceMock.saveToken).toHaveBeenCalledWith(
        'an-issued-token',
        true
      );
      // The transition is announced BEFORE the token is replaced, which is what
      // withdraws layout write authorisation for the interval in which the new
      // credential is in storage and the viewer it belongs to is not yet resolved.
      expect(callOrder).toEqual([
        'beginIdentityTransition',
        'saveToken',
        'get(true)'
      ]);
    });

    // The identity transition is what tells the canvas to stop producing writes for
    // the viewer who is being replaced. Announcing it AFTER the token has been
    // swapped leaves a window in which an arrangement produced by the previous
    // viewer is dispatched with the new viewer's credential, which writes one
    // person's layout onto another's account. Ordering, therefore, not presence.
    it('announces the identity transition before it replaces the token', async () => {
      const component = await createComponent();

      dialogAfterClosed = of('an-issued-token');

      await component.onCreateAccount();

      expect(
        dashboardLayoutServiceMock.beginIdentityTransition
      ).toHaveBeenCalledTimes(1);

      expect(callOrder.indexOf('beginIdentityTransition')).toBe(0);
      expect(callOrder.indexOf('beginIdentityTransition')).toBeLessThan(
        callOrder.indexOf('saveToken')
      );
      expect(callOrder.indexOf('saveToken')).toBeLessThan(
        callOrder.indexOf('get(true)')
      );

      // Nothing here leaves the document: the shell is already on the one route the
      // application has, so adopting an account re-reads the viewer instead.
      expect(routerMock.navigate).not.toHaveBeenCalled();
    });

    it('leaves the document alone when the forced read succeeds', async () => {
      const component = await createComponent();

      dialogAfterClosed = of('an-issued-token');

      await component.onCreateAccount();

      // The reload is the failure path and only the failure path. A reload here
      // would throw away the account the viewer has just created a session for.
      expect(shellDiagnostics).toEqual([]);
    });

    /**
     * The registration dialog's chunk, when it is slow or when it fails.
     *
     * The chunk is loaded from a control the visitor can press twice, with no
     * router in between to absorb the repeat or report the failure.
     */
    it('opens one dialog however many times the control is pressed while loading', async () => {
      const component = await createComponent();

      const answers = deferChunkLoads();

      const first = component.onCreateAccount();
      const second = component.onCreateAccount();

      // The second press is refused outright rather than queued: the control is
      // disabled while a load is outstanding, and a second load would open a second
      // copy of the same dialog on top of the first.
      expect(lazyDialogServiceMock.load).toHaveBeenCalledTimes(1);
      expect(component.isCreatingAccount).toBe(true);

      answers[0](GfUserAccountRegistrationDialogComponent);

      await first;
      await second;

      expect(dialogOpen).toHaveBeenCalledTimes(1);
      expect(component.isCreatingAccount).toBe(false);
    });

    it('opens nothing and releases the control when the chunk cannot be loaded', async () => {
      const component = await createComponent();

      lazyDialogServiceMock.load.mockResolvedValueOnce(null);

      await component.onCreateAccount();

      // The loader has already reported the failure and told the visitor; the shell's
      // remaining obligation is to open nothing and to leave the control usable, so
      // that pressing it again genuinely tries again.
      expect(dialogOpen).not.toHaveBeenCalled();
      expect(component.isCreatingAccount).toBe(false);
      expect(tokenStorageServiceMock.saveToken).not.toHaveBeenCalled();

      await component.onCreateAccount();

      expect(dialogOpen).toHaveBeenCalledTimes(1);
    });

    it('reports a viewer that cannot be read as an event and a status, and nothing the response carried', async () => {
      const component = await createComponent();

      dialogAfterClosed = of('an-issued-token');

      // Shaped like the `HttpErrorResponse` this path really produces. It is the
      // continuation of creating an account, so the failing request is
      // credential-adjacent: its URL, its message and its body are exactly what must
      // not reach a console that every script on the page can read and that
      // session-replay tooling captures verbatim.
      // Replaced with an implementation rather than a return value, so the recorded
      // ordering below still states that the read was attempted at all.
      userServiceGet.mockImplementation((force?: boolean) => {
        callOrder.push(force ? 'get(true)' : 'get()');

        return throwError(() => ({
          error: { detail: 'a-secret-detail' },
          message:
            'Http failure response for https://ghostfol.io/api/v1/user: 503 Service Unavailable',
          status: 503,
          url: 'https://ghostfol.io/api/v1/user?token=an-issued-token'
        }));
      });

      // jsdom implements `window.location` and its members as `[LegacyUnforgeable]`,
      // so `reload` cannot be spied on; it reports its refusal on this very channel
      // instead, which is why the shell's own report is identified by its prefix
      // rather than by being the only thing here.
      const reports: unknown[][] = [];

      // Named apart from the suite-wide harness it stands in front of, because this
      // one deliberately captures EVERYTHING rather than forwarding what it does not
      // recognise - that is the point of the assertion below - and two bindings of
      // one name across two scopes is how a later edit ends up restoring the wrong
      // spy.
      const capturingErrorSpy = jest
        .spyOn(console, 'error')
        .mockImplementation((...args: unknown[]) => {
          reports.push(args);
        });

      try {
        await component.onCreateAccount();
      } finally {
        capturingErrorSpy.mockRestore();
      }

      const shellReports = reports.filter(([first]) => {
        return typeof first === 'string' && first.startsWith('GF-APP-');
      });

      // One argument, and it is a string: a second argument would be the raw error
      // object, which is the whole of what this asserts against. The status is kept
      // because it is what makes the report actionable; nothing else is.
      expect(shellReports).toEqual([
        ['GF-APP-USER-CREATE-READ-FAILED (status 503)']
      ]);

      const emitted = JSON.stringify(reports);

      expect(emitted).not.toContain('an-issued-token');
      expect(emitted).not.toContain('a-secret-detail');
      expect(emitted).not.toContain('Http failure response');

      // The token was still adopted and the read still attempted, so the reload is
      // what recovers the flow rather than the report. The whole order is asserted,
      // including the transition that precedes the token, because a failed read must
      // not have skipped any of the steps that lead to it.
      expect(callOrder).toEqual([
        'beginIdentityTransition',
        'saveToken',
        'get(true)'
      ]);
    });

    it('does nothing when the dialog closes without a token', async () => {
      const component = await createComponent();

      dialogAfterClosed = of(undefined);

      await component.onCreateAccount();

      expect(tokenStorageServiceMock.saveToken).not.toHaveBeenCalled();

      // A cancelled registration is not an identity change. Announcing one would
      // make the canvas discard an arrangement the viewer never stopped owning.
      expect(
        dashboardLayoutServiceMock.beginIdentityTransition
      ).not.toHaveBeenCalled();
      expect(navigationAttempts).toHaveLength(0);
      expect(callOrder).toEqual([]);
    });

    it('offers account creation only to a viewer entitled to it', async () => {
      const component = await createComponent();

      stateChanged.next({
        user: createViewer({ permissions: [permissions.createUserAccount] })
      });

      expect(component.canCreateAccount).toBe(true);
      expect(component.hasInfoMessage).toBe(true);

      stateChanged.next({ user: createViewer() });

      expect(component.canCreateAccount).toBe(false);
      expect(component.hasInfoMessage).toBe(false);
    });
  });

  /**
   * The shell's own departure, which is a different code path from the toolbar's.
   *
   * Both offer signing out and both perform the same three steps, but they are two
   * methods on two components: a suite covering one says nothing about the other,
   * and the shell's was the one with no coverage at all. The ordering is what is
   * being protected. A document-level navigation replaces the document rather than
   * routing within it, so nothing downstream of it ever runs and an arrangement
   * still inside its 500 ms debounce would be dropped in silence; and `signOut()`
   * clears the very token the flush is authorised with, so flushing after it would
   * issue a request that cannot succeed.
   */
  describe('signing out', () => {
    // The jsdom navigation harness lives in the suite-wide `beforeEach`, which both
    // departures this shell performs are observed through. A second spy on
    // `console.error` here would sit on top of that one and swallow the reports it
    // is meant to forward, so the shared harness is used rather than duplicated -
    // and `document.documentElement.lang` is already restored by the shared
    // `afterEach`, because the sign-out destination is composed from it.
    beforeEach(() => {
      document.documentElement.lang = 'en';
    });

    it('flushes the pending arrangement, then signs out, then leaves the document', async () => {
      document.documentElement.lang = 'de';

      const component = await createComponent();

      component.onSignOut();

      expect(
        dashboardLayoutServiceMock.releasePendingSave
      ).toHaveBeenCalledTimes(1);
      expect(userServiceSignOut).toHaveBeenCalledTimes(1);
      expect(navigationAttempts).toHaveLength(1);

      expect(callOrder).toEqual(['releasePendingSave', 'signOut', 'navigate']);
    });

    it('forces the pending arrangement out before anything else happens', async () => {
      document.documentElement.lang = 'de';

      const component = await createComponent();

      component.onSignOut();

      // Ordering, not merely presence. After the identity is discarded the write
      // would be issued for nobody, and after the document is left it would never
      // be issued at all.
      expect(callOrder.indexOf('releasePendingSave')).toBeLessThan(
        callOrder.indexOf('signOut')
      );
      expect(callOrder.indexOf('releasePendingSave')).toBeLessThan(
        callOrder.indexOf('navigate')
      );
    });

    it('flushes even when the departure itself goes nowhere', async () => {
      // The locale is what the destination is composed from, and an absent one
      // resolves to the address the document is already on - which jsdom performs
      // no navigation for. The flush must not be conditional on that: the
      // arrangement is pending either way.
      document.documentElement.lang = '';

      const component = await createComponent();

      component.onSignOut();

      expect(
        dashboardLayoutServiceMock.releasePendingSave
      ).toHaveBeenCalledTimes(1);
      expect(userServiceSignOut).toHaveBeenCalledTimes(1);
      expect(navigationAttempts).toHaveLength(0);
      expect(window.location.href).toBe('http://localhost/');
    });

    it('leaves the document rather than routing within it', async () => {
      document.documentElement.lang = 'de';

      const component = await createComponent();

      component.onSignOut();

      // A full load discards every in-memory cache belonging to the identity that
      // has just left; routing within the application would not. The shell also
      // still owns exactly one route, so there is nowhere to route to.
      expect(navigationAttempts).toHaveLength(1);
      expect(routerMock.navigate).not.toHaveBeenCalled();
    });

    it('announces no identity transition, because nobody is taking over', async () => {
      document.documentElement.lang = 'de';

      const component = await createComponent();

      component.onSignOut();

      // A transition is announced when one identity replaces another, which is
      // what re-arms the canvas. Signing out ends the session instead, and
      // announcing a transition here would ask a canvas that is about to be
      // discarded to hydrate.
      expect(
        dashboardLayoutServiceMock.beginIdentityTransition
      ).not.toHaveBeenCalled();
    });

    it('flushes the pending arrangement before discarding the session', async () => {
      const component = await createComponent({ viewer: createViewer() });

      document.documentElement.lang = 'de';

      component.onSignOut();

      // Ordering, not merely presence. After the credentials are cleared the write
      // would be issued for nobody, and after the document is left it would never
      // be issued at all.
      expect(callOrder).toEqual(['releasePendingSave', 'signOut', 'navigate']);
      expect(navigationAttempts).toHaveLength(1);
    });

    it('waits for the flush to settle', async () => {
      const flush = new Subject<void>();

      const component = await createComponent({ viewer: createViewer() });

      dashboardLayoutServiceMock.releasePendingSave.mockReturnValue(
        flush.asObservable()
      );

      document.documentElement.lang = 'de';

      component.onSignOut();

      // Still signed in: the write has not answered, so nothing has been cleared
      // and no address has been assigned.
      expect(signOut).not.toHaveBeenCalled();
      expect(navigationAttempts).toHaveLength(0);

      flush.complete();

      expect(signOut).toHaveBeenCalledTimes(1);
      expect(navigationAttempts).toHaveLength(1);
    });

    it('tells the viewer when the arrangement could not be stored', async () => {
      // Declared, because this test provokes the failure it is about: the sanitized
      // marker is expected output rather than an escaped error, and naming it here
      // is what keeps every other report a failure.
      expectedErrorReports.push(SIGN_OUT_FLUSH_FAILED_REPORT);

      const component = await createComponent({ viewer: createViewer() });

      dashboardLayoutServiceMock.releasePendingSave.mockReturnValue(
        throwError(() => new Error('flush failed'))
      );

      document.documentElement.lang = 'de';

      component.onSignOut();

      // Told rather than left to guess, and nothing else has happened yet: the
      // departure waits on the acknowledgement. The failure is also reported
      // through the sanitized channel, carrying the marker and nothing else.
      expect(notificationServiceMock.alert).toHaveBeenCalledTimes(1);
      expect(errorReports).toEqual([SIGN_OUT_FLUSH_FAILED_REPORT]);
      expect(signOut).not.toHaveBeenCalled();
      expect(navigationAttempts).toHaveLength(0);
    });

    it('still lets the viewer leave once they acknowledge the failure', async () => {
      // Same deliberate failure as above, so the same marker is declared here.
      expectedErrorReports.push(SIGN_OUT_FLUSH_FAILED_REPORT);

      const component = await createComponent({ viewer: createViewer() });

      dashboardLayoutServiceMock.releasePendingSave.mockReturnValue(
        throwError(() => new Error('flush failed'))
      );

      document.documentElement.lang = 'de';

      component.onSignOut();

      notificationServiceMock.alert.mock.calls[0][0].discardFn();

      // A viewer who asks to leave must always be able to; an arrangement that can
      // never be stored would otherwise hold them in the session indefinitely.
      expect(signOut).toHaveBeenCalledTimes(1);
      expect(navigationAttempts).toHaveLength(1);
    });
  });

  describe('the shell itself', () => {
    it('renders the router outlet rather than mounting the canvas itself', async () => {
      await createComponent();

      // The outlet is replaced in this harness, so its presence is asserted through
      // the element the template declares. The router still owns the one root route
      // and still activates the canvas through it.
      expect(
        (fixture.nativeElement as HTMLElement).querySelector(
          'main[role="main"]'
        )
      ).toBeTruthy();
    });

    it('renders no navigation chrome', async () => {
      await createComponent();

      const host = fixture.nativeElement as HTMLElement;

      // The header element survives as the banner's container; what must not come
      // back is either chrome component.
      expect(host.querySelector('gf-header')).toBeNull();
      expect(host.querySelector('gf-footer')).toBeNull();
    });

    it('issues no navigation of its own while nothing is addressed', async () => {
      await createComponent();

      stateChanged.next({ user: createViewer() });

      expect(routerMock.navigate).not.toHaveBeenCalled();
    });

    it('applies the operating system colour scheme before a viewer resolves', async () => {
      await createComponent();

      // The stub reports the light preference, and the shell has to have acted on
      // it during construction rather than waiting for a viewer: the first frame is
      // painted before anyone is signed in.
      expect(document.body.classList.contains('theme-light')).toBe(true);
      expect(document.body.classList.contains('theme-dark')).toBe(false);
    });

    it('lets a viewer preference override the operating system', async () => {
      await createComponent();

      stateChanged.next({
        user: createViewer({
          settings: { baseCurrency: 'CHF', colorScheme: 'DARK' }
        })
      });

      expect(document.body.classList.contains('theme-dark')).toBe(true);
      expect(document.body.classList.contains('theme-light')).toBe(false);
    });

    it('follows the operating system only while the viewer expressed no preference', async () => {
      await createComponent();

      stateChanged.next({
        user: createViewer({ settings: { baseCurrency: 'CHF' } })
      });

      for (const listener of colorSchemeListeners) {
        listener({ matches: true });
      }

      expect(document.body.classList.contains('theme-dark')).toBe(true);

      stateChanged.next({
        user: createViewer({
          settings: { baseCurrency: 'CHF', colorScheme: 'LIGHT' }
        })
      });

      for (const listener of colorSchemeListeners) {
        listener({ matches: true });
      }

      // An explicit choice wins: the system switching to dark must not undo it.
      expect(document.body.classList.contains('theme-light')).toBe(true);
    });

    // The theme is applied on EVERY emission of the viewer's record, and that
    // record is re-emitted by anything that changes a setting - so registering the
    // system listener alongside the theme it applies would add one more listener
    // each time, none of them ever removed, each re-running the same work.
    it('watches the operating system once, however many times the viewer record arrives', async () => {
      await createComponent();

      expect(colorSchemeListeners).toHaveLength(1);

      for (let emission = 0; emission < 5; emission += 1) {
        stateChanged.next({
          user: createViewer({ settings: { baseCurrency: 'CHF' } })
        });
      }

      expect(colorSchemeListeners).toHaveLength(1);
    });

    it('stops watching the operating system when the shell goes away', async () => {
      await createComponent();

      expect(colorSchemeListeners).toHaveLength(1);

      fixture.destroy();

      // Released rather than left behind: the listener closes over the component, so
      // an un-removed one keeps it alive and keeps re-theming a torn-down shell.
      expect(colorSchemeListeners).toHaveLength(0);
    });

    it('survives a viewer request that never answers', async () => {
      await createComponent();

      userServiceGet.mockReturnValue(EMPTY);

      queryParams.next({
        dataSource: 'YAHOO',
        holdingDetailDialog: true,
        symbol: 'AAPL'
      });

      // The dialog is opened from inside the viewer read, so a read that never
      // answers has to leave the shell intact rather than half-open.
      expect(dialogOpen).not.toHaveBeenCalled();
      expect(routerMock.navigate).not.toHaveBeenCalled();
    });
  });
});
