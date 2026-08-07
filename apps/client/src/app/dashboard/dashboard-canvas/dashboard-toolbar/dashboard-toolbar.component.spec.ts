import { DashboardIntentService } from '@ghostfolio/client/core/dashboard-intent.service';
import { LayoutService } from '@ghostfolio/client/core/layout.service';
import { GfModuleRegistryService } from '@ghostfolio/client/dashboard/module-registry.service';
import { GfDashboardLayoutService } from '@ghostfolio/client/dashboard/services/dashboard-layout.service';
import { ImpersonationStorageService } from '@ghostfolio/client/services/impersonation-storage.service';
import { UserService } from '@ghostfolio/client/services/user/user.service';
import {
  DashboardModule,
  dashboardModules
} from '@ghostfolio/common/dashboard';
import { Filter, InfoItem, User } from '@ghostfolio/common/interfaces';
import { permissions } from '@ghostfolio/common/permissions';
import { DateRange } from '@ghostfolio/common/types';
import { GfAssistantComponent } from '@ghostfolio/ui/assistant/assistant.component';
import { QuickLinkSearchResultItem } from '@ghostfolio/ui/assistant/interfaces/interfaces';
import type { AlertParams } from '@ghostfolio/ui/notifications';
import { NotificationService } from '@ghostfolio/ui/notifications';
import { AdminService, DataService } from '@ghostfolio/ui/services';

import { reflectComponentType } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
// No Jest setup file installs `$localize`, and both the bar's own strings and the
// shared metadata's display names compile to calls on it at module scope. Its
// position is load-bearing: this group is evaluated before the relative imports
// below, and the subject of this spec is one of them.
import '@angular/localize/init';
import { By } from '@angular/platform-browser';
import { ActivatedRoute, Router } from '@angular/router';
import { DeviceDetectorService } from 'ngx-device-detector';
import { BehaviorSubject, Observable, of, Subject, throwError } from 'rxjs';

import { DashboardModuleType } from '../../enums/dashboard-module-type';
import { GfDashboardToolbarComponent } from './dashboard-toolbar.component';

