import { DashboardIntentService } from '@ghostfolio/client/core/dashboard-intent.service';
import { LayoutService } from '@ghostfolio/client/core/layout.service';
import { ImpersonationStorageService } from '@ghostfolio/client/services/impersonation-storage.service';
import { UserService } from '@ghostfolio/client/services/user/user.service';
import { Filter, InfoItem, User } from '@ghostfolio/common/interfaces';
import { permissions } from '@ghostfolio/common/permissions';
import { DateRange } from '@ghostfolio/common/types';
import { AdminService, DataService } from '@ghostfolio/ui/services';

import { reflectComponentType } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
// No Jest setup file installs `$localize`, and both the bar's own strings and the
// shared metadata's display names compile to calls on it at module scope. Its
// position is load-bearing: this group is evaluated before the relative imports
// below, and the subject of this spec is one of them.
import '@angular/localize/init';
import { Router } from '@angular/router';
import { DeviceDetectorService } from 'ngx-device-detector';
import { BehaviorSubject, of, Subject } from 'rxjs';

import { DashboardModuleType } from '../../enums/dashboard-module-type';
import { GfDashboardToolbarComponent } from './dashboard-toolbar.component';

// Cuts the one dependency of the bar that this environment cannot load.
// `@ionic/angular/standalone` re-exports `@ionic/core`, which ships plain `.js`
// ES modules rather than `.mjs`, and this project's Jest transform deliberately
// admits only `.mjs` from `node_modules` - the workspace-wide setting that
// `libs/ui` shares - so importing the bar, which names `IonIcon` among its own
// `imports`, would fail this suite before a single test ran. The accommodation
// belongs here rather than in that global configuration, which every other spec
// in this project is transformed by.
//
// A bare class would not do: Angular validates every entry of an `imports`
// array, so the stand-in is a real standalone component carrying the same
// `ion-icon` selector, which also keeps the rendered markup identical in shape.
// The decorator is applied as a function because this factory is hoisted above
// the file's own imports, so no class declared here would exist yet.
jest.mock('@ionic/angular/standalone', () => {
  // Reached through the namespace rather than destructured, so that `Component`
  // is not shadowed in the files that name it for their own stand-ins.
  const angularCore =
    jest.requireActual<typeof import('@angular/core')>('@angular/core');

  return {
    IonIcon: angularCore.Component({ selector: 'ion-icon', template: '' })(
      class IonIcon {}
    )
  };
});

