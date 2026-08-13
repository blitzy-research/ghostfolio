import { GfLoginWithAccessTokenDialogComponent } from '@ghostfolio/client/components/login-with-access-token-dialog/login-with-access-token-dialog.component';
import { GfUserAccountRegistrationDialogComponent } from '@ghostfolio/client/components/user-account-registration-dialog/user-account-registration-dialog.component';
import { LazyDialogService } from '@ghostfolio/client/core/lazy-dialog.service';
import { GfDashboardLayoutService } from '@ghostfolio/client/dashboard/services/dashboard-layout.service';
import {
  KEY_STAY_SIGNED_IN,
  SettingsStorageService
} from '@ghostfolio/client/services/settings-storage.service';
import { TokenStorageService } from '@ghostfolio/client/services/token-storage.service';
import { UserService } from '@ghostfolio/client/services/user/user.service';
import { permissions } from '@ghostfolio/common/permissions';
import { NotificationService } from '@ghostfolio/ui/notifications';
import { DataService } from '@ghostfolio/ui/services';

import { ComponentFixture, TestBed } from '@angular/core/testing';
import { MatDialog } from '@angular/material/dialog';
import { Router } from '@angular/router';
import { DeviceDetectorService } from 'ngx-device-detector';
import { Observable, config as rxjsConfig, of, throwError } from 'rxjs';

import { GfSignInPromptComponent } from './sign-in-prompt.component';

/**
 * The unauthenticated state of the single root route - the first and only screen a
 * signed-out visitor meets.
 *
 * It is the sole home of three flows, and each of them fails silently rather than
 * loudly if it regresses, which is why they are asserted here rather than left to
 * the canvas suite that merely mounts this component:
 *
 * 1. **Access-token sign-in.** The sibling toolbar deliberately does *not* carry it
 *    - it renders only once a viewer has resolved, so a sign-in control there would
 *    be unreachable - and asserts its own absence. That makes this the only place
 *    the capability exists, and therefore the only place it can be exercised.
 * 2. **The five deployment capability probes.** `enableAuthGoogle`, `enableAuthOidc`,
 *    `enableAuthToken`, `enableSubscription` and `createUserAccount` are read once,
 *    synchronously, and handed to the dialog that renders the corresponding
 *    authentication paths. A dropped probe does not fail - it quietly hides a
 *    sign-in path for every deployment that enables it, and the OIDC probe in
 *    particular exists nowhere else in the application.
 * 3. **Account registration**, carrying a deliberate asymmetry against
 *    {@link GfSignInPromptComponent.setToken}: a freshly issued token is persisted
 *    with stay-signed-in forced on, without consulting the preference at all.
 *
 * Two negative assertions carry as much weight as the positive ones. Calling
 * `userService.signOut()` from a **constructor** is catastrophic on the root route,
 * where a transient render would wipe a live session; `performs no session mutation
 * while being constructed` is the committed guard against it. And
 * `reports an incorrect token and leaves the flow usable` is what proves the failure
 * branch returns `EMPTY` rather than re-throwing: a re-throw would kill the
 * subscription, so the alert would appear once and every subsequent attempt would be
 * inert - a defect no single-attempt test can see.
 *
 * `MatDialog` and `Router` are recording stubs. What matters is the request this
 * component makes and what it does with the answer; each dialog's own rendering
 * belongs to that dialog's suite, and on a single-canvas shell no navigation selects
 * a screen. Document navigation cannot be observed directly - jsdom refuses it and
 * reports through `console.error` without naming the target, and `window.location`
 * is not redefinable - so the two branches of `setToken` are separated by the pair
 * of facts that *do* distinguish them: a blocked document navigation was reported
 * and the router was not asked, or the reverse. The component's own failure reports
 * arrive on the same channel and are told apart from jsdom's by their sanitized
 * event identifier, which is also what makes their content assertable.
 */
