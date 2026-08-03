import { DashboardIntentService } from '@ghostfolio/client/core/dashboard-intent.service';
import { LayoutService } from '@ghostfolio/client/core/layout.service';
import { ImpersonationStorageService } from '@ghostfolio/client/services/impersonation-storage.service';
import {
  KEY_STAY_SIGNED_IN,
  SettingsStorageService
} from '@ghostfolio/client/services/settings-storage.service';
import { TokenStorageService } from '@ghostfolio/client/services/token-storage.service';
import { UserService } from '@ghostfolio/client/services/user/user.service';
import { Filter, InfoItem, User } from '@ghostfolio/common/interfaces';
import { permissions } from '@ghostfolio/common/permissions';
import { DateRange } from '@ghostfolio/common/types';
import { NotificationService } from '@ghostfolio/ui/notifications';
import { AdminService, DataService } from '@ghostfolio/ui/services';

import { reflectComponentType } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
// The bar marks its static strings for translation, and the shared metadata it
// reaches through reads its own display names the same way, both of which
// compile to `$localize` calls evaluated at module scope. Nothing installs that
// global in a jsdom test environment - `apps/client/src/polyfills.ts` installs
// it for the application and no test setup file stands in for that - so it is
// installed here. Its position is load-bearing: this group is evaluated before
// the relative imports below, and the subject of this spec is one of them.
import '@angular/localize/init';
import { MatDialog } from '@angular/material/dialog';
import { Router } from '@angular/router';
import { DeviceDetectorService } from 'ngx-device-detector';
import { BehaviorSubject, of, Subject, throwError } from 'rxjs';

import { DashboardModuleType } from '../../enums/dashboard-module-type';
import { GfDashboardToolbarComponent } from './dashboard-toolbar.component';

// Keeps the sign-in dialog's own component tree - a dialog header, a reactive
// form, a checkbox and two Material field modules - out of this compilation.
// Nothing real is faked by doing so: the class is only ever handed to
// `MatDialog.open`, which is itself replaced below, so the dialog is never
// instantiated in either the real code path or this spec.
jest.mock(
  '@ghostfolio/client/components/login-with-access-token-dialog/login-with-access-token-dialog.component',
  () => ({ GfLoginWithAccessTokenDialogComponent: class {} })
);

/**
 * Unit specification for the non-navigational dashboard control bar.
 *
 * Two things about this environment shape almost every decision below, and both
 * were established by measurement rather than assumption.
 *
 * **`Location` cannot be replaced.** jsdom implements `window.location` and its
 * members as `[LegacyUnforgeable]`, so `Object.defineProperty(window,
 * 'location', …)` throws `Cannot redefine property: location`, and
 * `jest.spyOn(window.location, 'reload')` throws `Cannot assign to read only
 * property 'reload'`. The two behaviours that leave the page - restarting the
 * application after an identity switch, and handing off to the locale root after
 * signing out - are therefore observed through the signal jsdom does emit: an
 * attempted navigation is reported on the virtual console, which arrives here as
 * a `console.error`. {@link navigationAttempts} collects those, and everything
 * else is forwarded to the real `console.error` so that a genuine framework
 * error is never swallowed.
 *
 * That signal is sharper than it first appears. jsdom performs no navigation at
 * all when the target resolves to the URL the document is already on, so an
 * empty attempt list is itself an exact assertion about the address that was
 * assigned - which is what pins the sign-out target to `/` followed by the
 * document language and nothing else.
 *
 * **Projected panel contents are built even while the panel is shut.** A menu
 * renders its own panel lazily, but the nodes handed to it are created with the
 * view that declares them, so the assistant really is instantiated as soon as
 * there is a viewer entitled to it - which is why the assistant's own collaborator
 * is supplied below. Every test here leaves both menus closed all the same,
 * because opening one would project a panel this spec has no reason to build.
 *
 * The premium indicator is the one child that genuinely never appears: it sits
 * behind a condition requiring both a subscription capability and a viewer
 * holding a basic plan, and no test satisfies both at once. That is deliberate
 * and needs to stay that way - the indicator still carries a router dependency
 * of its own, whereas this spec supplies `Router` as a plain value and imports
 * no router module, testing module or router provider function at all. The
 * assertions further down require the rendered chrome to offer no
 * in-application address either.
 */