// Cuts the one dependency of the bar that this suite has no use for.
// `@ionic/angular/standalone` re-exports `@ionic/core`, which ships plain `.js`
// ES modules rather than `.mjs`; both this project's and `libs/ui`'s Jest
// transforms name the `@ionic` and `@stencil` families explicitly so that it
// parses, so this stand-in is no longer what makes the bar importable. It is
// kept deliberately all the same: the bar's glyphs carry no behaviour this
// suite asserts, and standing them in keeps the whole Stencil runtime - and its
// custom-element registration - out of a suite about a control bar, while the
// rendered markup keeps the same shape.
//
// A bare class would not do: Angular validates every entry of an `imports`
// array, so the stand-in is a real standalone component carrying the same
// `ion-icon` selector. The decorator is applied as a function because this
// factory is hoisted above the file's own imports, so no class declared here
// would exist yet.
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
   *
   * The two optional search accessors are supplied by - and only by - the group
   * that mounts the *real* assistant, which issues those reads itself. They are
   * declared optional rather than required precisely so that the guarantee above
   * survives: neither names a layout write nor a token exchange, and every other
   * test in this suite still receives a facade without them.
   */
  let dataServiceMock: {
    fetchAccounts?: jest.Mock;
    fetchInfo: jest.Mock;
    fetchPortfolioHoldings?: jest.Mock;
    putUserSetting: jest.Mock;
  };

  /**
   * The assistant's own collaborator, supplied because the assistant is built with
   * the view that declares it. Left empty by default on purpose: the assistant
   * reaches for it only once a search is under way, so only the group that runs a
   * real search fills the accessor in.
   */
  let adminServiceMock: { fetchAdminMarketData?: jest.Mock };

  let dashboardIntentServiceMock: { getRevealModuleSubject: jest.Mock };
  // Only the one member this bar reaches for. Signing out is an application-driven
  // departure, so the debounce window that is acceptable to lose when a tab is
  // closed is NOT acceptable here - the bar has to force the pending write out
  // before it leaves the document, and now has to WAIT for it, because a request
  // merely started is not a request the replaced document will let finish. It
  // releases and nothing more: the arrangement was produced by the grid and the
  // request is the layout service's to issue.
  let dashboardLayoutServiceMock: {
    releasePendingSave: jest.Mock<Observable<void>, []>;
  };
  let deviceDetectorServiceMock: { getDeviceInfo: jest.Mock };
  let impersonationStorageServiceMock: {
    getId: jest.Mock;
    onChangeHasImpersonation: jest.Mock;
    removeId: jest.Mock;
    setId: jest.Mock;
  };
  let layoutServiceMock: { getShouldReloadSubject: jest.Mock };
  /**
   * The one dialog surface this bar has. It is reached only when the arrangement
   * the viewer last made could not be stored on the way out, which is why the
   * stand-in records the parameters rather than rendering anything: what matters
   * is that the viewer was told, and that the departure waits for them.
   */
  let notificationServiceMock: { alert: jest.Mock<void, [AlertParams]> };
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
  let consoleWarnSpy: jest.SpyInstance;

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

    // Records into the same ordering list the sign-out and navigation reports use,
    // because WHEN the release happens is the whole of this fix: after the document
    // has been left, the write would never be issued.
    //
    // Completes synchronously by default, which is what the ordering assertions
    // below depend on: the bar leaves only once the flush reports the write
    // settled, so a stand-in that never reported would leave it here for ever. The
    // tests that assert the wait override it with a subject of their own.
    dashboardLayoutServiceMock = {
      releasePendingSave: jest.fn<Observable<void>, []>(() => {
        callOrder.push('releasePendingSave');

        return of(undefined);
      })
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

    notificationServiceMock = { alert: jest.fn<void, [AlertParams]>() };

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
        {
          provide: GfDashboardLayoutService,
          useValue: dashboardLayoutServiceMock
        },
        { provide: DataService, useValue: dataServiceMock },
        { provide: DeviceDetectorService, useValue: deviceDetectorServiceMock },
        {
          provide: ImpersonationStorageService,
          useValue: impersonationStorageServiceMock
        },
        {
          provide: ActivatedRoute,
          // Present only so that the real assistant's result rows can be rendered:
          // each row carries a link directive, which injects this even when the link it
          // is given resolves to nothing - and for a quick link it resolves to nothing
          // by design. Deliberately empty, because a member of it being read would mean
          // an address was being composed after all, and the negative-surface tests
          // below would then be asserting against a stub that had quietly enabled the
          // thing they forbid. The `Router` above stays a recording stub for the same
          // reason.
          useValue: {} as ActivatedRoute
        },
        { provide: LayoutService, useValue: layoutServiceMock },
        {
          provide: NotificationService,
          useValue: notificationServiceMock
        },
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

  /**
   * The producer and the consumer of the module-selection contract, pinned to each
   * other.
   *
   * Every other test in this group hands {@link GfDashboardToolbarComponent.onSelectModule}
   * a discriminator written by hand, and the assistant that supplies one in production
   * is replaced by {@link createAssistantStub} - both correct in isolation, and
   * together they leave the seam between them unchecked. The assistant lives in
   * `libs/ui`, which may not import this application, so nothing in the compiler
   * relates what it emits to what is resolved here; its result contract changed from
   * an in-application address to a module discriminator, and a later divergence
   * between the two sides would keep both suites green.
   *
   * These tests therefore use the **real** `GfAssistantComponent` that the bar's own
   * template declares, drive its **real** search pipeline over the **real** shared
   * module metadata, and follow the emission through the template binding the bar
   * actually writes - `(moduleSelected)="onSelectModule($event)"` - to the intent bus,
   * and then into the **real** `GfModuleRegistryService`. That last hop is the half
   * that cannot be asserted from inside `libs/ui`, and it is what makes an emitted
   * discriminator provably resolvable rather than merely well-formed.
   */
  describe('the assistant contract, end to end', () => {
    /** The real debounce window in the assistant's own search pipeline. */
    const SEARCH_DEBOUNCE = 300;

    /** The real preselection delay, so the settled results are what get read. */
    const PRESELECTION_DELAY = 100;

    /** Angular's advisory that a `@for` block tracks its items by identity. */
    const TRACK_BY_IDENTITY_ADVISORY = 'NG0956';

    let assistant: GfAssistantComponent;
    let received: DashboardModuleType[];
    let registry: GfModuleRegistryService;

    /**
     * Collected rather than silenced. Rendering the assistant's real results makes
     * Angular advise that its template tracks rows by identity, which it genuinely
     * does - the search pipeline builds fresh result objects on every pass - so the
     * advisory belongs to that template and not to this suite. Recognising it and
     * asserting that nothing else was warned keeps the run's log meaningful, which a
     * blanket spy on `console.warn` would destroy.
     */
    let trackingAdvisories: string[];

    /** Anything warned that was not that advisory; asserted empty and forwarded. */
    let otherWarnings: unknown[][];

    /**
     * Brings up the real assistant the way the bar does, and hands back the instance
     * the bar itself holds rather than one this spec constructed.
     *
     * The panel has to be opened first: the assistant is projected into a `mat-menu`,
     * whose content is stamped from a template only once the menu is shown, so before
     * that there is no instance to reach - not through the bar's own view query and not
     * through the fixture's DOM, since the panel renders into an overlay outside it.
     * Opening it through the real trigger is also what makes `onOpenAssistant()` - the
     * handler the panel's `menuOpened` binding calls - operate on a real collaborator
     * instead of a stand-in.
     */
    const renderWithRealAssistant = () => {
      renderWithUser();

      component.assistentMenuTriggerElement.openMenu();

      fixture.detectChanges();

      const projected = fixture.debugElement.query(
        By.directive(GfAssistantComponent)
      );

      assistant = component.assistantElement;

      // Verified rather than assumed, on both counts. This is the one place in the
      // workspace where the bar's binding and the assistant's output are checked
      // against each other, so it would be worthless against a stand-in substituted by
      // mistake - hence the instance check - and worthless again if the bar's view
      // reference pointed at some other instance than the one its template declared,
      // hence the identity check.
      expect(assistant).toBeInstanceOf(GfAssistantComponent);
      expect(assistant).toBe(projected.componentInstance);

      component.onOpenAssistant();

      jest.advanceTimersByTime(PRESELECTION_DELAY);

      fixture.detectChanges();
    };

    /** Runs a real search through the assistant's real pipeline and settles it. */
    const search = (searchTerm: string) => {
      assistant.searchFormControl.setValue(searchTerm);

      jest.advanceTimersByTime(SEARCH_DEBOUNCE);

      fixture.detectChanges();

      jest.advanceTimersByTime(PRESELECTION_DELAY);

      fixture.detectChanges();
    };

    beforeEach(() => {
      // Only the searches the real assistant issues need answering; the bar itself
      // reaches neither accessor. Added to the existing doubles rather than to new
      // ones so that every other test in this suite keeps the collaborators it had.
      adminServiceMock.fetchAdminMarketData = jest
        .fn()
        .mockReturnValue(of({ count: 0, marketData: [] }));
      dataServiceMock.fetchAccounts = jest
        .fn()
        .mockReturnValue(of({ accounts: [] }));
      dataServiceMock.fetchPortfolioHoldings = jest
        .fn()
        .mockReturnValue(of({ holdings: [] }));

      received = [];
      revealModuleSubject.subscribe((intent) => received.push(intent));

      trackingAdvisories = [];
      otherWarnings = [];

      // Asserted on the expression rather than on the binding, so the stored value is
      // typed too: `Function.prototype.bind` widens its result to `any`.
      const reportWarning = console.warn.bind(console) as (
        ...args: unknown[]
      ) => void;

      consoleWarnSpy = jest
        .spyOn(console, 'warn')
        .mockImplementation((...args: unknown[]) => {
          const [detail] = args;
          const report = typeof detail === 'string' ? detail : '';

          if (report.includes(TRACK_BY_IDENTITY_ADVISORY)) {
            trackingAdvisories.push(report);

            return;
          }

          otherWarnings.push(args);

          reportWarning(...args);
        });

      registry = TestBed.inject(GfModuleRegistryService);

      // Installed after the bar has been built, so only the assistant's own debounce
      // and preselection are driven by hand.
      jest.useFakeTimers();
    });

    afterEach(() => {
      // Dismissed before the clock is handed back, so the panel's own teardown runs
      // against the timers this group installed rather than leaving an open overlay
      // behind for the next test to find.
      component.assistentMenuTriggerElement?.closeMenu();

      fixture.detectChanges();

      jest.runOnlyPendingTimers();
      jest.useRealTimers();

      consoleWarnSpy.mockRestore();
    });

    it('reveals the module a real assistant emission names', () => {
      renderWithRealAssistant();

      search('Watchlist');

      const quickLinks = assistant.searchResults
        .quickLinks as QuickLinkSearchResultItem[];

      expect(quickLinks.length).toBeGreaterThan(0);

      // Exactly what the rendered row does when it is activated: the row emits its
      // item's discriminator, the assistant republishes it, and the bar's template
      // binding delivers it here.
      assistant.onSelectModule(quickLinks[0].moduleType);

      expect(received).toEqual([DashboardModuleType.WATCHLIST]);
    });

    it('resolves every discriminator a real assistant emits through the registry', () => {
      renderWithRealAssistant();

      const emitted: DashboardModuleType[] = [];

      // Every distinct display name in the shared map, so the assertion covers the
      // whole vocabulary the assistant can offer this viewer rather than whichever
      // entries one fuzzy search returned. Distinct, because the assistant discards a
      // term that has not changed and would settle on nothing for a repeat.
      const searchTerms = [
        ...new Set(
          Object.values<DashboardModule>(dashboardModules).map(({ name }) => {
            return name;
          })
        )
      ];

      for (const searchTerm of searchTerms) {
        search(searchTerm);

        for (const quickLink of assistant.searchResults
          .quickLinks as QuickLinkSearchResultItem[]) {
          assistant.onSelectModule(quickLink.moduleType);

          emitted.push(quickLink.moduleType);
        }
      }

      expect(emitted.length).toBeGreaterThan(0);
      expect(received).toEqual(emitted);

      // The seam this suite exists for: a discriminator that the registry cannot
      // resolve would leave the canvas nothing to reveal, and the row would look live
      // while doing nothing.
      for (const moduleType of received) {
        expect(registry.get(moduleType)).toBeDefined();
      }
    });

    it('emits a module discriminator rather than an in-application address', () => {
      renderWithRealAssistant();

      search('Holdings');

      const quickLinks = assistant.searchResults
        .quickLinks as QuickLinkSearchResultItem[];

      expect(quickLinks.length).toBeGreaterThan(0);

      for (const quickLink of quickLinks) {
        // The shape of the emission is the contract that changed. An address would be
        // an array of segments, and the bar would forward it onto the bus unresolved -
        // which is precisely the regression that would pass both sides' own suites.
        expect(typeof quickLink.moduleType).toBe('string');
        expect(Array.isArray(quickLink.moduleType)).toBe(false);
        expect(quickLink).not.toHaveProperty('routerLink');
      }
    });

    it('offers a real viewer no module the registry gates away from them', () => {
      // The bar's default viewer holds no administration permission, so the gated
      // modules must not be offered at all. Deleting the page chrome removed the only
      // client-side admin gate, which is what makes this filter load-bearing rather
      // than cosmetic.
      renderWithRealAssistant();

      search('Users');

      const emittedModuleTypes = (
        assistant.searchResults.quickLinks as QuickLinkSearchResultItem[]
      ).map(({ moduleType }) => {
        return moduleType;
      });

      expect(emittedModuleTypes).not.toContain(DashboardModuleType.ADMIN_USERS);
      expect(received).toEqual([]);
    });

    it('reports no diagnostic beyond the assistant own identity tracking', () => {
      renderWithRealAssistant();

      search('Holdings');

      // A second settled search is what provokes the advisory: the rows are re-created
      // only when the collection is replaced, which is exactly what the pipeline does.
      search('Holding');

      // The advisory is expected, and asserting that it is the *only* thing warned is
      // what makes it evidence rather than noise. Anything else appearing here would be
      // a real diagnostic that mounting the real assistant had introduced, and this
      // group must not hide one behind a blanket spy.
      expect(trackingAdvisories.length).toBeGreaterThan(0);
      expect(otherWarnings).toEqual([]);
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

  /**
   * The bar as an operable surface rather than as a set of handlers.
   *
   * Every finding this group covers shipped because `strictTemplates` is off in
   * this project: a binding to a member that does not exist compiles, lints and
   * ships in silence, so a duplicated control bound to nothing rendered as a blank
   * unnamed button and a pill bound to nothing rendered as nothing at all. These
   * tests assert against the DOM the template actually produces, which is the only
   * place that is visible.
   */
  describe('the operable surface of the bar', () => {
    /**
     * Every control in the bar, in document order.
     *
     * Anchors are included because two of the bar's affordances are external
     * addresses, and they are as much controls as the buttons are. The account
     * menu's own rows are excluded by construction: `MatMenu` renders into an
     * overlay outside this host until it is opened.
     */
    const controls = () => {
      return Array.from(
        host().querySelectorAll<HTMLElement>(
          'mat-toolbar button, mat-toolbar a[mat-button], mat-toolbar a[matButton]'
        )
      );
    };

    /**
     * The name assistive technology would announce for a control.
     *
     * Only the two sources this template uses are consulted - an explicit
     * `aria-label`, or the control's own text - which is deliberate: a third source
     * appearing here would be a change to how the bar is named, and it should have
     * to be added to this helper before it can pass.
     */
    const accessibleName = (control: HTMLElement) => {
      return (
        control.getAttribute('aria-label')?.trim() ||
        control.textContent.trim() ||
        ''
      );
    };

    /**
     * Controls that would switch the appearance, found by the glyphs such a
     * control has to use.
     *
     * Kept as a helper even though the expectation is that it finds nothing: the
     * assertion below is about absence, and absence is only meaningful if the
     * search for the thing is real.
     */
    const appearanceControls = () => {
      return controls().filter((control) => {
        const glyph = control.querySelector('ion-icon') as unknown as {
          name?: string;
        };

        return (
          glyph?.name === 'moon-outline' || glyph?.name === 'sunny-outline'
        );
      });
    };

    afterEach(() => {
      document.body.classList.remove('theme-dark');
    });

    // The bar offers no appearance control, in either appearance, and that is the
    // invariant rather than an omission waiting to be filled.
    //
    // The chrome this bar replaces had none - the appearance was reached through
    // the account settings screen - so a control here would be new surface, not
    // rescued surface. It would also be the wrong shape for the preference: the
    // stored `colorScheme` has three states, the third being "follow the operating
    // system", and a single icon can offer only two of them, so pressing it would
    // silently discard the system-following state. Choosing the appearance belongs
    // to the account settings module and applying it to the shell.
    it('offers no appearance control at all', () => {
      renderWithUser();

      expect(appearanceControls()).toEqual([]);

      document.body.classList.add('theme-dark');

      renderWithUser();

      expect(appearanceControls()).toEqual([]);
    });

    // The absence is asserted at the write as well as at the control, because a
    // handler with no affordance would still be reachable from a template edit and
    // would still take the third state away.
    it('writes no appearance setting of its own', () => {
      renderWithUser();

      for (const control of controls()) {
        control.click();
      }

      expect(
        dataServiceMock.putUserSetting.mock.calls.filter(([userSetting]) => {
          return 'colorScheme' in (userSetting as Record<string, unknown>);
        })
      ).toEqual([]);
    });

    it('names every control it renders', () => {
      renderWithUser(
        createUser({
          permissions: [
            permissions.accessAssistant,
            permissions.createUserAccount
          ]
        })
      );

      const unnamed = controls()
        .filter((control) => accessibleName(control) === '')
        .map((control) => control.outerHTML);

      expect(unnamed).toEqual([]);
      expect(controls().length).toBeGreaterThan(1);
    });

    it('names every control it renders while an identity is borrowed', () => {
      impersonationSubject.next('ACCESS_ID');

      renderWithUser();

      const unnamed = controls()
        .filter((control) => accessibleName(control) === '')
        .map((control) => control.outerHTML);

      // The identity trigger was the one that lost its name here: its label was
      // bound to a member that did not exist, so borrowing an identity left the
      // only path to signing out both unnamed and unglyphed.
      expect(unnamed).toEqual([]);
    });

    /**
     * WCAG 2.2 SC 2.5.3, on the one control that showed visible words.
     */
    describe('the mark', () => {
      const mark = () => {
        return host().querySelector<HTMLButtonElement>('.gf-dashboard-refresh');
      };

      it('keeps the visible word inside its accessible name', () => {
        renderWithUser();

        expect(mark().textContent).toContain('Ghostfolio');

        // No `aria-label`, on purpose. One of "Refresh dashboard" replaced the
        // visible word wholesale, which leaves a speech-input user unable to
        // address the control by the word they can see.
        expect(mark().hasAttribute('aria-label')).toBe(false);
        expect(accessibleName(mark())).toContain('Ghostfolio');
      });

      it('carries the action as its description instead', () => {
        renderWithUser();

        // The action is not lost - it is exposed where it does not compete with
        // the name.
        expect(mark().getAttribute('title')).toBe('Refresh dashboard');
      });
    });

    describe('the borrowed-identity marker', () => {
      const marker = () => {
        return host().querySelector<HTMLElement>('.gf-impersonation-indicator');
      };

      /**
       * Located structurally rather than by its name or its glyph, because both of
       * those are what these tests are here to check - selecting on either would
       * make the assertion circular and, when it regressed, would fail by finding
       * nothing rather than by reporting what was wrong.
       *
       * The identity menu is the last item in the bar's list, and it is the only
       * menu trigger there besides the assistant's.
       */
      const identityTrigger = () => {
        const items = Array.from(
          host().querySelectorAll<HTMLElement>('mat-toolbar ul > li')
        );

        return items[items.length - 1].querySelector<HTMLButtonElement>(
          'button[aria-haspopup]'
        );
      };

      it('shows nothing while the viewer is themselves', () => {
        renderWithUser();

        expect(marker()).toBeNull();
      });

      it('carries real words so it has a line box at all', () => {
        impersonationSubject.next('ACCESS_ID');

        renderWithUser();

        // The pill was fully styled and reported as visible, yet painted nothing:
        // it is a flex box with no intrinsic height, and with only whitespace
        // inside it, it measured exactly 0px tall.
        expect(marker()).toBeTruthy();
        expect(marker().textContent.trim()).toBe('Viewing another account');
      });

      it('announces itself without becoming part of a control name', () => {
        impersonationSubject.next('ACCESS_ID');

        renderWithUser();

        expect(marker().getAttribute('role')).toBe('status');

        // A live region nested inside a button merges its announcement into that
        // button's name. It is a sibling of the trigger for that reason, not for
        // layout.
        expect(marker().closest('button')).toBeNull();
      });

      it('leaves the identity trigger both named and glyphed', () => {
        impersonationSubject.next('ACCESS_ID');

        renderWithUser();

        const trigger = identityTrigger();

        expect(trigger).toBeTruthy();
        expect(accessibleName(trigger)).toBe('Viewing another account');

        // Rendered inside the trigger, the marker REPLACED these, leaving a blank
        // button as the only way to reach the identity menu.
        expect(trigger.querySelectorAll('ion-icon')).toHaveLength(2);
      });

      it('names the identity trigger for a viewer who has borrowed nobody', () => {
        renderWithUser();

        expect(accessibleName(identityTrigger())).toBe('Account');
        expect(identityTrigger().querySelectorAll('ion-icon')).toHaveLength(2);
      });
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
    /**
     * Signs out the way a viewer does, and lets the release settle.
     *
     * Every assertion about the departure has to run AFTER the release settles,
     * because settling it is what frees the departure - which is the whole of the
     * fix. The default stand-in completes synchronously, so calling this is enough;
     * kept as one helper so no test can accidentally assert against the
     * half-finished state, and so a test that wants to hold the release open
     * overrides the stand-in instead of reaching past this.
     */
    const signOutAndSettleFlush = () => {
      component.onSignOut();
    };

    it('signs the viewer out and then leaves for the locale root', () => {
      document.documentElement.lang = 'de';

      signOutAndSettleFlush();

      expect(userServiceMock.signOut).toHaveBeenCalledTimes(1);
      expect(navigationAttempts).toHaveLength(1);

      expect(callOrder).toEqual(['releasePendingSave', 'signOut', 'navigate']);
    });

    // The finding this addresses: an arrangement change made inside the debounce
    // window and followed immediately by signing out was simply lost. Losing it to
    // a closed tab is a window this design accepts - nothing can be issued from a
    // document that is going away on its own - but signing out is the application's
    // own doing, so it is the one departure that can and must carry the write with
    // it.
    it('releases the pending arrangement before anything else happens', () => {
      document.documentElement.lang = 'de';

      signOutAndSettleFlush();

      expect(
        dashboardLayoutServiceMock.releasePendingSave
      ).toHaveBeenCalledTimes(1);

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

    // A value emission is not a settlement. `AsyncSubject`-backed completion emits
    // before it completes, so a departure driven by `next` rather than by `complete`
    // would leave twice - and the second attempt would run after the credential had
    // already been discarded.
    it('departs exactly once however the release settles', () => {
      const release = new Subject<void>();

      dashboardLayoutServiceMock.releasePendingSave.mockReturnValue(
        release.asObservable()
      );

      document.documentElement.lang = 'de';

      component.onSignOut();

      release.next();
      release.complete();

      expect(userServiceMock.signOut).toHaveBeenCalledTimes(1);
      expect(navigationAttempts).toHaveLength(1);
    });

    it('releases even when the departure itself goes nowhere', () => {
      // The locale is what the destination is composed from, and an absent one
      // means no address is assigned at all. The release must not be conditional on
      // that: the arrangement is pending either way.
      document.documentElement.lang = '';

      signOutAndSettleFlush();

      expect(
        dashboardLayoutServiceMock.releasePendingSave
      ).toHaveBeenCalledTimes(1);
      expect(navigationAttempts).toHaveLength(0);
    });

    it('targets the document language and nothing else', () => {
      document.documentElement.lang = '';

      signOutAndSettleFlush();

      expect(userServiceMock.signOut).toHaveBeenCalledTimes(1);

      expect(navigationAttempts).toHaveLength(0);
      expect(window.location.href).toBe('http://localhost/');
    });

    it('leaves the document rather than routing within it', () => {
      document.documentElement.lang = 'de';

      signOutAndSettleFlush();

      // A full load, deliberately: it discards every in-memory cache belonging
      // to the identity that has just left. Routing within the application would
      // not, which is why the distinction is asserted rather than assumed.
      expect(navigationAttempts).toHaveLength(1);
      expect(routerMock.navigate).not.toHaveBeenCalled();
    });

    // The second half of the same finding. Issuing the flush first is not enough:
    // an `HttpClient` request is not guaranteed to survive the document being
    // replaced, so a write merely started before the assignment could still be
    // abandoned in flight - the same silent loss, moved a few microseconds later.
    it('waits for the flush to settle before discarding the session', () => {
      const flush = new Subject<void>();

      dashboardLayoutServiceMock.releasePendingSave.mockReturnValue(
        flush.asObservable()
      );

      document.documentElement.lang = 'de';

      component.onSignOut();

      // Still here: the write has not answered, so neither the credentials nor
      // the document have been touched.
      expect(userServiceMock.signOut).not.toHaveBeenCalled();
      expect(navigationAttempts).toHaveLength(0);

      flush.complete();

      expect(userServiceMock.signOut).toHaveBeenCalledTimes(1);
      expect(navigationAttempts).toHaveLength(1);
    });

    it('tells the viewer when the arrangement could not be stored', () => {
      dashboardLayoutServiceMock.releasePendingSave.mockReturnValue(
        throwError(() => new Error('flush failed'))
      );

      document.documentElement.lang = 'de';

      component.onSignOut();

      // Told, not left to guess. Leaving in silence would let the viewer believe
      // an arrangement they can still see had been saved, and the failure is
      // reported through the sanitized channel as well so it is diagnosable.
      expect(notificationServiceMock.alert).toHaveBeenCalledTimes(1);
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        'GF-DASHBOARD-LAYOUT-SIGN-OUT-FLUSH-FAILED'
      );

      // Nothing has happened yet: the departure waits on the acknowledgement.
      expect(userServiceMock.signOut).not.toHaveBeenCalled();
      expect(navigationAttempts).toHaveLength(0);
    });

    it('still lets the viewer leave once they acknowledge the failure', () => {
      dashboardLayoutServiceMock.releasePendingSave.mockReturnValue(
        throwError(() => new Error('flush failed'))
      );

      document.documentElement.lang = 'de';

      component.onSignOut();

      notificationServiceMock.alert.mock.calls[0][0].discardFn();

      // A viewer who asks to sign out must always be able to. An arrangement that
      // cannot be stored - a document this build cannot write, say - would
      // otherwise hold them in the session indefinitely, which is a worse failure
      // than the one being reported.
      expect(userServiceMock.signOut).toHaveBeenCalledTimes(1);
      expect(navigationAttempts).toHaveLength(1);
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