describe('GfSignInPromptComponent', () => {
  const JSDOM_NAVIGATION_REPORT = 'Not implemented: navigation';

  /** Every capability the login dialog can be asked to render, plus the two account ones. */
  const allGlobalPermissions = [
    permissions.createUserAccount,
    permissions.enableAuthGoogle,
    permissions.enableAuthOidc,
    permissions.enableAuthToken,
    permissions.enableSubscription
  ];

  let component: GfSignInPromptComponent;
  let fixture: ComponentFixture<GfSignInPromptComponent>;

  /**
   * What the next dialog resolves with, read at `afterClosed()` time rather than
   * captured when the stub is built, so a single test can close one dialog with a
   * token and the next without one.
   */
  let dialogAfterClosed: Observable<unknown>;
  let dialogOpen: jest.Mock;

  /**
   * Every dialog request, recorded through a typed side effect. Read back off
   * `dialogOpen.mock.calls` instead and the element type is `any`, at which point an
   * assertion about the component or its configuration stops being checked by the
   * compiler - exactly the kind of assertion that keeps passing after the thing it
   * describes has been renamed.
   */
  let dialogRequests: {
    component: unknown;
    config: {
      autoFocus?: boolean | string;
      data?: Record<string, unknown>;
      disableClose?: boolean;
      height?: string;
      width?: string;
    };
  }[];

  let notificationServiceMock: { alert: jest.Mock };
  let routerMock: { navigate: jest.Mock };
  let settingsStorageServiceMock: { getSetting: jest.Mock };
  let tokenStorageServiceMock: { saveToken: jest.Mock };
  let userServiceMock: { get: jest.Mock; signOut: jest.Mock };
  let dataServiceMock: { fetchInfo: jest.Mock; loginAnonymous: jest.Mock };

  /** What `loginAnonymous` answers with, swappable mid-test for the retry case. */
  let loginAnonymousResult: Observable<{ authToken: string }>;

  /** What the stay-signed-in preference currently reads as. */
  let staySignedInSetting: string;

  /**
   * What the viewer re-read resolves with. Modelled as the whole answer rather than
   * just a language so that the shapes which carry no language at all - a viewer
   * without settings, or no viewer - are expressible, since those are what the
   * optional chaining in `setToken` exists for.
   */
  let viewer: { settings?: { language?: string } } | null;

  /** Ordering between effects that would otherwise be unordered. */
  let callOrder: string[];

  /**
   * The layout store, present only for the announcement this component makes to it.
   * Between storing a credential and resolving the viewer it belongs to there must be
   * no interval in which a layout write is authorised, and the announcement is what
   * withdraws that authorisation - so it is recorded in {@link callOrder}, where
   * ordering rather than mere occurrence is assertable.
   */
  let dashboardLayoutServiceMock: { beginIdentityTransition: jest.Mock };

  /**
   * The shared lazy-dialog loader, stubbed so a chunk load can be made slow or made
   * to fail on demand.
   *
   * By default it performs the loader it is handed, which is what the real service
   * does on the happy path - so every existing expectation about which component was
   * opened still holds against the real class. Deduplication across components and
   * the visible failure report are the service's own contract, asserted in its own
   * suite; what is asserted here is what this CARD does with a slow or failed load.
   */
  let lazyDialogServiceMock: {
    isLoading: jest.Mock<boolean, [string]>;
    load: jest.Mock<Promise<unknown>, [string, () => Promise<unknown>]>;
  };

  /** Blocked document navigations, collected from jsdom's own report. */
  let navigationAttempts: string[];

  /**
   * Everything this component reported about a failure, verbatim.
   *
   * Collected rather than merely swallowed because these two paths are
   * credential-adjacent - one follows a token the viewer supplied, the other the
   * account that was just created for them - so what a failure is allowed to say is
   * part of the contract. A raw `HttpErrorResponse` here would carry the request
   * URL and the response body into a console that every script on the page can read
   * and that session-replay tooling captures verbatim.
   */
  let sanitizedReports: string[];

  let consoleErrorSpy: jest.SpyInstance;
  let originalDocumentLanguage: string;

  const createComponent = async ({
    deviceType = 'desktop',
    globalPermissions = [] as string[]
  }: { deviceType?: string; globalPermissions?: string[] } = {}) => {
    dataServiceMock = {
      fetchInfo: jest.fn(() => ({ globalPermissions })),
      loginAnonymous: jest.fn(() => loginAnonymousResult)
    };

    lazyDialogServiceMock = {
      isLoading: jest.fn<boolean, [string]>(() => false),
      load: jest.fn((_aKey: string, aLoad: () => Promise<unknown>) => aLoad())
    };

    await TestBed.configureTestingModule({
      imports: [GfSignInPromptComponent],
      providers: [
        { provide: DataService, useValue: dataServiceMock },
        {
          provide: DeviceDetectorService,
          useValue: { getDeviceInfo: () => ({ deviceType }) }
        },
        {
          provide: GfDashboardLayoutService,
          useValue: dashboardLayoutServiceMock
        },
        { provide: LazyDialogService, useValue: lazyDialogServiceMock },
        { provide: MatDialog, useValue: { open: dialogOpen } },
        { provide: NotificationService, useValue: notificationServiceMock },
        { provide: Router, useValue: routerMock },
        {
          provide: SettingsStorageService,
          useValue: settingsStorageServiceMock
        },
        { provide: TokenStorageService, useValue: tokenStorageServiceMock },
        { provide: UserService, useValue: userServiceMock }
      ]
    }).compileComponents();

    fixture = TestBed.createComponent(GfSignInPromptComponent);
    component = fixture.componentInstance;

    fixture.detectChanges();

    return component;
  };

  /** The dialog request that was made last, or `undefined` if none was. */
  const openedDialog = () => {
    return dialogRequests.at(-1);
  };

  /**
   * Makes every chunk load wait, and hands back the means to answer each one.
   *
   * A dialog's chunk is a network request, so the state worth asserting is the one
   * that takes time: a second press arriving while the first load is still
   * resolving. It is not observable with a load that settles immediately.
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

  const host = () => fixture.nativeElement as HTMLElement;

  /**
   * Resolves a control by the text it carries rather than by position, so that
   * reordering the card does not silently repoint an assertion at the other button.
   */
  const buttonLabelled = (label: string) => {
    return Array.from(host().querySelectorAll('button')).find((button) => {
      return button.textContent?.trim() === label;
    });
  };

  beforeEach(() => {
    callOrder = [];
    dialogAfterClosed = of(undefined);
    dialogRequests = [];
    loginAnonymousResult = of({ authToken: 'an-auth-token' });
    navigationAttempts = [];
    sanitizedReports = [];
    staySignedInSetting = null;
    viewer = { settings: { language: 'en' } };

    dialogOpen = jest.fn(
      (
        dialogComponent: unknown,
        config: {
          autoFocus?: boolean | string;
          data?: Record<string, unknown>;
          disableClose?: boolean;
          height?: string;
          width?: string;
        }
      ) => {
        dialogRequests.push({ component: dialogComponent, config });

        return { afterClosed: () => dialogAfterClosed };
      }
    );

    dashboardLayoutServiceMock = {
      beginIdentityTransition: jest.fn(() => {
        callOrder.push('beginIdentityTransition');
      })
    };

    notificationServiceMock = {
      alert: jest.fn(() => {
        callOrder.push('alert');
      })
    };

    routerMock = {
      navigate: jest.fn(() => {
        callOrder.push('navigate');

        return Promise.resolve(true);
      })
    };

    settingsStorageServiceMock = {
      getSetting: jest.fn(() => staySignedInSetting)
    };

    tokenStorageServiceMock = {
      saveToken: jest.fn(() => {
        callOrder.push('saveToken');
      })
    };

    userServiceMock = {
      get: jest.fn((force?: boolean) => {
        callOrder.push(force ? 'get(true)' : 'get()');

        return of(viewer);
      }),
      signOut: jest.fn(() => {
        callOrder.push('signOut');
      })
    };

    originalDocumentLanguage = document.documentElement.lang;

    // Pinned so that a viewer declaring the same language resolves to the address
    // the document is already on, which is the condition under which jsdom performs
    // no navigation - and therefore what lets an empty attempt list stand as an
    // exact statement rather than an accident of the environment's default.
    document.documentElement.lang = 'en';

    // Asserted on the expression rather than on the binding, so the stored value is
    // typed too and not merely the name it is stored under: `Function.prototype.bind`
    // widens its result to `any`, which would make every forwarded report an
    // unchecked call.
    const reportError = console.error.bind(console) as (
      ...args: unknown[]
    ) => void;

    consoleErrorSpy = jest
      .spyOn(console, 'error')
      .mockImplementation((...args: unknown[]) => {
        const [detail] = args;

        // Recognised by its shape rather than with `instanceof`: jsdom raises this
        // from its own realm, so `detail instanceof Error` is false for the very
        // object that arrives. Measured, not assumed - narrowing that way silently
        // stops matching.
        const report =
          Object.prototype.toString.call(detail) === '[object Error]'
            ? (detail as Error).message
            : typeof detail === 'string'
              ? detail
              : '';

        if (report.includes(JSDOM_NAVIGATION_REPORT)) {
          callOrder.push('leaveTheApplication');
          navigationAttempts.push(report);

          return;
        }

        // The component's own diagnostic, emitted on every path that gives up on
        // reading the viewer before it reloads. Swallowed rather than forwarded so
        // the suite output stays readable, and recorded - in full - so both its
        // presence and its content are assertable rather than merely tolerated.
        //
        // Matched on the sanitized identifier prefix, which is the whole point: the
        // failure is reported as a fixed event and a numeric status through
        // `reportSanitizedError`, so anything arriving here that is not a single
        // string beginning that way is a raw error object and falls through to the
        // real console, where the recorded reports below will not account for it.
        if (report.startsWith('GF-SIGN-IN-PROMPT-')) {
          callOrder.push('reportFailure');
          sanitizedReports.push(report);

          return;
        }

        reportError(...args);
      });
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();

    document.documentElement.lang = originalDocumentLanguage;

    jest.restoreAllMocks();
  });

  describe('the capabilities the deployment declares', () => {
    it('grants every capability a fully enabled deployment declares', async () => {
      await createComponent({ globalPermissions: allGlobalPermissions });

      expect(component.hasPermissionForAuthGoogle).toBe(true);
      expect(component.hasPermissionForAuthOidc).toBe(true);
      expect(component.hasPermissionForAuthToken).toBe(true);
      expect(component.hasPermissionForSubscription).toBe(true);
      expect(component.hasPermissionToCreateUser).toBe(true);
    });

    it('withholds every capability a bare deployment does not declare', async () => {
      await createComponent();

      expect(component.hasPermissionForAuthGoogle).toBe(false);
      expect(component.hasPermissionForAuthOidc).toBe(false);
      expect(component.hasPermissionForAuthToken).toBe(false);
      expect(component.hasPermissionForSubscription).toBe(false);
      expect(component.hasPermissionToCreateUser).toBe(false);
    });

    // One probe at a time, with the others withheld. Asserting the granted field
    // alone would pass just as well if every probe read the same constant, so each
    // case also asserts that its four siblings stayed false - which is what pins
    // each field to its own permission rather than merely to "some permission".
    it.each([
      {
        field: 'hasPermissionForAuthGoogle' as const,
        permission: permissions.enableAuthGoogle
      },
      {
        field: 'hasPermissionForAuthOidc' as const,
        permission: permissions.enableAuthOidc
      },
      {
        field: 'hasPermissionForAuthToken' as const,
        permission: permissions.enableAuthToken
      },
      {
        field: 'hasPermissionForSubscription' as const,
        permission: permissions.enableSubscription
      },
      {
        field: 'hasPermissionToCreateUser' as const,
        permission: permissions.createUserAccount
      }
    ])(
      'derives $field from $permission alone',
      async ({ field, permission }) => {
        await createComponent({ globalPermissions: [permission] });

        const probes = [
          'hasPermissionForAuthGoogle',
          'hasPermissionForAuthOidc',
          'hasPermissionForAuthToken',
          'hasPermissionForSubscription',
          'hasPermissionToCreateUser'
        ] as const;

        for (const probe of probes) {
          expect(component[probe]).toBe(probe === field);
        }
      }
    );

    it('reads deployment info exactly once, and synchronously', async () => {
      await createComponent();

      // The accessor deep-clones on every call, which is why the component holds the
      // result instead of re-reading it; a synchronous return is also what makes the
      // capabilities settled by the end of initialisation rather than after a tick.
      expect(dataServiceMock.fetchInfo).toHaveBeenCalledTimes(1);
    });

    it('resolves the device class through the accessor the application uses', async () => {
      await createComponent({ deviceType: 'mobile' });

      expect(component.deviceType).toBe('mobile');
    });

    it('performs no session mutation while being constructed', async () => {
      await createComponent({ globalPermissions: allGlobalPermissions });

      // Signing the viewer out from a constructor is harmless on a route only a
      // signed-out visitor reaches; on the root route it wipes the session of
      // anyone who renders this component transiently. Nothing may be adopted,
      // discarded or re-read merely by initialising.
      expect(userServiceMock.signOut).not.toHaveBeenCalled();
      expect(userServiceMock.get).not.toHaveBeenCalled();
      expect(tokenStorageServiceMock.saveToken).not.toHaveBeenCalled();
      expect(dialogOpen).not.toHaveBeenCalled();
      expect(callOrder).toEqual([]);
    });
  });

  describe('signing in with an access token', () => {
    it('offers the dialog every authentication path the deployment enables', async () => {
      await createComponent({ globalPermissions: allGlobalPermissions });

      await component.openLoginDialog();

      const { component: dialogComponent, config } = openedDialog();

      expect(dialogOpen).toHaveBeenCalledTimes(1);
      expect(dialogComponent).toBe(GfLoginWithAccessTokenDialogComponent);
      expect(config.data).toEqual({
        accessToken: '',
        hasPermissionToUseAuthGoogle: true,
        hasPermissionToUseAuthOidc: true,
        hasPermissionToUseAuthToken: true,
        title: 'Sign in'
      });
      // Not `false`, which is what this asserted while the dialog opened with focus
      // on its own container: an element with `tabindex="-1"` and no name, reached
      // by keyboard and screen-reader visitors instead of the field they came for.
      // The CDK reads the dialog's `cdkFocusInitial` marker in this branch and in no
      // other, so the value is the fix rather than a detail of it.
      expect(config.autoFocus).toBe('first-tabbable');
      expect(config.width).toBe('30rem');
    });

    it('offers the dialog no authentication path the deployment withholds', async () => {
      await createComponent();

      await component.openLoginDialog();

      // The dialog renders the token field, the Google anchor and the OpenID Connect
      // anchor from these three flags alone, so passing a granted flag as withheld
      // hides a working sign-in route with no other outward sign.
      expect(openedDialog().config.data).toMatchObject({
        hasPermissionToUseAuthGoogle: false,
        hasPermissionToUseAuthOidc: false,
        hasPermissionToUseAuthToken: false
      });
    });

    it('exchanges the entered token through the anonymous login endpoint', async () => {
      await createComponent({ globalPermissions: allGlobalPermissions });

      dialogAfterClosed = of({ accessToken: 'an-access-token' });

      await component.openLoginDialog();

      expect(dataServiceMock.loginAnonymous).toHaveBeenCalledWith(
        'an-access-token'
      );
    });

    // The stay-signed-in preference is what decides whether the issued token
    // outlives the tab. `getSetting` returns a raw string, so anything other than
    // the exact `'true'` must resolve to session-only storage - including the absent
    // case, which is what a first-time visitor reads.
    it.each([
      { description: 'the preference is set', expected: true, setting: 'true' },
      {
        description: 'the preference is explicitly off',
        expected: false,
        setting: 'false'
      },
      {
        description: 'the preference was never written',
        expected: false,
        setting: null
      },
      {
        description: 'the preference reads as something else entirely',
        expected: false,
        setting: 'TRUE'
      }
    ])(
      'persists the issued token with staySignedIn $expected when $description',
      async ({ expected, setting }) => {
        staySignedInSetting = setting;

        await createComponent({ globalPermissions: allGlobalPermissions });

        dialogAfterClosed = of({ accessToken: 'an-access-token' });

        await component.openLoginDialog();

        expect(settingsStorageServiceMock.getSetting).toHaveBeenCalledWith(
          KEY_STAY_SIGNED_IN
        );
        expect(tokenStorageServiceMock.saveToken).toHaveBeenCalledWith(
          'an-auth-token',
          expected
        );
      }
    );

    it('re-reads the viewer only after the token has been persisted', async () => {
      await createComponent({ globalPermissions: allGlobalPermissions });

      dialogAfterClosed = of({ accessToken: 'an-access-token' });

      await component.openLoginDialog();

      // Order, not merely occurrence: the re-read is authenticated by the token that
      // was just stored, so a read issued first would be made anonymously and would
      // resolve the viewer the canvas is trying to leave behind. The announcement
      // comes first for the same class of reason - it withdraws the authorisation to
      // write a layout, so there is no interval in which the outgoing viewer's
      // arrangement could be saved under the incoming one's identity. The read is
      // forced because an unforced one is served from the store whenever it holds
      // anything at all.
      expect(callOrder).toEqual([
        'beginIdentityTransition',
        'saveToken',
        'get(true)',
        'navigate'
      ]);
    });

    it.each([
      { closedWith: undefined, description: 'the dialog was dismissed' },
      { closedWith: {}, description: 'no token was entered' },
      {
        closedWith: { accessToken: '' },
        description: 'the token field was left empty'
      }
    ])('exchanges nothing when $description', async ({ closedWith }) => {
      await createComponent({ globalPermissions: allGlobalPermissions });

      dialogAfterClosed = of(closedWith);

      await component.openLoginDialog();

      expect(dataServiceMock.loginAnonymous).not.toHaveBeenCalled();
      expect(tokenStorageServiceMock.saveToken).not.toHaveBeenCalled();
      expect(callOrder).toEqual([]);
    });

    it('reports an incorrect token and adopts nothing', async () => {
      await createComponent({ globalPermissions: allGlobalPermissions });

      dialogAfterClosed = of({ accessToken: 'a-rejected-token' });
      loginAnonymousResult = throwError(() => new Error('401'));

      await component.openLoginDialog();

      // The message is the whole of the failure handling, and it is byte-frozen:
      // thirteen XLIFF files already carry this trans-unit, and Angular derives the
      // translation id from the content, so one changed character silently mints an
      // untranslated unit in twelve locales.
      expect(notificationServiceMock.alert).toHaveBeenCalledTimes(1);
      expect(notificationServiceMock.alert).toHaveBeenCalledWith({
        title: 'Oops! Incorrect Security Token.'
      });
      expect(tokenStorageServiceMock.saveToken).not.toHaveBeenCalled();
      expect(userServiceMock.get).not.toHaveBeenCalled();
      expect(navigationAttempts).toHaveLength(0);
    });

    it('lets no error escape the failure branch', async () => {
      await createComponent({ globalPermissions: allGlobalPermissions });

      // The token exchange is subscribed to without an error callback, so anything
      // the failure branch re-raises instead of swallowing becomes an unhandled RxJS
      // error - reported out of band, on a later macrotask, where no assertion about
      // the alert or about what was persisted can see it. RxJS's own hook is the
      // deterministic way to observe that, and installing it is what turns "the
      // alert was raised" into "the alert was the whole of the failure handling".
      const unhandledErrors: unknown[] = [];
      const previousOnUnhandledError = rxjsConfig.onUnhandledError;

      rxjsConfig.onUnhandledError = (error: unknown) => {
        unhandledErrors.push(error);
      };

      try {
        dialogAfterClosed = of({ accessToken: 'a-rejected-token' });
        loginAnonymousResult = throwError(() => new Error('401'));

        await component.openLoginDialog();

        // Queued after the report RxJS scheduled while the exchange was failing, so
        // the drain is ordered rather than merely hopeful.
        await new Promise((resolve) => setTimeout(resolve, 0));
      } finally {
        rxjsConfig.onUnhandledError = previousOnUnhandledError;
      }

      expect(notificationServiceMock.alert).toHaveBeenCalledTimes(1);
      expect(unhandledErrors).toEqual([]);
    });

    it('leaves the flow usable after a rejected token', async () => {
      await createComponent({ globalPermissions: allGlobalPermissions });

      dialogAfterClosed = of({ accessToken: 'a-rejected-token' });
      loginAnonymousResult = throwError(() => new Error('401'));

      await component.openLoginDialog();

      dialogAfterClosed = of({ accessToken: 'an-accepted-token' });
      loginAnonymousResult = of({ authToken: 'an-auth-token' });

      await component.openLoginDialog();

      // This is what `catchError` returning `EMPTY` buys, and it cannot be seen from
      // a single attempt: re-throwing would surface the same alert once and then
      // leave every later attempt inert, because the failure would tear the
      // subscription down instead of completing it.
      expect(dialogOpen).toHaveBeenCalledTimes(2);
      expect(notificationServiceMock.alert).toHaveBeenCalledTimes(1);
      expect(tokenStorageServiceMock.saveToken).toHaveBeenCalledWith(
        'an-auth-token',
        false
      );
    });
  });

  describe('adopting a token', () => {
    it('stays on the canvas when the viewer speaks the document language', async () => {
      await createComponent({ globalPermissions: allGlobalPermissions });

      component.setToken('an-auth-token');

      // `/` is already the active route, so this request is satisfied immediately and
      // selects nothing; the canvas re-hydrates from the viewer re-read above. What
      // matters here is that the application is not left, because leaving it would
      // discard the session that was just established.
      expect(routerMock.navigate).toHaveBeenCalledWith(['/']);
      expect(navigationAttempts).toHaveLength(0);
    });

    it('leaves for the viewer own locale when it differs from the document', async () => {
      viewer = { settings: { language: 'de' } };

      await createComponent({ globalPermissions: allGlobalPermissions });

      component.setToken('an-auth-token');

      // Each locale is deployed under its own base path, so this one transition
      // genuinely has to leave the application rather than route within it. jsdom
      // refuses the navigation and reports it; the router being untouched is the
      // other half of the statement.
      expect(navigationAttempts).toHaveLength(1);
      expect(routerMock.navigate).not.toHaveBeenCalled();
      expect(callOrder).toEqual([
        'beginIdentityTransition',
        'saveToken',
        'get(true)',
        'leaveTheApplication'
      ]);
    });

    // The three shapes that carry no language between them. None may be allowed to
    // leave the application: without a language there is no other locale to leave
    // for, and an unguarded read would compose `../undefined` and strand the visitor
    // on a base path that does not exist.
    it.each([
      {
        description: 'the viewer declares no language',
        resolvedViewer: { settings: { language: undefined } }
      },
      {
        description: 'the viewer carries no settings at all',
        resolvedViewer: {}
      },
      { description: 'no viewer resolves', resolvedViewer: null }
    ])('stays on the canvas when $description', async ({ resolvedViewer }) => {
      viewer = resolvedViewer;

      await createComponent({ globalPermissions: allGlobalPermissions });

      component.setToken('an-auth-token');

      expect(routerMock.navigate).toHaveBeenCalledWith(['/']);
      expect(navigationAttempts).toHaveLength(0);
    });
  });

  describe('creating an account', () => {
    it('opens the registration dialog with the terms step gated by the global permission', async () => {
      await createComponent({ globalPermissions: allGlobalPermissions });

      await component.openShowAccessTokenDialog();

      const { component: dialogComponent, config } = openedDialog();

      expect(dialogComponent).toBe(GfUserAccountRegistrationDialogComponent);
      expect(config.data).toEqual({
        deviceType: 'desktop',
        needsToAcceptTermsOfService: true
      });
      expect(config.disableClose).toBe(true);
    });

    it('leaves the terms step out when the deployment sells no subscription', async () => {
      await createComponent({
        globalPermissions: [
          permissions.createUserAccount,
          permissions.enableAuthToken
        ]
      });

      await component.openShowAccessTokenDialog();

      expect(openedDialog().config.data).toMatchObject({
        needsToAcceptTermsOfService: false
      });
    });

    it.each([
      {
        deviceType: 'desktop',
        expected: { height: undefined, width: '30rem' }
      },
      { deviceType: 'mobile', expected: { height: '98vh', width: '100vw' } }
    ])(
      'sizes the registration dialog for a $deviceType',
      async ({ deviceType, expected }) => {
        await createComponent({
          deviceType,
          globalPermissions: allGlobalPermissions
        });

        await component.openShowAccessTokenDialog();

        const { config } = openedDialog();

        expect(config.height).toBe(expected.height);
        expect(config.width).toBe(expected.width);
      }
    );

    it('adopts an issued token with stay-signed-in forced on, then re-reads the viewer bypassing the cache', async () => {
      staySignedInSetting = 'false';

      await createComponent({ globalPermissions: allGlobalPermissions });

      dialogAfterClosed = of('an-issued-token');

      await component.openShowAccessTokenDialog();

      // The asymmetry against `setToken` is deliberate: a freshly created account
      // is kept signed in regardless of the preference, which is why the preference
      // must not even be consulted here. The forced re-read is what makes the canvas
      // transition out of this state.
      expect(tokenStorageServiceMock.saveToken).toHaveBeenCalledWith(
        'an-issued-token',
        true
      );
      expect(settingsStorageServiceMock.getSetting).not.toHaveBeenCalled();
      expect(callOrder).toEqual([
        'beginIdentityTransition',
        'saveToken',
        'get(true)'
      ]);
    });

    it('adopts nothing when the registration dialog closes without a token', async () => {
      await createComponent({ globalPermissions: allGlobalPermissions });

      dialogAfterClosed = of(undefined);

      await component.openShowAccessTokenDialog();

      expect(tokenStorageServiceMock.saveToken).not.toHaveBeenCalled();
      expect(userServiceMock.get).not.toHaveBeenCalled();
    });
  });

  /**
   * What a visitor sees after an identity provider refused them.
   *
   * This card is also what an untouched first visit renders, so without a notice a
   * declined federated sign-in returns the visitor to a screen identical to the one
   * they left - and the reasonable response is to press the same button again. The
   * API reports the refusal through a marker in the address, which the root host
   * narrows to a boolean before it reaches this component.
   *
   * The rendering is asserted here rather than in the canvas suite, which stands
   * this component in with an empty template and can therefore only prove the
   * binding was passed.
   */
  describe('a refused federated sign-in', () => {
    /** The sentence, as a visitor reads it, with the template's wrapping removed. */
    const noticeText = () => {
      const notice = (fixture.nativeElement as HTMLElement).querySelector(
        '[role="alert"]'
      );

      return notice?.textContent.replace(/\s+/g, ' ').trim();
    };

    it('says the sign-in did not complete', async () => {
      await createComponent();

      // Through the input, which is how the canvas sets it - and the only way that
      // marks this `OnPush` view dirty. Assigning the field directly leaves the
      // template unpainted, so the notice would be absent for a reason that has
      // nothing to do with the component.
      fixture.componentRef.setInput('hasSignInError', true);
      fixture.detectChanges();

      expect(noticeText()).toBe(
        'Signing in with your identity provider did not complete. Please try again.'
      );
    });

    it('announces it, because the visitor did not act on this page to cause it', async () => {
      await createComponent();

      // Through the input, which is how the canvas sets it - and the only way that
      // marks this `OnPush` view dirty. Assigning the field directly leaves the
      // template unpainted, so the notice would be absent for a reason that has
      // nothing to do with the component.
      fixture.componentRef.setInput('hasSignInError', true);
      fixture.detectChanges();

      // An alert rather than a status: the visitor pressed a button, left for a
      // provider and came back, so nothing they are currently looking at changed to
      // explain it.
      expect(
        (fixture.nativeElement as HTMLElement).querySelector('[role="alert"]')
      ).toBeTruthy();
    });

    it('still offers the way back in', async () => {
      await createComponent();

      // Through the input, which is how the canvas sets it - and the only way that
      // marks this `OnPush` view dirty. Assigning the field directly leaves the
      // template unpainted, so the notice would be absent for a reason that has
      // nothing to do with the component.
      fixture.componentRef.setInput('hasSignInError', true);
      fixture.detectChanges();

      // The notice carries no action of its own precisely because these controls
      // are the retry. If it ever renders instead of them, the visitor is told what
      // happened and given no way to respond.
      expect(buttonLabelled('Sign in')).toBeTruthy();
    });

    it('says nothing on an ordinary first visit', async () => {
      await createComponent();

      expect(
        (fixture.nativeElement as HTMLElement).querySelector('[role="alert"]')
      ).toBeNull();
    });
  });

  describe('the rendered surface', () => {
    it('always offers signing in', async () => {
      await createComponent();

      expect(buttonLabelled('Sign in')).toBeTruthy();
    });

    /**
     * This card is the whole of the document a signed-out visitor is given, and it
     * had no heading of any kind: the only thing naming the application was the mark,
     * which is an image. Hidden visually rather than shown, because the mark already
     * says it to anybody who can see it and a second visible copy would be a design
     * change nothing asked for.
     */
    it('gives the document a heading, without changing what is seen', async () => {
      await createComponent();

      const heading = host().querySelector('h1');

      expect(heading).toBeTruthy();
      expect(heading.textContent.trim()).toBe('Sign in to Ghostfolio');
      expect(heading.classList).toContain('sr-only');
    });

    it('opens the access-token dialog from the sign-in control', async () => {
      await createComponent({ globalPermissions: allGlobalPermissions });

      buttonLabelled('Sign in').click();

      // The handler resolves the dialog's own chunk before opening it, so the
      // request is made a microtask later than the click.
      await fixture.whenStable();

      expect(openedDialog().component).toBe(
        GfLoginWithAccessTokenDialogComponent
      );
    });

    // Both capabilities are required together: the registration dialog issues a
    // security token, so offering it where token authentication is disabled would
    // hand the visitor a credential the deployment refuses to accept.
    it.each([
      {
        description: 'both capabilities are granted',
        globalPermissions: [
          permissions.createUserAccount,
          permissions.enableAuthToken
        ],
        offered: true
      },
      {
        description: 'only account creation is granted',
        globalPermissions: [permissions.createUserAccount],
        offered: false
      },
      {
        description: 'only token authentication is granted',
        globalPermissions: [permissions.enableAuthToken],
        offered: false
      },
      {
        description: 'neither is granted',
        globalPermissions: [],
        offered: false
      }
    ])(
      'offers account creation: $offered when $description',
      async ({ globalPermissions, offered }) => {
        await createComponent({ globalPermissions });

        expect(!!buttonLabelled('Create Account')).toBe(offered);
      }
    );

    it('opens the registration dialog from the account control', async () => {
      await createComponent({
        globalPermissions: [
          permissions.createUserAccount,
          permissions.enableAuthToken
        ]
      });

      buttonLabelled('Create Account').click();

      await fixture.whenStable();

      expect(openedDialog().component).toBe(
        GfUserAccountRegistrationDialogComponent
      );
    });

    it('renders no in-application address and no marketing surface', async () => {
      await createComponent({ globalPermissions: allGlobalPermissions });

      // The whole public surface this state replaced is gone by directive, and there
      // is no screen left for a link to select. Anchors and link directives are
      // therefore absent rather than merely unused.
      expect(host().querySelectorAll('a')).toHaveLength(0);
      expect(host().querySelectorAll('[href]')).toHaveLength(0);
      expect(host().innerHTML).not.toContain('routerlink');
    });
  });
  /**
   * Loading a dialog's own chunk, when that takes time or fails.
   *
   * Chunk loading happens behind two controls a visitor can press twice, with no
   * router in between to absorb a repeat. Both live on one card and there is one
   * visitor, so while either chunk is resolving neither control should start a
   * second load.
   */
  describe('resolving a dialog on demand', () => {
    it('opens one dialog however many times a control is pressed while loading', async () => {
      await createComponent({ globalPermissions: allGlobalPermissions });

      const answers = deferChunkLoads();

      const first = component.openLoginDialog();
      const second = component.openLoginDialog();

      expect(lazyDialogServiceMock.load).toHaveBeenCalledTimes(1);
      expect(component.isOpeningDialog).toBe(true);

      answers[0](GfLoginWithAccessTokenDialogComponent);

      await first;
      await second;

      expect(dialogOpen).toHaveBeenCalledTimes(1);
      expect(component.isOpeningDialog).toBe(false);
    });

    it('refuses the other control while a chunk is still resolving', async () => {
      await createComponent({ globalPermissions: allGlobalPermissions });

      const answers = deferChunkLoads();

      const signingIn = component.openLoginDialog();
      const creating = component.openShowAccessTokenDialog();

      // One visitor, two controls, one dialog at a time: the second is refused
      // rather than queued behind the first.
      expect(lazyDialogServiceMock.load).toHaveBeenCalledTimes(1);

      answers[0](GfLoginWithAccessTokenDialogComponent);

      await signingIn;
      await creating;

      expect(dialogOpen).toHaveBeenCalledTimes(1);
      expect(openedDialog().component).toBe(
        GfLoginWithAccessTokenDialogComponent
      );
    });

    it('disables both controls while a chunk is resolving, and marks them busy', async () => {
      await createComponent({ globalPermissions: allGlobalPermissions });

      const answers = deferChunkLoads();

      const opening = component.openLoginDialog();

      fixture.detectChanges();

      const controls = [
        buttonLabelled('Sign in'),
        buttonLabelled('Create Account')
      ];

      // Visible as well as guarded: a control that has gone quiet for a moment is
      // otherwise indistinguishable from one that did nothing at all.
      //
      // Asserted through `aria-disabled` rather than the native property, and the
      // absence of the native attribute is asserted too, because that absence is
      // the point - see the test below.
      for (const control of controls) {
        expect(control.getAttribute('aria-disabled')).toBe('true');
        expect(control.hasAttribute('disabled')).toBe(false);
        expect(control.getAttribute('aria-busy')).toBe('true');
      }

      answers[0](GfLoginWithAccessTokenDialogComponent);

      await opening;

      fixture.detectChanges();

      for (const control of [
        buttonLabelled('Sign in'),
        buttonLabelled('Create Account')
      ]) {
        expect(control.getAttribute('aria-disabled')).not.toBe('true');
        expect(control.hasAttribute('disabled')).toBe(false);
        expect(control.getAttribute('aria-busy')).toBeNull();
      }
    });

    /**
     * The reason the wait is expressed with `aria-disabled` instead of the native
     * attribute.
     *
     * A natively disabled element cannot hold focus, so disabling the button that
     * was just pressed threw focus to the document body before the dialog had
     * recorded what to restore it to - and the dialog then restored focus to the
     * body on close, stranding a keyboard visitor at the top of the document. The
     * fix is not in the dialog's configuration but in never taking focus off the
     * opener in the first place.
     */
    it('keeps the pressed control focusable while it waits', async () => {
      await createComponent({ globalPermissions: allGlobalPermissions });

      const answers = deferChunkLoads();

      const opener = buttonLabelled('Sign in');

      opener.focus();

      expect(document.activeElement).toBe(opener);

      const opening = component.openLoginDialog();

      fixture.detectChanges();

      // Still the focused element, and still able to become one: the dialog opens
      // with the opener under focus, which is what it captures as the element to
      // hand focus back to.
      expect(document.activeElement).toBe(buttonLabelled('Sign in'));
      expect(buttonLabelled('Sign in').tabIndex).not.toBe(-1);

      answers[0](GfLoginWithAccessTokenDialogComponent);

      await opening;

      fixture.detectChanges();

      expect(document.activeElement).toBe(buttonLabelled('Sign in'));
    });

    it('absorbs a second press rather than leaving it to the platform', async () => {
      await createComponent({ globalPermissions: allGlobalPermissions });

      const answers = deferChunkLoads();

      const opening = component.openLoginDialog();

      fixture.detectChanges();

      // An interactively disabled control still delivers its click, so the guard in
      // the handler is what stops a second dialog rather than the platform swallowing
      // the event. Pressed here as the visitor would, through the DOM.
      buttonLabelled('Sign in').click();
      buttonLabelled('Create Account').click();

      expect(lazyDialogServiceMock.load).toHaveBeenCalledTimes(1);

      answers[0](GfLoginWithAccessTokenDialogComponent);

      await opening;

      expect(dialogOpen).toHaveBeenCalledTimes(1);
    });

    it.each([
      {
        description: 'signing in',
        open: () => component.openLoginDialog()
      },
      {
        description: 'creating an account',
        open: () => component.openShowAccessTokenDialog()
      }
    ])(
      'opens nothing and releases the controls when the $description chunk fails',
      async ({ open }) => {
        await createComponent({ globalPermissions: allGlobalPermissions });

        lazyDialogServiceMock.load.mockResolvedValueOnce(null);

        await open();

        // The loader has already reported the failure and told the visitor; what
        // matters here is that nothing was opened and that the controls are usable
        // again, so pressing one genuinely tries again.
        expect(dialogOpen).not.toHaveBeenCalled();
        expect(component.isOpeningDialog).toBe(false);
        expect(tokenStorageServiceMock.saveToken).not.toHaveBeenCalled();

        await open();

        expect(dialogOpen).toHaveBeenCalledTimes(1);
      }
    );
  });

  /**
   * Both credential paths persist the token *before* the viewer belonging to it is
   * read, which is the right order - the read authenticates with that token - and
   * which makes a failing read the interesting case rather than a footnote. The
   * viewer store keeps whatever it last held when a forced read fails, and while this
   * prompt is on screen that is nothing, so the canvas is never told to leave its
   * signed-out branch. Without a handler the viewer is left facing a sign-in prompt
   * for an account that exists and whose token is already stored, with no control on
   * screen able to retry: every control here creates or adopts a *new* credential
   * rather than re-reading the current one. Reloading is what recovers it, because it
   * discards every in-memory cache and restarts resolution from the stored token -
   * precisely the step that failed.
   *
   * The reload is observed rather than intercepted: jsdom implements
   * `window.location` and its members as `[LegacyUnforgeable]`, so spying on
   * `reload` throws. What it does emit is the same virtual-console report that
   * {@link navigationAttempts} already collects.
   */
  describe('recovering from a viewer that cannot be read', () => {
    /** Makes the next forced read fail, without disturbing the recorded ordering. */
    const failTheViewerRead = () => {
      userServiceMock.get = jest.fn((force?: boolean) => {
        callOrder.push(force ? 'get(true)' : 'get()');

        return throwError(() => new Error('offline'));
      });
    };

    it('reloads after a freshly created account cannot be resolved', async () => {
      await createComponent();

      dialogAfterClosed = of('an-auth-token');

      failTheViewerRead();

      await component.openShowAccessTokenDialog();

      expect(callOrder).toEqual([
        'beginIdentityTransition',
        'saveToken',
        'get(true)',
        'reportFailure',
        'leaveTheApplication'
      ]);
      expect(navigationAttempts).toHaveLength(1);

      // A fixed identifier of its own, so this failure stays distinguishable from the
      // token sign-in one without either of them describing what was being read. The
      // thrown error carries no numeric status, so the identifier is the whole line.
      expect(sanitizedReports).toEqual([
        'GF-SIGN-IN-PROMPT-USER-CREATE-READ-FAILED'
      ]);
    });

    it('reloads after an adopted token cannot be resolved, and navigates nowhere', async () => {
      await createComponent();

      failTheViewerRead();

      component.setToken('an-auth-token');

      // This method is the sole continuation of the token sign-in path, so an
      // unhandled failure here would leave the token persisted, the viewer
      // unresolved, the canvas signed out and no navigation performed.
      expect(callOrder).toEqual([
        'beginIdentityTransition',
        'saveToken',
        'get(true)',
        'reportFailure',
        'leaveTheApplication'
      ]);
      expect(routerMock.navigate).not.toHaveBeenCalled();
      expect(sanitizedReports).toEqual([
        'GF-SIGN-IN-PROMPT-TOKEN-SIGN-IN-READ-FAILED'
      ]);
    });

    it('reports an HTTP failure as an event and a status, and nothing the response carried', async () => {
      await createComponent();

      // Shaped like the `HttpErrorResponse` this path really produces: the failing
      // request is the one that carries the viewer's credential, so its URL, its
      // message and its body are exactly what must not be written anywhere.
      userServiceMock.get = jest.fn((force?: boolean) => {
        callOrder.push(force ? 'get(true)' : 'get()');

        return throwError(() => ({
          error: { detail: 'a-secret-detail' },
          message:
            'Http failure response for https://ghostfol.io/api/v1/user: 500 Internal Server Error',
          status: 500,
          url: 'https://ghostfol.io/api/v1/user?token=a-bearer-token'
        }));
      });

      component.setToken('a-bearer-token');

      // The status is kept because it is what makes the report actionable; the URL,
      // the message and the body are not, and none of them is a thing an operator
      // needs in order to read a failure rate.
      expect(sanitizedReports).toEqual([
        'GF-SIGN-IN-PROMPT-TOKEN-SIGN-IN-READ-FAILED (status 500)'
      ]);

      const reported = sanitizedReports.join('\n');

      expect(reported).not.toContain('a-bearer-token');
      expect(reported).not.toContain('a-secret-detail');
      expect(reported).not.toContain('ghostfol.io');
      expect(reported).not.toContain('Http failure response');

      // And the recovery still happens: a report is not a substitute for it.
      expect(navigationAttempts).toHaveLength(1);
    });
  });
});