/**
 * Unit specification for the non-navigational dashboard control bar.
 *
 * Three things about this environment shape almost every decision below, and
 * each was established by measurement rather than assumption.
 *
 * **`Location` cannot be replaced.** jsdom implements `window.location` and its
 * members as `[LegacyUnforgeable]`, so `Object.defineProperty(window, 'location', …)`
 * throws `Cannot redefine property: location` and `jest.spyOn(window.location,
 * 'reload')` throws `Cannot assign to read only property 'reload'`. The two behaviours
 * that leave the page are therefore observed through the signal jsdom does emit: an
 * attempted navigation is reported on the virtual console, arriving here as a
 * `console.error`. {@link navigationAttempts} collects those and forwards everything
 * else to the real `console.error`, so a genuine framework error is never swallowed.
 *
 * jsdom performs no navigation at all when the target resolves to the URL the document
 * is already on, so an *empty* attempt list is itself an exact assertion about the
 * address that was assigned.
 *
 * **Projected panel contents are built even while the panel is shut.** A menu renders
 * its panel lazily, but the nodes handed to it are created with the view that declares
 * them, so the assistant is instantiated as soon as there is a viewer entitled to it -
 * which is why its collaborator is supplied below. Every test still leaves both menus
 * closed, because opening one would project a panel this spec has no reason to build.
 *
 * The premium indicator is the one child that never appears: it sits behind a
 * condition requiring both a subscription capability and a viewer holding a
 * basic plan, and no test satisfies both at once. That observation is incidental
 * rather than load-bearing - the indicator reaches the externally hosted plan
 * page through an ordinary absolute address and needs nothing supplied for it -
 * so a future test is free to render it.
 *
 * **A router is supplied even though this component does not inject one.** That
 * is not leftover scaffolding, and removing it does real damage. `Router` is
 * root-provided, so it cannot be made absent from the injector and its absence
 * cannot be asserted; what a stand-in buys instead is both halves of what this
 * spec needs. It keeps the real router from being constructed in a spec that
 * installs no route table - measured, not assumed: with the genuine router
 * resolved, a single assertion touching it took ten seconds. And it makes "this
 * bar addresses nothing" observable rather than merely unimplemented, because
 * every in-application navigation attempted by this component *or by any child
 * rendered with it* lands on the stand-in where it can be asserted absent. The
 * bar really did address something once, so that is a regression guard rather
 * than a truism. No router module, testing module or router provider function is
 * imported all the same.
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
   * The data facade, deliberately exposing two methods and no more.
   *
   * This is load-bearing rather than economical. Saving an arrangement is the
   * canvas's responsibility and is triggered only by grid state changing; this
   * bar has no part in it. Exchanging an access token belongs to the signed-out
   * component the canvas renders instead of its body, and this bar renders only
   * for a resolved viewer. Because the facade offered here answers nothing but
   * deployment info and a settings write, any attempt from this component to
   * reach either capability would raise a `TypeError` and fail the suite
   * outright, which turns both separations from a claim into a structural
   * property of the harness.
   */
  let dataServiceMock: {
    fetchInfo: jest.Mock;
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
  let impersonationStorageServiceMock: {
    getId: jest.Mock;
    onChangeHasImpersonation: jest.Mock;
    removeId: jest.Mock;
    setId: jest.Mock;
  };
  let layoutServiceMock: { getShouldReloadSubject: jest.Mock };
  let routerMock: { navigate: jest.Mock };
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

  let navigationAttempts: string[];

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

  const renderWithUser = (user: User = createUser()) => {
    stateChangedSubject.next({ user });

    fixture.detectChanges();
  };

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

    // Pinned so that signing out resolves to the address the document is
    // already on, which is the condition under which jsdom performs no
    // navigation - and therefore what lets an empty attempt list stand as an
    // exact statement about the address that was assigned.
    document.documentElement.lang = 'en';

    // Asserted rather than inferred: `Function.prototype.bind` widens its result
    // to `any`, which would make every forwarded report an unchecked call. The
    // assertion is on the expression rather than the binding so that the value
    // being stored is typed too, not merely the name it is stored under.
    const reportError = console.error.bind(console) as (
      ...args: unknown[]
    ) => void;

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
      putUserSetting: jest.fn().mockReturnValue(of({} as User))
    };

    deviceDetectorServiceMock = {
      getDeviceInfo: jest.fn().mockReturnValue({ deviceType: 'desktop' })
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

    routerMock = { navigate: jest.fn() };

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
        { provide: Router, useValue: routerMock },
        { provide: UserService, useValue: userServiceMock }
      ]
    }).compileComponents();

    createComponent();
  });

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
      // makes the capability it yields settled by the end of initialisation.
      expect(dataServiceMock.fetchInfo).toHaveBeenCalledTimes(1);
    });

    it('grants the capability the deployment declares', () => {
      dataServiceMock.fetchInfo.mockReturnValue(
        createInfo({
          globalPermissions: [permissions.enableSubscription]
        })
      );

      createComponent();

      expect(component.hasPermissionForSubscription).toBe(true);
    });

    it('withholds the capability the deployment does not declare', () => {
      expect(component.hasPermissionForSubscription).toBe(false);
    });

    it('derives no authentication capability, because it offers no sign-in', () => {
      // Sign-in belongs to the signed-out sibling, which this bar can never
      // coexist with: the bar renders only for a resolved viewer. Asserting the
      // absence keeps the duplicate surface from being reintroduced.
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

      expect(component).not.toHaveProperty('hasPermissionForAuthGoogle');
      expect(component).not.toHaveProperty('hasPermissionForAuthOidc');
      expect(component).not.toHaveProperty('hasPermissionForAuthToken');
      expect(component).not.toHaveProperty('openLoginDialog');
      expect(component).not.toHaveProperty('setToken');
    });

    it('renders as empty chrome until a viewer resolves', () => {
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

      expect(component.assistentMenuTriggerElement).toBeTruthy();

      const closeMenu = jest.spyOn(
        component.assistentMenuTriggerElement,
        'closeMenu'
      );

      component.closeAssistant();

      expect(closeMenu).toHaveBeenCalledTimes(1);
    });

    it('tolerates a dismissal requested before the panel exists', () => {
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

      expect(received[0]).toBe(moduleType);
    });

    it('adapts nothing on the way through', () => {
      const received: DashboardModuleType[] = [];

      revealModuleSubject.subscribe((intent) => received.push(intent));

      const moduleTypes = Object.values(DashboardModuleType);

      for (const moduleType of moduleTypes) {
        component.onSelectModule(moduleType);
      }

      expect(received).toEqual(moduleTypes);
      expect(
        received.every((moduleType) => typeof moduleType === 'string')
      ).toBe(true);
    });

    it('resolves nothing about the module it names', () => {
      component.onSelectModule(DashboardModuleType.HOLDINGS);

      // Which component backs a module, whether it is already placed and where
      // it would go are all answered by the canvas. Nothing here consults a
      // registry or a layout, and nothing here is given one to consult. It is
      // also not the navigation it replaced.
      expect(dataServiceMock.putUserSetting).not.toHaveBeenCalled();
      expect(routerMock.navigate).not.toHaveBeenCalled();
      expect(navigationAttempts).toHaveLength(0);
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

      expect(userServiceMock.get).toHaveBeenCalledTimes(1);
      expect(userServiceMock.get).toHaveBeenCalledWith(true);
    });
  });

  describe('onFiltersChanged', () => {
    const persistFilter = (filter: Filter) => {
      component.onFiltersChanged([filter]);

      expect(dataServiceMock.putUserSetting).toHaveBeenCalledTimes(1);

      // `mock.calls` is typed as `any[][]`, so the first argument is narrowed in
      // two steps rather than read straight through.
      const [[payload]] = dataServiceMock.putUserSetting.mock
        .calls as unknown[][];

      return payload as Record<string, unknown>;
    };

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

    /**
     * The rendered half of the capability.
     *
     * Held apart from the suite above on purpose. Every assertion up to this
     * point reads the computed state, and state alone is exactly what a bar that
     * computed an offer and then never drew it would satisfy - which is the
     * defect these two tests exist to make impossible. They therefore go through
     * the DOM, and they assert the address as well as the mark, because a mark
     * that leads nowhere restores the appearance of the capability without
     * restoring the capability.
     */
    describe('rendering', () => {
      it('draws the discount mark and points it at the plan page', () => {
        renderWithUser(
          createUser({
            subscription: {
              offer: createOffer({ coupon: 20 }),
              type: 'Basic'
            } as User['subscription']
          })
        );

        const promotion =
          host().querySelector<HTMLAnchorElement>('.gf-promotion');

        expect(promotion).toBeTruthy();
        expect(promotion.querySelector('.gf-promotion-mark')).toBeTruthy();

        // Bound to the member rather than written out, so a mark that stopped
        // following the viewer's own plan address would fail here; and still an
        // address outside this application, which is the only kind this bar is
        // allowed to carry.
        expect(promotion.getAttribute('href')).toBe(component.pricingUrl);
        expect(promotion.getAttribute('href')).toMatch(
          /^https:\/\/ghostfol\.io\/en\//
        );
        expect(promotion.getAttribute('target')).toBe('_blank');
      });

      it('draws no discount mark when there is no offer', () => {
        renderWithUser();

        expect(host().querySelector('.gf-promotion')).toBeNull();
      });
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

      expect(routerMock.navigate).not.toHaveBeenCalled();
      expect(navigationAttempts).toHaveLength(0);
    });

    it('asks unconditionally, whatever the viewer state', () => {
      let reloads = 0;

      shouldReloadSubject.subscribe(() => {
        reloads += 1;
      });

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

      expect(callOrder).toEqual(['signOut', 'navigate']);
    });

    it('targets the document language and nothing else', () => {
      document.documentElement.lang = '';

      component.onSignOut();

      expect(userServiceMock.signOut).toHaveBeenCalledTimes(1);

      expect(navigationAttempts).toHaveLength(0);
      expect(window.location.href).toBe('http://localhost/');
    });

    it('leaves the document rather than routing within it', () => {
      document.documentElement.lang = 'de';

      component.onSignOut();

      // A full load, deliberately: it discards every in-memory cache belonging
      // to the identity that has just left. Routing within the application would
      // not, which is why the distinction is asserted rather than assumed.
      expect(navigationAttempts).toHaveLength(1);
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

      expect(
        host().querySelectorAll(IN_APPLICATION_ADDRESS_SELECTORS)
      ).toHaveLength(0);
      expect(host().innerHTML).not.toContain(LINK_ATTRIBUTE);
    });

    it('sends the one surviving address out of the application', () => {
      renderWithUser();

      expect(component.pricingUrl).toMatch(/^https:\/\/ghostfol\.io\/en\//);
    });

    it('draws no affordance that belongs to the canvas or to navigation', () => {
      renderWithUser();

      expect(
        host().querySelectorAll(FOREIGN_AFFORDANCE_SELECTORS)
      ).toHaveLength(0);
    });

    it('offers no way to reach an arrangement store, or a token exchange', () => {
      // The facade this component is given answers two questions and no others.
      // Any attempt to reach a persistence method - or to exchange an access
      // token, which belongs to the signed-out component the canvas renders
      // instead of its body - would raise a TypeError and fail this suite, so
      // both separations are properties of the harness rather than assertions
      // about intent.
      expect(Object.keys(dataServiceMock)).toEqual([
        'fetchInfo',
        'putUserSetting'
      ]);
    });

    it('offers no sign-in flow of its own', () => {
      renderWithUser();

      // Access-token sign-in is owned in full by the signed-out sibling the
      // canvas mounts instead of the canvas body. This bar draws nothing until a
      // viewer has resolved, so a second copy here could never be reached from
      // its template. The harness makes that structural rather than aspirational:
      // no dialog surface, no token store, no stay-signed-in preference and no
      // notification surface is supplied, so reaching for one would fail this
      // suite outright.
      const surface = component as unknown as Record<string, unknown>;

      expect(surface['openLoginDialog']).toBeUndefined();
      expect(surface['setToken']).toBeUndefined();
    });

    it('holds no placement or visibility state of its own', () => {
      renderWithUser();

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

      // Every capability here acts in place. The only two that leave the page do
      // so deliberately and by replacing the document - switching identity and
      // signing out - and neither is exercised above. Nothing routes, ever: this
      // component no longer injects a router at all, and the stand-in supplied to
      // the subtree records that no child rendered with it does either.
      expect(routerMock.navigate).not.toHaveBeenCalled();
      expect(navigationAttempts).toHaveLength(0);
    });

    it('derives no authentication capability, even where the deployment grants one', () => {
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

      // Signing in is the one capability of the deleted chrome that this bar
      // deliberately does not carry: in the chrome it existed only in the
      // signed-out branch, and on this canvas that branch is a sibling component
      // which owns the dialog, the exchange and the stay-signed-in preference.
      // This bar renders only for a resolved viewer, so a second copy here could
      // never be reached. Asserted against a deployment that grants all three
      // paths, because that is the input under which an unreachable copy would
      // look alive.
      for (const member of Object.keys(component)) {
        expect(member).not.toMatch(/auth/i);
        expect(member).not.toMatch(/token/i);
      }
    });

    it('takes nothing in and gives nothing out', () => {
      const mirror = reflectComponentType(GfDashboardToolbarComponent);

      expect(mirror.selector).toBe('gf-dashboard-toolbar');
      expect(mirror.inputs).toEqual([]);
      expect(mirror.outputs).toEqual([]);
      expect(mirror.isStandalone).toBe(true);
    });
  });
});