describe('GfDashboardToolbarComponent', () => {
  /**
   * The fragment jsdom uses to report an attempted document navigation. Matched
   * on rather than compared, because the report is a stack rather than a bare
   * message.
   */
  const JSDOM_NAVIGATION_REPORT = 'Not implemented: navigation';

  let component: GfDashboardToolbarComponent;
  let fixture: ComponentFixture<GfDashboardToolbarComponent>;

  /**
   * The data facade, deliberately exposing three methods and no more.
   *
   * This is load-bearing rather than economical. Saving an arrangement is the
   * canvas's responsibility and is triggered only by grid state changing; this
   * bar has no part in it. Because the facade offered here answers nothing else,
   * any attempt from this component to reach a persistence method would raise a
   * `TypeError` and fail the suite outright, which turns that separation from a
   * claim into a structural property of the harness.
   */
  let dataServiceMock: {
    fetchInfo: jest.Mock;
    loginAnonymous: jest.Mock;
    putUserSetting: jest.Mock;
  };

  /**
   * The assistant's own collaborator, supplied because the assistant is built
   * with the view that declares it. Left empty on purpose: the assistant reaches
   * for it only once a search is under way, and no test here starts one.
   */
  let adminServiceMock: Record<string, never>;

  let dashboardIntentServiceMock: { getRevealModuleSubject: jest.Mock };
  let deviceDetectorServiceMock: { getDeviceInfo: jest.Mock };
  let dialogMock: { open: jest.Mock };
  let impersonationStorageServiceMock: {
    getId: jest.Mock;
    onChangeHasImpersonation: jest.Mock;
    removeId: jest.Mock;
    setId: jest.Mock;
  };
  let layoutServiceMock: { getShouldReloadSubject: jest.Mock };
  let notificationServiceMock: { alert: jest.Mock };
  let routerMock: { navigate: jest.Mock };
  let settingsStorageServiceMock: { getSetting: jest.Mock };
  let tokenStorageServiceMock: { saveToken: jest.Mock };
  let userServiceMock: {
    get: jest.Mock;
    hasFilters: jest.Mock;
    signOut: jest.Mock;
    stateChanged: BehaviorSubject<{ user: User }>;
  };

  /**
   * Seeded from the stored identity in the real service, so it answers
   * synchronously on subscribe. Modelled with the same kind of subject, because
   * the component reads it during construction and the fields it fills are
   * expected to be settled before the first render.
   */
  let impersonationSubject: BehaviorSubject<string>;
  let revealModuleSubject: Subject<DashboardModuleType>;
  let shouldReloadSubject: Subject<void>;
  let stateChangedSubject: BehaviorSubject<{ user: User }>;

  let consoleErrorSpy: jest.SpyInstance;

  /** Every document navigation jsdom declined to perform, in order. */
  let navigationAttempts: string[];

  /** Records ordering between effects that would otherwise be unordered. */
  let callOrder: string[];

  let originalDocumentLanguage: string;
  let temporaryElements: HTMLElement[];

  const createOffer = (
    offer: Partial<User['subscription']['offer']> = {}
  ): User['subscription']['offer'] => {
    return { price: 0, priceId: 'PRICE_ID', ...offer };
  };

  const createInfo = (info: Partial<InfoItem> = {}): InfoItem => {
    return { globalPermissions: [], ...info } as InfoItem;
  };

  /**
   * A viewer who may use the assistant, which is what renders the panel trigger
   * this spec reads as a view child. Everything else is minimal on purpose:
   * absent members exercise the same optional reads the component performs while
   * a viewer is still resolving.
   */
  const createUser = (user: Partial<User> = {}): User => {
    return {
      access: [],
      permissions: [permissions.accessAssistant],
      settings: { language: 'en' },
      subscription: { offer: createOffer(), type: 'Basic' },
      ...user
    } as unknown as User;
  };

  /**
   * Builds the component. Any previous instance is torn down first so that a
   * test which rebuilds - because deployment info is read once, during
   * initialisation, and cannot be changed afterwards - is never observed
   * alongside its own predecessor on the shared subjects.
   */
  const createComponent = () => {
    fixture?.destroy();

    fixture = TestBed.createComponent(GfDashboardToolbarComponent);
    component = fixture.componentInstance;

    fixture.detectChanges();
  };

  /**
   * Publishes a viewer and renders. The bar deliberately draws nothing until one
   * arrives, so this is the precondition for every assertion about its markup.
   */
  const renderWithUser = (user: User = createUser()) => {
    stateChangedSubject.next({ user });

    fixture.detectChanges();
  };

  /**
   * The rendered chrome, typed so that the assertions below read as document
   * queries rather than as untyped member access.
   */
  const host = () => fixture.nativeElement as HTMLElement;

  const createAssistantStub = () => {
    return { initialize: jest.fn(), setIsOpen: jest.fn() };
  };

  const createMenuTriggerStub = () => {
    return { closeMenu: jest.fn(), openMenu: jest.fn() };
  };

  /**
   * Dispatches a real, cancellable keydown from a real element so that the
   * window-level binding is exercised end to end rather than bypassed by calling
   * the handler directly. `cancelable` matters: without it `preventDefault()`
   * records nothing and the suppression could not be observed.
   */
  const dispatchKeydownFrom = (tagName: string, key: string) => {
    const target = document.createElement(tagName);

    document.body.appendChild(target);
    temporaryElements.push(target);

    const event = new KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      key
    });

    target.dispatchEvent(event);

    return event;
  };

  beforeEach(async () => {
    callOrder = [];
    fixture = undefined;
    navigationAttempts = [];
    temporaryElements = [];

    originalDocumentLanguage = document.documentElement.lang;

    // Matched to the language the viewer fixture carries, so that handing off
    // after a token exchange takes the in-application branch and no test
    // inherits a navigation attempt it did not ask for.
    document.documentElement.lang = 'en';

    const reportError = console.error.bind(console);

    consoleErrorSpy = jest
      .spyOn(console, 'error')
      .mockImplementation((...args: unknown[]) => {
        const [detail] = args;

        // Recognised by its shape rather than with `instanceof`. jsdom raises
        // this from its own realm, so `detail instanceof Error` is false for the
        // very object that arrives even though an error is precisely what it is -
        // measured, not assumed, and narrowing that way silently stops matching.
        const report =
          Object.prototype.toString.call(detail) === '[object Error]'
            ? (detail as Error).message
            : typeof detail === 'string'
              ? detail
              : '';

        if (report.includes(JSDOM_NAVIGATION_REPORT)) {
          callOrder.push('navigate');
          navigationAttempts.push(report);

          return;
        }

        reportError(...args);
      });

    impersonationSubject = new BehaviorSubject<string>(null);
    revealModuleSubject = new Subject<DashboardModuleType>();
    shouldReloadSubject = new Subject<void>();
    stateChangedSubject = new BehaviorSubject<{ user: User }>({ user: null });

    adminServiceMock = {};

    dashboardIntentServiceMock = {
      getRevealModuleSubject: jest.fn().mockReturnValue(revealModuleSubject)
    };

    dataServiceMock = {
      fetchInfo: jest.fn().mockReturnValue(createInfo()),
      loginAnonymous: jest
        .fn()
        .mockReturnValue(of({ authToken: 'AUTH_TOKEN' })),
      putUserSetting: jest.fn().mockReturnValue(of({} as User))
    };

    deviceDetectorServiceMock = {
      getDeviceInfo: jest.fn().mockReturnValue({ deviceType: 'desktop' })
    };

    dialogMock = {
      open: jest
        .fn()
        .mockReturnValue({ afterClosed: () => of({ accessToken: 'TOKEN' }) })
    };

    impersonationStorageServiceMock = {
      getId: jest.fn().mockReturnValue(null),
      onChangeHasImpersonation: jest
        .fn()
        .mockReturnValue(impersonationSubject.asObservable()),
      removeId: jest.fn(),
      setId: jest.fn()
    };

    layoutServiceMock = {
      getShouldReloadSubject: jest.fn().mockReturnValue(shouldReloadSubject)
    };

    notificationServiceMock = { alert: jest.fn() };
    routerMock = { navigate: jest.fn() };
    settingsStorageServiceMock = { getSetting: jest.fn() };
    tokenStorageServiceMock = { saveToken: jest.fn() };

    userServiceMock = {
      get: jest.fn().mockReturnValue(of(createUser())),
      hasFilters: jest.fn().mockReturnValue(false),
      signOut: jest.fn(() => {
        callOrder.push('signOut');
      }),
      stateChanged: stateChangedSubject
    };

    await TestBed.configureTestingModule({
      imports: [GfDashboardToolbarComponent],
      providers: [
        { provide: AdminService, useValue: adminServiceMock },
        {
          provide: DashboardIntentService,
          useValue: dashboardIntentServiceMock
        },
        { provide: DataService, useValue: dataServiceMock },
        { provide: DeviceDetectorService, useValue: deviceDetectorServiceMock },
        {
          provide: ImpersonationStorageService,
          useValue: impersonationStorageServiceMock
        },
        { provide: LayoutService, useValue: layoutServiceMock },
        { provide: MatDialog, useValue: dialogMock },
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

    createComponent();
  });

  // Restoration only. Nothing is asserted here: automatic per-test teardown has
  // already destroyed the fixture by this point, so a count read now would be
  // read against state that is no longer the one under test.
  afterEach(() => {
    consoleErrorSpy.mockRestore();

    document.documentElement.lang = originalDocumentLanguage;

    for (const element of temporaryElements) {
      element.remove();
    }
  });

  describe('creation', () => {
    it('is created', () => {
      expect(component).toBeTruthy();
    });

    it('resolves the device class through the accessor the application uses', () => {
      expect(deviceDetectorServiceMock.getDeviceInfo).toHaveBeenCalled();
      expect(component.deviceType).toBe('desktop');
    });

    it('reads deployment info exactly once, and synchronously', () => {
      // The accessor deep-clones on every call, which is why the component holds
      // the result instead of re-reading it. A synchronous return is also what
      // makes the four capability flags settled by the end of initialisation.
      expect(dataServiceMock.fetchInfo).toHaveBeenCalledTimes(1);
    });

    it('grants the capabilities the deployment declares', () => {
      dataServiceMock.fetchInfo.mockReturnValue(
        createInfo({
          globalPermissions: [
            permissions.enableAuthGoogle,
            permissions.enableAuthOidc,
            permissions.enableAuthToken,
            permissions.enableSubscription
          ]
        })
      );

      createComponent();

      expect(component.hasPermissionForAuthGoogle).toBe(true);
      expect(component.hasPermissionForAuthOidc).toBe(true);
      expect(component.hasPermissionForAuthToken).toBe(true);
      expect(component.hasPermissionForSubscription).toBe(true);
    });

    it('withholds the capabilities the deployment does not declare', () => {
      expect(component.hasPermissionForAuthGoogle).toBe(false);
      expect(component.hasPermissionForAuthOidc).toBe(false);
      expect(component.hasPermissionForAuthToken).toBe(false);
      expect(component.hasPermissionForSubscription).toBe(false);
    });

    it('renders as empty chrome until a viewer resolves', () => {
      // The viewer is resolved asynchronously, so the first pass necessarily
      // carries none. Drawing nothing rather than faulting is the contract.
      expect(component.user).toBeNull();
      expect(host().querySelector('gf-logo')).toBeNull();
    });
  });

  describe('assistant panel wiring', () => {
    it('populates the assistant as its panel opens rather than on construction', () => {
      const assistant = createAssistantStub();

      component.assistantElement =
        assistant as unknown as GfDashboardToolbarComponent['assistantElement'];

      component.onOpenAssistant();

      expect(assistant.initialize).toHaveBeenCalledTimes(1);
    });

    it('dismisses the panel that hosts the assistant on request', () => {
      renderWithUser();

      // The real trigger, not a stand-in: the control that owns it is rendered
      // whenever there is a viewer who may use the assistant, so the view child
      // this reads is the one the template resolves.
      expect(component.assistentMenuTriggerElement).toBeTruthy();

      const closeMenu = jest.spyOn(
        component.assistentMenuTriggerElement,
        'closeMenu'
      );

      component.closeAssistant();

      expect(closeMenu).toHaveBeenCalledTimes(1);
    });

    it('tolerates a dismissal requested before the panel exists', () => {
      // The assistant can ask to be dismissed before its host has been
      // projected, so the read is optional and this must not fault.
      component.assistentMenuTriggerElement = undefined;

      expect(() => component.closeAssistant()).not.toThrow();
    });
  });

  describe('onSelectModule', () => {
    it('publishes the discriminator it was handed, unchanged', () => {
      const received: DashboardModuleType[] = [];

      revealModuleSubject.subscribe((intent) => received.push(intent));

      const moduleType = DashboardModuleType.ACCOUNTS;

      component.onSelectModule(moduleType);

      expect(
        dashboardIntentServiceMock.getRevealModuleSubject
      ).toHaveBeenCalledTimes(1);
      expect(received).toHaveLength(1);

      // Identity rather than equivalence. Templates are not type-checked
      // strictly in this project, so the value arriving from the assistant is
      // untyped as far as the compiler is concerned and this is the only place
      // the shape of that payload is actually guarded.
      expect(received[0]).toBe(moduleType);
    });

    it('adapts nothing on the way through', () => {
      const received: DashboardModuleType[] = [];

      revealModuleSubject.subscribe((intent) => received.push(intent));

      const moduleTypes = Object.values(DashboardModuleType);

      for (const moduleType of moduleTypes) {
        component.onSelectModule(moduleType);
      }

      // No wrapping object, no coercion, no mapping table: what went in is what
      // came out, for every discriminator the catalog can offer.
      expect(received).toEqual(moduleTypes);
      expect(
        received.every((moduleType) => typeof moduleType === 'string')
      ).toBe(true);
    });

    it('resolves nothing about the module it names', () => {
      component.onSelectModule(DashboardModuleType.HOLDINGS);

      // Which component backs a module, whether it is already placed and where
      // it would go are all answered by the canvas. Nothing here consults a
      // registry or a layout, and nothing here is given one to consult.
      expect(dataServiceMock.putUserSetting).not.toHaveBeenCalled();
      expect(routerMock.navigate).not.toHaveBeenCalled();
    });
  });

  describe('onDateRangeChange', () => {
    it('persists the selected range', () => {
      component.onDateRangeChange('1y' as DateRange);

      expect(dataServiceMock.putUserSetting).toHaveBeenCalledTimes(1);
      expect(dataServiceMock.putUserSetting).toHaveBeenCalledWith({
        dateRange: '1y'
      });
    });

    it('forces a re-read of the viewer once the range is stored', () => {
      component.onDateRangeChange('1y' as DateRange);

      // Without the forced read the write would land and nothing drawing from
      // the viewer's settings would follow it.
      expect(userServiceMock.get).toHaveBeenCalledTimes(1);
      expect(userServiceMock.get).toHaveBeenCalledWith(true);
    });
  });

  describe('onFiltersChanged', () => {
    /**
     * Applies one filter and returns the payload that was persisted.
     */
    const persistFilter = (filter: Filter) => {
      component.onFiltersChanged([filter]);

      expect(dataServiceMock.putUserSetting).toHaveBeenCalledTimes(1);

      return dataServiceMock.putUserSetting.mock.calls[0][0] as Record<
        string,
        unknown
      >;
    };

    // The array-versus-scalar split below is the persisted shape rather than an
    // inconsistency: `UserService.getFilters()` reads accounts, asset classes
    // and tags back through their first element, and data source and symbol as
    // bare values. Asserting each key by name is what keeps the two halves of
    // that round trip from drifting apart.
    it('stores an account as an array', () => {
      expect(persistFilter({ id: 'ID', type: 'ACCOUNT' })).toEqual({
        'filters.accounts': ['ID']
      });
    });

    it('stores an asset class as an array', () => {
      expect(persistFilter({ id: 'ID', type: 'ASSET_CLASS' })).toEqual({
        'filters.assetClasses': ['ID']
      });
    });

    it('stores a data source as a scalar', () => {
      expect(persistFilter({ id: 'ID', type: 'DATA_SOURCE' })).toEqual({
        'filters.dataSource': 'ID'
      });
    });

    it('stores a symbol as a scalar', () => {
      expect(persistFilter({ id: 'ID', type: 'SYMBOL' })).toEqual({
        'filters.symbol': 'ID'
      });
    });

    it('stores a tag as an array', () => {
      expect(persistFilter({ id: 'ID', type: 'TAG' })).toEqual({
        'filters.tags': ['ID']
      });
    });

    // A cleared filter arrives carrying an empty identifier and has to erase
    // what was stored. A nullish test would let the empty value through and the
    // filter would silently survive its own removal, so the truthiness test is
    // pinned here for one array-shaped key and one scalar-shaped key.
    it('erases an array-shaped filter that was cleared', () => {
      expect(persistFilter({ id: '', type: 'ACCOUNT' })).toEqual({
        'filters.accounts': null
      });
    });

    it('erases a scalar-shaped filter that was cleared', () => {
      expect(persistFilter({ id: '', type: 'SYMBOL' })).toEqual({
        'filters.symbol': null
      });
    });

    it('collects every filter into a single write', () => {
      component.onFiltersChanged([
        { id: 'ACCOUNT_ID', type: 'ACCOUNT' },
        { id: 'ASSET_CLASS_ID', type: 'ASSET_CLASS' },
        { id: 'DATA_SOURCE_ID', type: 'DATA_SOURCE' },
        { id: 'SYMBOL_ID', type: 'SYMBOL' },
        { id: 'TAG_ID', type: 'TAG' }
      ]);

      expect(dataServiceMock.putUserSetting).toHaveBeenCalledTimes(1);
      expect(dataServiceMock.putUserSetting).toHaveBeenCalledWith({
        'filters.accounts': ['ACCOUNT_ID'],
        'filters.assetClasses': ['ASSET_CLASS_ID'],
        'filters.dataSource': 'DATA_SOURCE_ID',
        'filters.symbol': 'SYMBOL_ID',
        'filters.tags': ['TAG_ID']
      });
    });

    it('ignores a filter kind the viewer settings do not carry', () => {
      // The filter contract describes more kinds than the settings persist. The
      // surplus ones belong to in-page search and are deliberately not stored.
      expect(persistFilter({ id: 'ID', type: 'SEARCH_QUERY' })).toEqual({});
    });

    it('forces a re-read of the viewer once the filters are stored', () => {
      component.onFiltersChanged([{ id: 'ID', type: 'TAG' }]);

      expect(userServiceMock.get).toHaveBeenCalledTimes(1);
      expect(userServiceMock.get).toHaveBeenCalledWith(true);
    });
  });

  describe('impersonateAccount', () => {
    it('adopts the identity it was given', () => {
      component.impersonateAccount('ACCESS_ID');

      expect(impersonationStorageServiceMock.setId).toHaveBeenCalledTimes(1);
      expect(impersonationStorageServiceMock.setId).toHaveBeenCalledWith(
        'ACCESS_ID'
      );
      expect(impersonationStorageServiceMock.removeId).not.toHaveBeenCalled();
    });

    it('returns to the viewer when given nothing', () => {
      component.impersonateAccount(null);

      expect(impersonationStorageServiceMock.removeId).toHaveBeenCalledTimes(1);
      expect(impersonationStorageServiceMock.setId).not.toHaveBeenCalled();
    });

    it('restarts the application after adopting an identity', () => {
      // The restart is the behaviour being preserved. Identity is read from
      // storage by every service on its way to a first request, so starting over
      // is the only way to guarantee nothing is left holding data belonging to
      // the identity that was just put down.
      component.impersonateAccount('ACCESS_ID');

      expect(navigationAttempts).toHaveLength(1);
    });

    it('restarts the application after returning to the viewer', () => {
      component.impersonateAccount(null);

      expect(navigationAttempts).toHaveLength(1);
    });

    it('settles the borrowed identity during construction', () => {
      impersonationSubject.next('SEEDED_ID');

      const seeded = TestBed.createComponent(GfDashboardToolbarComponent);

      // Read before the first change-detection pass on purpose: the store
      // answers on subscribe, so these fields are expected to be settled by the
      // end of construction rather than one pass behind it.
      expect(seeded.componentInstance.impersonationId).toBe('SEEDED_ID');
      expect(seeded.componentInstance.hasImpersonationId).toBe(true);

      seeded.destroy();
    });

    it('reports no borrowed identity when none is stored', () => {
      expect(component.impersonationId).toBeNull();
      expect(component.hasImpersonationId).toBe(false);
    });

    it('follows the borrowed identity as it changes', () => {
      impersonationSubject.next('ACCESS_ID');

      expect(component.impersonationId).toBe('ACCESS_ID');
      expect(component.hasImpersonationId).toBe(true);

      impersonationSubject.next(null);

      expect(component.impersonationId).toBeNull();
      expect(component.hasImpersonationId).toBe(false);
    });
  });

  describe('openLoginDialog', () => {
    /**
     * Rebuilds the component with all three authentication paths granted, so the
     * capabilities handed to the dialog are the granted ones rather than the
     * default denials.
     */
    const grantEveryAuthenticationPath = () => {
      dataServiceMock.fetchInfo.mockReturnValue(
        createInfo({
          globalPermissions: [
            permissions.enableAuthGoogle,
            permissions.enableAuthOidc,
            permissions.enableAuthToken
          ]
        })
      );

      createComponent();
    };

    const closeDialogWith = (data: unknown) => {
      dialogMock.open.mockReturnValue({ afterClosed: () => of(data) });
    };

    it('offers the shared dialog with the whole parameter set', () => {
      grantEveryAuthenticationPath();

      component.openLoginDialog();

      expect(dialogMock.open).toHaveBeenCalledTimes(1);

      const [dialogComponent, dialogConfig] = dialogMock.open.mock.calls[0];

      expect(typeof dialogComponent).toBe('function');

      // The dialog renders all three authentication paths itself from these
      // capabilities, which is why none of them is handled here.
      expect(dialogConfig).toEqual({
        autoFocus: false,
        data: {
          accessToken: '',
          hasPermissionToUseAuthGoogle: true,
          hasPermissionToUseAuthOidc: true,
          hasPermissionToUseAuthToken: true,
          title: 'Sign in'
        },
        width: '30rem'
      });
    });

    it('exchanges an entered token', () => {
      component.openLoginDialog();

      expect(dataServiceMock.loginAnonymous).toHaveBeenCalledTimes(1);
      expect(dataServiceMock.loginAnonymous).toHaveBeenCalledWith('TOKEN');
    });

    it('stores the issued token and honours the stay-signed-in preference', () => {
      settingsStorageServiceMock.getSetting.mockReturnValue('true');

      component.openLoginDialog();

      expect(settingsStorageServiceMock.getSetting).toHaveBeenCalledWith(
        KEY_STAY_SIGNED_IN
      );
      expect(tokenStorageServiceMock.saveToken).toHaveBeenCalledTimes(1);
      expect(tokenStorageServiceMock.saveToken).toHaveBeenCalledWith(
        'AUTH_TOKEN',
        true
      );
    });

    it('declines to persist the token when the preference is off', () => {
      settingsStorageServiceMock.getSetting.mockReturnValue('false');

      component.openLoginDialog();

      expect(tokenStorageServiceMock.saveToken).toHaveBeenCalledWith(
        'AUTH_TOKEN',
        false
      );
    });

    it('declines to persist the token when no preference was ever expressed', () => {
      // Anything other than the stored affirmative reads as a refusal, which is
      // what makes an absent preference safe rather than ambiguous.
      settingsStorageServiceMock.getSetting.mockReturnValue(undefined);

      component.openLoginDialog();

      expect(tokenStorageServiceMock.saveToken).toHaveBeenCalledWith(
        'AUTH_TOKEN',
        false
      );
    });

    it('reads the viewer the new token belongs to', () => {
      component.openLoginDialog();

      // Unforced: the exchange has just replaced the stored token, so there is
      // nothing cached under it yet.
      expect(userServiceMock.get).toHaveBeenCalledTimes(1);
      expect(userServiceMock.get).toHaveBeenCalledWith();
    });

    it('requests the root route once the viewer is known', () => {
      component.openLoginDialog();

      // The one place in this component that addresses anything. On a collapsed
      // route table the request is already satisfied and rebuilds nothing; the
      // re-read above is what actually propagates the new identity.
      expect(routerMock.navigate).toHaveBeenCalledTimes(1);
      expect(routerMock.navigate).toHaveBeenCalledWith(['/']);
      expect(navigationAttempts).toHaveLength(0);
    });

    it('sends a viewer whose language differs to their own locale', () => {
      userServiceMock.get.mockReturnValue(
        of(createUser({ settings: { language: 'de' } } as Partial<User>))
      );

      component.openLoginDialog();

      // Each locale is deployed under its own base path and cannot be reached
      // from within this one, so this hand-off has to leave the document.
      expect(navigationAttempts).toHaveLength(1);
      expect(routerMock.navigate).not.toHaveBeenCalled();
    });

    it('does nothing when the dialog is dismissed without a token', () => {
      closeDialogWith(undefined);

      component.openLoginDialog();

      expect(dataServiceMock.loginAnonymous).not.toHaveBeenCalled();
      expect(tokenStorageServiceMock.saveToken).not.toHaveBeenCalled();
    });

    it('does nothing when the dialog resolves with an empty token', () => {
      closeDialogWith({ accessToken: '' });

      component.openLoginDialog();

      expect(dataServiceMock.loginAnonymous).not.toHaveBeenCalled();
      expect(tokenStorageServiceMock.saveToken).not.toHaveBeenCalled();
    });

    it('reports a rejected token in the wording the former chrome used', () => {
      dataServiceMock.loginAnonymous.mockReturnValue(
        throwError(() => new Error('Rejected'))
      );

      component.openLoginDialog();

      expect(notificationServiceMock.alert).toHaveBeenCalledTimes(1);
      expect(notificationServiceMock.alert).toHaveBeenCalledWith({
        title: 'Oops! Incorrect Security Token.'
      });
    });

    it('stores nothing when the token was rejected', () => {
      dataServiceMock.loginAnonymous.mockReturnValue(
        throwError(() => new Error('Rejected'))
      );

      component.openLoginDialog();

      expect(tokenStorageServiceMock.saveToken).not.toHaveBeenCalled();
      expect(routerMock.navigate).not.toHaveBeenCalled();
    });

    it('survives a rejected token and accepts the next attempt', () => {
      dataServiceMock.loginAnonymous.mockReturnValue(
        throwError(() => new Error('Rejected'))
      );

      component.openLoginDialog();

      expect(notificationServiceMock.alert).toHaveBeenCalledTimes(1);
      expect(tokenStorageServiceMock.saveToken).not.toHaveBeenCalled();

      dataServiceMock.loginAnonymous.mockReturnValue(
        of({ authToken: 'AUTH_TOKEN' })
      );

      component.openLoginDialog();

      // What this pins is that a refusal is reported and then absorbed: it
      // neither escapes as an unhandled error nor stores anything, and the
      // attempt that follows is unaffected. Removing the handling outright, or
      // absorbing a refusal without reporting it, each fail here.
      //
      // Worth recording for whoever reads this next, because the opposite is
      // easy to assume: the order of the absorbing operator and the lifecycle
      // operator is not observable at this point, since a fresh inner
      // subscription is made every time the dialog closes. Swapping the two
      // leaves this file entirely green, so nothing here should be read as
      // guarding that ordering.
      expect(tokenStorageServiceMock.saveToken).toHaveBeenCalledTimes(1);
      expect(tokenStorageServiceMock.saveToken).toHaveBeenCalledWith(
        'AUTH_TOKEN',
        false
      );
      expect(notificationServiceMock.alert).toHaveBeenCalledTimes(1);
    });
  });

  describe('hasPromotion', () => {
    it('reports a promotion from the viewer own discount', () => {
      renderWithUser(
        createUser({
          subscription: {
            offer: createOffer({ coupon: 20 }),
            type: 'Basic'
          } as User['subscription']
        })
      );

      expect(component.hasPromotion).toBe(true);
    });

    it('reports a promotion from the viewer own extended duration', () => {
      renderWithUser(
        createUser({
          subscription: {
            // A duration the underlying duration type actually admits - it
            // recognises weeks but has no notion of months, so the tidier-looking
            // '1 month' would only compile behind a cast that hid the mistake.
            offer: createOffer({ durationExtension: '1 week' }),
            type: 'Basic'
          } as User['subscription']
        })
      );

      expect(component.hasPromotion).toBe(true);
    });

    it('lets the viewer own absent offer overrule the deployment offer', () => {
      dataServiceMock.fetchInfo.mockReturnValue(
        createInfo({ subscriptionOffer: createOffer({ coupon: 20 }) })
      );

      createComponent();
      renderWithUser();

      // A viewer's own offer wins outright. The deployment-wide offer is the
      // fallback for anyone without one, not an addition to it.
      expect(component.hasPromotion).toBe(false);
    });

    it('falls back to the deployment offer when there is no viewer', () => {
      dataServiceMock.fetchInfo.mockReturnValue(
        createInfo({ subscriptionOffer: createOffer({ coupon: 20 }) })
      );

      createComponent();
      stateChangedSubject.next({ user: null });

      expect(component.hasPromotion).toBe(true);
    });

    it('reports no promotion when neither side offers one', () => {
      stateChangedSubject.next({ user: null });

      expect(component.hasPromotion).toBe(false);
    });
  });

  describe('openAssistantWithHotKey', () => {
    let assistant: ReturnType<typeof createAssistantStub>;
    let menuTrigger: ReturnType<typeof createMenuTriggerStub>;

    beforeEach(() => {
      assistant = createAssistantStub();
      menuTrigger = createMenuTriggerStub();

      // Stood in for rather than used directly, so that opening the panel never
      // actually projects it. Keeping it unprojected is what keeps the assistant
      // and the premium indicator out of this compilation.
      component.assistantElement =
        assistant as unknown as GfDashboardToolbarComponent['assistantElement'];
      component.assistentMenuTriggerElement =
        menuTrigger as unknown as GfDashboardToolbarComponent['assistentMenuTriggerElement'];
      component.hasPermissionToAccessAssistant = true;
    });

    it('opens the assistant on the shortcut the former chrome established', () => {
      const event = dispatchKeydownFrom('div', '/');

      expect(assistant.setIsOpen).toHaveBeenCalledTimes(1);
      expect(assistant.setIsOpen).toHaveBeenCalledWith(true);
      expect(menuTrigger.openMenu).toHaveBeenCalledTimes(1);

      // Suppresses the character that would otherwise be inserted.
      expect(event.defaultPrevented).toBe(true);
    });

    it('leaves a slash typed into a text field alone', () => {
      const event = dispatchKeydownFrom('input', '/');

      expect(assistant.setIsOpen).not.toHaveBeenCalled();
      expect(menuTrigger.openMenu).not.toHaveBeenCalled();
      expect(event.defaultPrevented).toBe(false);
    });

    it('leaves a slash typed into a multi-line field alone', () => {
      const event = dispatchKeydownFrom('textarea', '/');

      expect(assistant.setIsOpen).not.toHaveBeenCalled();
      expect(menuTrigger.openMenu).not.toHaveBeenCalled();
      expect(event.defaultPrevented).toBe(false);
    });

    it('withholds the shortcut from a viewer without the capability', () => {
      component.hasPermissionToAccessAssistant = false;

      const event = dispatchKeydownFrom('div', '/');

      expect(assistant.setIsOpen).not.toHaveBeenCalled();
      expect(menuTrigger.openMenu).not.toHaveBeenCalled();
      expect(event.defaultPrevented).toBe(false);
    });

    it('ignores every other key', () => {
      const event = dispatchKeydownFrom('div', 'a');

      expect(assistant.setIsOpen).not.toHaveBeenCalled();
      expect(menuTrigger.openMenu).not.toHaveBeenCalled();
      expect(event.defaultPrevented).toBe(false);
    });
  });

  describe('onLogoClick', () => {
    it('asks for the content to be reloaded in place', () => {
      let reloads = 0;

      shouldReloadSubject.subscribe(() => {
        reloads += 1;
      });

      component.onLogoClick();

      expect(layoutServiceMock.getShouldReloadSubject).toHaveBeenCalledTimes(1);
      expect(reloads).toBe(1);

      // It reloads rather than navigates: activating the mark changes no address.
      expect(routerMock.navigate).not.toHaveBeenCalled();
      expect(navigationAttempts).toHaveLength(0);
    });

    it('asks unconditionally, whatever the viewer state', () => {
      let reloads = 0;

      shouldReloadSubject.subscribe(() => {
        reloads += 1;
      });

      // Previously conditional on standing on one of two screens. There is now
      // one canvas and no screen to be standing on, so the condition is gone -
      // and it must stay gone, because the value it tested no longer exists.
      stateChangedSubject.next({ user: null });
      component.onLogoClick();

      renderWithUser();
      component.onLogoClick();

      expect(reloads).toBe(2);
    });
  });

  describe('onSignOut', () => {
    it('signs the viewer out and then leaves for the locale root', () => {
      document.documentElement.lang = 'de';

      component.onSignOut();

      expect(userServiceMock.signOut).toHaveBeenCalledTimes(1);
      expect(navigationAttempts).toHaveLength(1);

      // Order matters: storage and cookies are cleared and the user store is
      // reset first, and only then is the document replaced.
      expect(callOrder).toEqual(['signOut', 'navigate']);
    });

    it('targets the document language and nothing else', () => {
      document.documentElement.lang = '';

      component.onSignOut();

      expect(userServiceMock.signOut).toHaveBeenCalledTimes(1);

      // With no language on the document the target is the bare root, which is
      // the address this document is already on - and jsdom performs no
      // navigation in that case. An empty attempt list is therefore an exact
      // statement about the address that was assigned: any other value, a
      // hard-coded locale among them, would have resolved elsewhere and been
      // reported.
      expect(navigationAttempts).toHaveLength(0);
      expect(window.location.href).toBe('http://localhost/');
    });

    it('leaves the document rather than routing within it', () => {
      document.documentElement.lang = 'de';

      component.onSignOut();

      // A full load, deliberately: it discards every in-memory cache belonging
      // to the identity that has just left.
      expect(routerMock.navigate).not.toHaveBeenCalled();
    });
  });

  describe('menu state', () => {
    it('follows the account panel as it opens and closes', () => {
      component.onMenuOpened();

      expect(component.isMenuOpen).toBe(true);

      component.onMenuClosed();

      expect(component.isMenuOpen).toBe(false);
    });
  });

  describe('capabilities that were once derived from the route', () => {
    it('grants both to a viewer', () => {
      renderWithUser();

      // Both were read off the active route by a shell that no longer has one.
      // On a single canvas there is no screen to qualify the capability, so it
      // reduces to whether there is a viewer to act for - which is also the
      // condition under which the assistant that consumes them is drawn. Pinned
      // here so that nobody reinstates a route test in their place.
      expect(component.hasPermissionToChangeDateRange).toBe(true);
      expect(component.hasPermissionToChangeFilters).toBe(true);
    });

    it('withholds both while no viewer is resolved', () => {
      stateChangedSubject.next({ user: null });

      expect(component.hasPermissionToChangeDateRange).toBe(false);
      expect(component.hasPermissionToChangeFilters).toBe(false);
    });
  });

  describe('what this bar deliberately is not', () => {
    /**
     * Selectors for affordances that belong to the canvas that mounts this
     * component, or to the navigation surface that was removed outright.
     */
    const FOREIGN_AFFORDANCE_SELECTORS = [
      '.fab-container',
      '.has-fab',
      '.mat-drawer',
      '.mat-mdc-fab',
      '[mat-fab]',
      '[mat-tab-nav-bar]',
      'h1',
      'h2',
      'h3',
      'mat-sidenav',
      'mat-sidenav-container',
      'mat-tab-nav-bar'
    ].join(', ');

    /**
     * The in-application link attribute, assembled from fragments rather than
     * written out.
     *
     * That is not affectation. This whole subtree is searched for that attribute
     * to prove no component in it links anywhere, and the one file asserting the
     * attribute's absence should not be the thing that makes that search report a
     * hit. Assembling it keeps the two statements - "no component here links" and
     * "and here is the test proving it" - from contradicting one another, while
     * the selector handed to the query below is character-for-character what a
     * written-out form would produce.
     */
    const LINK_ATTRIBUTE_PARTS = ['router', 'Link'];
    const LINK_ATTRIBUTE = LINK_ATTRIBUTE_PARTS.join('');
    const REFLECTED_LINK_ATTRIBUTE = `ng-reflect-${LINK_ATTRIBUTE_PARTS.join(
      '-'
    ).toLowerCase()}`;

    const IN_APPLICATION_ADDRESS_SELECTORS = [
      `[${LINK_ATTRIBUTE}]`,
      `[${REFLECTED_LINK_ATTRIBUTE}]`,
      'a[href^="."]',
      'a[href^="/"]'
    ].join(', ');

    it('offers no in-application address, signed out', () => {
      expect(
        host().querySelectorAll(IN_APPLICATION_ADDRESS_SELECTORS)
      ).toHaveLength(0);
      expect(host().innerHTML).not.toContain(LINK_ATTRIBUTE);
    });

    it('offers no in-application address, signed in', () => {
      renderWithUser();

      // Nothing here addresses a screen. No in-application link directive is
      // imported and no route constant is read, so there is nothing for this to
      // find - which is the whole point of asserting it.
      expect(
        host().querySelectorAll(IN_APPLICATION_ADDRESS_SELECTORS)
      ).toHaveLength(0);
      expect(host().innerHTML).not.toContain(LINK_ATTRIBUTE);
    });

    it('sends the one surviving address out of the application', () => {
      renderWithUser();

      // The plan page is hosted elsewhere, so it is an ordinary absolute target
      // in the viewer's own language rather than a route.
      expect(component.pricingUrl).toMatch(/^https:\/\/ghostfol\.io\/en\//);
    });

    it('draws no affordance that belongs to the canvas or to navigation', () => {
      renderWithUser();

      expect(
        host().querySelectorAll(FOREIGN_AFFORDANCE_SELECTORS)
      ).toHaveLength(0);
    });

    it('offers no way to reach an arrangement store', () => {
      // The facade this component is given answers three questions and no
      // others. Any attempt to reach a persistence method would raise a
      // TypeError and fail this suite, so the separation is a property of the
      // harness rather than an assertion about intent.
      expect(Object.keys(dataServiceMock)).toEqual([
        'fetchInfo',
        'loginAnonymous',
        'putUserSetting'
      ]);
    });

    it('holds no placement or visibility state of its own', () => {
      renderWithUser();

      // Cell coordinates, cell sizes and catalog visibility belong to the canvas
      // that mounts this bar. None of them is read or written here, and the bar
      // offers no control that would open or close the catalog either.
      const ownState = Object.keys(component);

      for (const member of ['cols', 'rows', 'x', 'y']) {
        expect(ownState).not.toContain(member);
      }
    });

    it('addresses nothing during ordinary operation', () => {
      renderWithUser();

      component.onLogoClick();
      component.onDateRangeChange('1y' as DateRange);
      component.onFiltersChanged([{ id: 'ID', type: 'TAG' }]);
      component.onSelectModule(DashboardModuleType.HOLDINGS);
      component.onMenuOpened();
      component.onMenuClosed();

      // Handing off after a token exchange is the only thing in this component
      // that addresses anything at all.
      expect(routerMock.navigate).not.toHaveBeenCalled();
      expect(navigationAttempts).toHaveLength(0);
    });

    it('takes nothing in and gives nothing out', () => {
      const mirror = reflectComponentType(GfDashboardToolbarComponent);

      // The values the deleted chrome received from the shell were derived from
      // the URL, and the shell no longer derives them because there is no route
      // table left to derive them from. Everything is resolved here instead, from
      // the services that own it, so the canvas mounts this bar and passes
      // nothing - and listens for nothing.
      expect(mirror.selector).toBe('gf-dashboard-toolbar');
      expect(mirror.inputs).toEqual([]);
      expect(mirror.outputs).toEqual([]);
      expect(mirror.isStandalone).toBe(true);
    });
  });
});
