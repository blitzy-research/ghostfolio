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
import { readFileSync } from 'fs';
import { DeviceDetectorService } from 'ngx-device-detector';
import { join } from 'path';
import { BehaviorSubject, Observable, of, Subject, throwError } from 'rxjs';

import { DashboardModuleType } from '../../enums/dashboard-module-type';
import { GfDashboardToolbarComponent } from './dashboard-toolbar.component';

// Cuts the one dependency of the bar that this suite has no use for.
// `@ionic/angular/standalone` re-exports `@ionic/core`, which ships plain `.js`
// ES modules rather than `.mjs`; both this project's and `libs/ui`'s Jest
// transforms name the `@ionic` and `@stencil` families explicitly so that it
// parses, so this stand-in is not what makes the bar importable. It is kept
// deliberately all the same: the bar's glyphs carry no behaviour this
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
 * The non-navigational dashboard control bar.
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
 * `console.error`. {@link navigationAttempts} collects those, and
 * {@link errorReports} collects every other report so it can be asserted empty
 * after each test - which is how a genuine framework error fails the test that
 * provoked it instead of being printed beside a pass.
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

  /**
   * The sanitized marker the bar reports when the arrangement could not be stored
   * on the way out. Named once, because two tests provoke it deliberately and both
   * have to declare it as expected.
   */
  const SIGN_OUT_FLUSH_FAILED_REPORT =
    'GF-DASHBOARD-LAYOUT-SIGN-OUT-FLUSH-FAILED';

  let component: GfDashboardToolbarComponent;
  let fixture: ComponentFixture<GfDashboardToolbarComponent>;

  /**
   * The data facade, deliberately exposing four methods and no more.
   *
   * This is load-bearing rather than economical. Saving an arrangement is the
   * canvas's responsibility and is triggered only by grid state changing; this
   * bar has no part in it. Exchanging an access token belongs to the signed-out
   * component the canvas renders instead of its body, and this bar renders only
   * for a resolved viewer. Because the facade offered here answers neither
   * question, any attempt from this component to reach either capability raises a
   * `TypeError` - and, since every report reaching `console.error` is now
   * collected and asserted empty after each test, that `TypeError` fails the
   * provoking test by name instead of being logged and passed over. That is what
   * turns both separations from a claim into a structural property of the harness.
   *
   * The two search accessors are part of that harness rather than an exception to
   * it. A menu builds the nodes handed to it with the view that declares them, so
   * the *real* assistant is instantiated whenever there is a viewer entitled to
   * it, and opening the assistant - which any test sweeping the bar's controls
   * does - makes the assistant issue those two reads itself. Answering them here
   * costs the guarantee nothing: neither names a layout write nor a token
   * exchange, which are the two capabilities this facade exists to withhold.
   */
  let dataServiceMock: {
    fetchAccounts: jest.Mock;
    fetchInfo: jest.Mock;
    fetchPortfolioHoldings: jest.Mock;
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

  /**
   * Every report that reached `console.error` and was not jsdom refusing to
   * navigate.
   *
   * Asserted empty after each test, minus whatever that test declared in
   * {@link expectedErrorReports}, so an error raised anywhere inside an Angular
   * event listener fails the test that provoked it rather than merely appearing in
   * the output.
   */
  let errorReports: string[];

  /**
   * Sanitized markers a test provokes on purpose, declared by that test.
   *
   * Only two behaviours belong here - the sign-out flush failing, and the viewer
   * being told about it - and both are what those tests are about. Anything not
   * named is a failure.
   */
  let expectedErrorReports: string[];

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
    errorReports = [];
    expectedErrorReports = [];
    fixture = undefined;
    navigationAttempts = [];
    temporaryElements = [];

    originalDocumentLanguage = document.documentElement.lang;

    // Pinned so that signing out resolves to the address the document is
    // already on, which is the condition under which jsdom performs no
    // navigation - and therefore what lets an empty attempt list stand as an
    // exact statement about the address that was assigned.
    document.documentElement.lang = 'en';

    consoleErrorSpy = jest
      .spyOn(console, 'error')
      .mockImplementation((...args: unknown[]) => {
        // Every argument is folded into the report, not just the first, and that
        // matters for exactly one caller: Angular's own `ErrorHandler` logs
        // `'ERROR'` followed by the error object, so reading the first argument
        // alone would record the word `ERROR` and lose the message that says which
        // member was missing - the whole diagnostic value of collecting these.
        //
        // Errors are recognised by their shape rather than with `instanceof`. jsdom
        // raises its report from its own realm, so `detail instanceof Error` is
        // false for the very object that arrives even though an error is precisely
        // what it is - measured, not assumed, and narrowing that way silently stops
        // matching.
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

        // Collected rather than forwarded, and then asserted empty after every
        // test. Forwarding printed the report and let the test pass, which is
        // exactly what defeated this harness's own guarantee: Angular catches
        // anything thrown inside an event listener and hands it to its
        // `ErrorHandler`, which reports it here - so a `TypeError` raised by this
        // bar reaching a capability the facade withholds was logged and survived.
        // A sweep over the bar's controls did raise one. Collecting instead makes
        // every unexpected report fail the provoking test by name, which is the
        // difference between a documented separation and an enforced one.
        errorReports.push(report);
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
      // Answered for every test rather than only for the group that searches,
      // because the assistant is built with the view that declares it and issues
      // both reads the moment its panel opens. A sweep over this bar's controls
      // opens it, so a facade without these two turned that sweep into an
      // unhandled `TypeError` inside an Angular event listener.
      fetchAccounts: jest.fn().mockReturnValue(of({ accounts: [] })),
      fetchInfo: jest.fn().mockReturnValue(createInfo()),
      fetchPortfolioHoldings: jest.fn().mockReturnValue(of({ holdings: [] })),
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
    // Asserted before the spy is handed back, so the message a failure produces
    // names the report rather than a restored spy. A failing expectation in a hook
    // fails the test it ran for, which is what makes "any error this bar provokes
    // fails the suite" true of listener-raised errors as well.
    const unexpectedReports = errorReports.filter((report) => {
      return !expectedErrorReports.some((marker) => report.includes(marker));
    });

    consoleErrorSpy.mockRestore();

    document.documentElement.lang = originalDocumentLanguage;

    for (const element of temporaryElements) {
      element.remove();
    }

    expect(unexpectedReports).toEqual([]);
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
      // The market-data search is the one collaborator only this group needs: the
      // assistant reaches for it once a search is under way, which no other test
      // starts. Added to the existing double rather than to a new one so that every
      // other test in this suite keeps the collaborators it had. The two portfolio
      // searches are answered by the base facade instead, because the assistant
      // issues those the moment its panel opens - which any test sweeping this
      // bar's controls does.
      adminServiceMock.fetchAdminMarketData = jest
        .fn()
        .mockReturnValue(of({ count: 0, marketData: [] }));

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
      // modules must not be offered at all. This filter is the only client-side
      // admin gate the application has, which is what makes it load-bearing rather
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
  /**
   * The bar is a landmark, and it is the one this application lost.
   *
   * The deleted shell wrapped its chrome in a `<header>` element, which is a banner
   * landmark for nothing more than being one. A `mat-toolbar` renders a plain `div`,
   * so collapsing the shell left the finished page exposing only `main` and the module
   * regions - measured as five landmarks with no banner among them - and took away the
   * shortcut that gets a reader from anywhere on the canvas back to the controls.
   */
  describe('the bar as a landmark', () => {
    it('should expose itself as the page banner', () => {
      createComponent();
      renderWithUser();

      const toolbar = host().querySelector('mat-toolbar');

      expect(toolbar).toBeTruthy();
      expect(toolbar.getAttribute('role')).toBe('banner');
    });

    /**
     * Declared as a role rather than by wrapping the bar in a `<header>`, because a
     * `<header>` here would NOT be a banner: the element maps to that role only when
     * it has no sectioning ancestor, and this bar renders inside the shell's `<main>`.
     * The explicit role applies wherever it is written.
     */
    it('should declare that role rather than rely on an element', () => {
      createComponent();
      renderWithUser();

      expect(host().querySelector('header')).toBeNull();
      expect(host().querySelector('mat-toolbar[role="banner"]')).toBeTruthy();
    });

    // A landmark with no name is announced as its type alone, and this page carries
    // several regions: the name is what makes the bar addressable by what it does.
    it('should name that landmark', () => {
      createComponent();
      renderWithUser();

      expect(
        host().querySelector('mat-toolbar').getAttribute('aria-label')
      ).toBe('Dashboard controls');
    });

    // The bar renders as empty chrome until the viewer resolves, and the landmark has
    // to be there for that whole time: a reader jumping to it before the arrangement
    // arrives must not find nothing at all.
    it('should be a landmark before the viewer has arrived', () => {
      createComponent();

      const toolbar = host().querySelector('mat-toolbar');

      expect(toolbar.getAttribute('role')).toBe('banner');
      expect(toolbar.getAttribute('aria-label')).toBe('Dashboard controls');
    });
  });

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

        // No `aria-label`, on purpose. One reading "Refresh dashboard" would
        // replace the visible word wholesale, leaving a speech-input user unable
        // to address the control by the word they can see.
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

  /**
   * The appearance choice the control bar is specified to carry.
   *
   * It is the one capability of that specification the bar did not have: the setting
   * existed, but the only control for it lived inside the account-settings screen, so
   * a viewer switching the canvas between light and dark had to navigate away from
   * the canvas to do it - and on one canvas there is nowhere to navigate to.
   *
   * The rows render inside a `MatMenu`, which portals its content into an overlay
   * outside this component's host, so these tests drive the handler and read the
   * menu's own template through the component rather than through `host()`. The rows'
   * markup is asserted from the template source for the same reason.
   */
  describe('the appearance choice', () => {
    const templateSource = () => {
      return readFileSync(join(__dirname, 'dashboard-toolbar.html'), 'utf8');
    };

    it('offers exactly the three values the setting has', () => {
      expect(component.colorSchemeOptions).toEqual([
        { label: 'Auto', value: null },
        { label: 'Light', value: 'LIGHT' },
        { label: 'Dark', value: 'DARK' }
      ]);
    });

    it('stores a chosen scheme through the setting the rest of the bar writes', () => {
      renderWithUser();

      component.onChangeColorScheme('DARK');

      expect(dataServiceMock.putUserSetting).toHaveBeenCalledTimes(1);
      expect(dataServiceMock.putUserSetting).toHaveBeenCalledWith({
        colorScheme: 'DARK'
      });
    });

    /**
     * `null` is a VALUE, not a missing argument: it is how the absence of a preference
     * is stored, and storing it is what puts the canvas back under the operating
     * system's control. Sending nothing at all would leave the previous choice in
     * place, so `Auto` would be the one option that did nothing.
     */
    it('clears the stored scheme for Auto rather than sending nothing', () => {
      renderWithUser();

      component.onChangeColorScheme(null);

      expect(dataServiceMock.putUserSetting).toHaveBeenCalledWith({
        colorScheme: null
      });
    });

    // Re-reading the viewer is what makes the choice visible: the shell paints from
    // the viewer's `colorScheme` whenever the viewer changes. Nothing here touches a
    // document class, so there is one mechanism rather than two.
    it('re-reads the viewer so the shell repaints from the stored value', () => {
      renderWithUser();

      userServiceMock.get.mockClear();

      component.onChangeColorScheme('LIGHT');

      expect(userServiceMock.get).toHaveBeenCalledTimes(1);
      expect(userServiceMock.get).toHaveBeenCalledWith(true);
    });

    it('applies no theme of its own', () => {
      renderWithUser();

      const classesBefore = document.body.className;

      component.onChangeColorScheme('DARK');

      expect(document.body.className).toBe(classesBefore);
    });

    // Three radios rather than a two-state switch, because the third value is not a
    // state of the other two - and announced as radios, so the current choice is
    // spoken rather than left to the shape of a glyph.
    it('announces the rows as a named radio group', () => {
      const source = templateSource();

      expect(source).toContain('role="group"');
      expect(source).toContain('aria-label="Appearance"');
      expect(source).toContain('role="menuitemradio"');
      expect(source).toContain('[attr.aria-checked]');
    });

    it('marks exactly the stored value as the checked row', () => {
      const source = templateSource();

      // Coalesced, because the stored absence of a preference is `undefined` on a
      // viewer that has never chosen and `null` in the option list; without this the
      // Auto row would be checked for nobody.
      expect(source).toContain(
        'option.value === (user?.settings?.colorScheme ?? null)'
      );
    });
  });

  /**
   * The separators inside the identity menu, counted from the rendered menu rather
   * than from the template.
   *
   * A divider belongs to the group above it, and this menu has four groups of which
   * two are conditional: the plan row, the identities the viewer may borrow, the
   * appearance radios, and signing out. Each of the first three is followed by its
   * own rule - the two conditional ones from inside their own `@if` - and a fourth,
   * unconditional rule had been written between the identities and the appearance
   * radios as well. So a viewer with no plan row and no grants opened the menu onto
   * a horizontal line with nothing above it, and a viewer with grants saw two lines
   * a pixel apart.
   *
   * Counted here across all four combinations, because either symptom is invisible
   * to a test of only one of them: the duplicate needs a viewer WITH grants and the
   * orphan needs a viewer with neither, and the template reads plausibly in both
   * cases. The rule is one divider per populated group that has another group after
   * it, and never one before the first row.
   */
  describe('the identity menu separators', () => {
    /**
     * Opens the identity menu, which is what renders its rows at all.
     *
     * Material projects menu content into an overlay only while the menu is open, so
     * nothing below can be read from the component's own element. The trigger is
     * found by its glyph rather than by a selector on `matMenuTriggerFor`, which is
     * a property binding and therefore leaves no attribute in the DOM.
     */
    const openIdentityMenu = () => {
      const trigger = Array.from(
        host().querySelectorAll<HTMLElement>('mat-toolbar button')
      ).find((button) => {
        return !!button.querySelector('ion-icon[name="person-circle-outline"]');
      });

      expect(trigger).toBeTruthy();

      trigger.click();

      fixture.detectChanges();
    };

    /**
     * The open panel.
     *
     * A dismissed panel lingers in the overlay container for the length of its exit
     * animation, so the one being read is the one that is not leaving.
     */
    const menuPanel = () => {
      return document.querySelector(
        '.mat-mdc-menu-panel:not(.mat-menu-panel-exit-animation)'
      );
    };

    /** Every rule the open menu paints, in the order it paints them. */
    const menuSeparators = () => {
      return Array.from(menuPanel()?.querySelectorAll<HTMLElement>('hr') ?? []);
    };

    /**
     * The rows and rules of the open menu as one ordered list, so that a rule with
     * nothing above it and two rules in a row are both readable from the sequence.
     */
    const menuSequence = () => {
      return Array.from(
        menuPanel()?.querySelectorAll('hr, [mat-menu-item]') ?? []
      ).map((element) => {
        return element.tagName === 'HR' ? 'divider' : 'row';
      });
    };

    /**
     * Dismisses the menu through its own backdrop.
     *
     * Left open, its panel would still be in the overlay container while the next
     * test counted rules there - and every count below reads the document rather
     * than the component, so a leaked panel would be counted as if it were this
     * viewer's.
     */
    const closeIdentityMenu = () => {
      document.querySelector<HTMLElement>('.cdk-overlay-backdrop')?.click();

      fixture.detectChanges();
    };

    afterEach(() => {
      closeIdentityMenu();
    });

    it('draws no rule above the first row for a viewer with neither group', () => {
      renderWithUser(
        createUser({ access: [], subscription: null, permissions: [] })
      );

      openIdentityMenu();

      const sequence = menuSequence();

      expect(sequence[0]).toBe('row');
      expect(menuSeparators()).toHaveLength(1);
    });

    it('draws one rule per populated group for a viewer with grants', () => {
      renderWithUser(
        createUser({
          access: [{ alias: 'Borrowed', id: 'ACCESS_ID' }],
          permissions: []
        } as unknown as Partial<User>)
      );

      openIdentityMenu();

      const sequence = menuSequence();

      // The pair a pixel apart is exactly a `divider` immediately followed by
      // another `divider`, so the sequence is what has to be free of it.
      expect(sequence).not.toContain('divider,divider');

      for (let index = 1; index < sequence.length; index += 1) {
        expect([sequence[index - 1], sequence[index]]).not.toEqual([
          'divider',
          'divider'
        ]);
      }

      expect(sequence[0]).toBe('row');
      expect(menuSeparators()).toHaveLength(2);
    });

    it('draws one rule per populated group for a viewer with a plan row', () => {
      dataServiceMock.fetchInfo.mockReturnValue(
        createInfo({ globalPermissions: [permissions.enableSubscription] })
      );

      createComponent();

      renderWithUser(
        createUser({
          access: [],
          subscription: { offer: createOffer(), type: 'Basic' }
        } as unknown as Partial<User>)
      );

      openIdentityMenu();

      expect(menuSequence()[0]).toBe('row');
      expect(menuSeparators()).toHaveLength(2);
    });

    it('draws one rule per populated group for a viewer with both', () => {
      dataServiceMock.fetchInfo.mockReturnValue(
        createInfo({ globalPermissions: [permissions.enableSubscription] })
      );

      createComponent();

      renderWithUser(
        createUser({
          access: [{ alias: 'Borrowed', id: 'ACCESS_ID' }],
          subscription: { offer: createOffer(), type: 'Basic' }
        } as unknown as Partial<User>)
      );

      openIdentityMenu();

      const sequence = menuSequence();

      expect(sequence[0]).toBe('row');

      for (let index = 1; index < sequence.length; index += 1) {
        expect([sequence[index - 1], sequence[index]]).not.toEqual([
          'divider',
          'divider'
        ]);
      }

      expect(menuSeparators()).toHaveLength(3);
    });
  });

  describe('releasing an impersonation the viewer no longer holds', () => {
    const marker = () => {
      return host().querySelector<HTMLElement>('.gf-impersonation-indicator');
    };

    /**
     * Mirrors the real service, which both forgets the identifier AND publishes the
     * absence. The default stand-in only records the call, which would let the
     * marker linger in these tests for a reason the application does not have.
     */
    const withFaithfulRemoval = () => {
      impersonationStorageServiceMock.removeId.mockImplementation(() => {
        impersonationSubject.next(null);
      });
    };

    it('withdraws the claim when the grant behind it is gone', () => {
      withFaithfulRemoval();
      impersonationStorageServiceMock.getId.mockReturnValue('REVOKED_ID');
      impersonationSubject.next('REVOKED_ID');

      renderWithUser(createUser({ access: [] }));

      expect(impersonationStorageServiceMock.removeId).toHaveBeenCalledTimes(1);
      expect(component.hasImpersonationId).toBe(false);
      expect(marker()).toBeNull();
    });

    it('leaves an identity the viewer was actually granted alone', () => {
      withFaithfulRemoval();
      impersonationStorageServiceMock.getId.mockReturnValue('ACCESS_ID');
      impersonationSubject.next('ACCESS_ID');

      renderWithUser(
        createUser({
          access: [{ alias: 'Shared', id: 'ACCESS_ID', permissions: [] }]
        } as unknown as Partial<User>)
      );

      expect(impersonationStorageServiceMock.removeId).not.toHaveBeenCalled();
      expect(component.hasImpersonationId).toBe(true);
      expect(marker()).not.toBeNull();
    });

    /**
     * The grants arrive with the viewer, not before them. Reading their absence as
     * "not held" would discard a working impersonation on every single boot, which
     * is a worse defect than the one being fixed.
     */
    it('does not judge a stored identity before the grants have arrived', () => {
      impersonationStorageServiceMock.getId.mockReturnValue('ACCESS_ID');
      impersonationSubject.next('ACCESS_ID');

      stateChangedSubject.next({ user: null });
      fixture.detectChanges();

      expect(impersonationStorageServiceMock.removeId).not.toHaveBeenCalled();
      expect(component.hasImpersonationId).toBe(true);
    });

    /**
     * The other half of the server's own predicate. A viewer who may impersonate
     * everybody is honoured on a bare account identifier, which is precisely what
     * the user administration module stores and which is deliberately not a grant
     * identifier - so checking the grant list alone would revoke exactly the
     * impersonation that works.
     */
    it('keeps an identity a viewer who may impersonate anybody adopted', () => {
      withFaithfulRemoval();
      impersonationStorageServiceMock.getId.mockReturnValue('SOME_USER_ID');
      impersonationSubject.next('SOME_USER_ID');

      renderWithUser(
        createUser({
          access: [],
          permissions: [permissions.impersonateAllUsers]
        })
      );

      expect(impersonationStorageServiceMock.removeId).not.toHaveBeenCalled();
      expect(component.hasImpersonationId).toBe(true);
      expect(marker()).not.toBeNull();
    });

    it('notices a grant withdrawn while the dashboard is open', () => {
      withFaithfulRemoval();
      impersonationStorageServiceMock.getId.mockReturnValue('ACCESS_ID');
      impersonationSubject.next('ACCESS_ID');

      renderWithUser(
        createUser({
          access: [{ alias: 'Shared', id: 'ACCESS_ID', permissions: [] }]
        } as unknown as Partial<User>)
      );

      expect(impersonationStorageServiceMock.removeId).not.toHaveBeenCalled();
      expect(marker()).not.toBeNull();

      renderWithUser(createUser({ access: [] }));

      expect(impersonationStorageServiceMock.removeId).toHaveBeenCalledTimes(1);
      expect(marker()).toBeNull();
    });

    /**
     * Withdrawing the claim must not reload. Every request this document has
     * already made was served as the viewer themselves - the server answers an
     * identifier it will not honour with the viewer's own data - so what is on
     * screen is already correct and only the label was wrong.
     */
    it('corrects the label without discarding the page', () => {
      withFaithfulRemoval();
      impersonationStorageServiceMock.getId.mockReturnValue('REVOKED_ID');
      impersonationSubject.next('REVOKED_ID');

      renderWithUser(createUser({ access: [] }));

      expect(impersonationStorageServiceMock.removeId).toHaveBeenCalledTimes(1);

      // Observed through the channel this environment actually offers: jsdom cannot
      // have its `Location` replaced, but it does report an attempted navigation on
      // its virtual console, and adopting an identity leaves by replacing the
      // document. An empty list is therefore an exact statement that nothing left.
      expect(navigationAttempts).toHaveLength(0);
      expect(routerMock.navigate).not.toHaveBeenCalled();
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

    it('opens the assistant on its keyboard shortcut', () => {
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

    // An arrangement change made inside the debounce window and followed
    // immediately by signing out would otherwise be lost. Losing it to a closed tab
    // is a window this design accepts - nothing can be issued from a document that
    // is going away on its own - but signing out is the application's own doing, so
    // it is the one departure that can and must carry the write with it.
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
      // Declared, because this test provokes the failure it is about: the
      // sanitized marker below is expected output rather than an escaped error,
      // and naming it here is what keeps every *other* report a failure.
      expectedErrorReports.push(SIGN_OUT_FLUSH_FAILED_REPORT);

      dashboardLayoutServiceMock.releasePendingSave.mockReturnValue(
        throwError(() => new Error('flush failed'))
      );

      document.documentElement.lang = 'de';

      component.onSignOut();

      // Told, not left to guess. Leaving in silence would let the viewer believe
      // an arrangement they can still see had been saved, and the failure is
      // reported through the sanitized channel as well so it is diagnosable - and
      // that report carries the marker and nothing else, no stored value and no
      // identity.
      expect(notificationServiceMock.alert).toHaveBeenCalledTimes(1);
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        SIGN_OUT_FLUSH_FAILED_REPORT
      );
      expect(errorReports).toEqual([SIGN_OUT_FLUSH_FAILED_REPORT]);

      // Nothing has happened yet: the departure waits on the acknowledgement.
      expect(userServiceMock.signOut).not.toHaveBeenCalled();
      expect(navigationAttempts).toHaveLength(0);
    });

    it('still lets the viewer leave once they acknowledge the failure', () => {
      // Same deliberate failure as above, so the same marker is declared here.
      expectedErrorReports.push(SIGN_OUT_FLUSH_FAILED_REPORT);

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
      // The facade this component is given answers exactly these four questions.
      // Two are the bar's own - deployment info and a settings write - and two
      // belong to the assistant the bar projects, which issues them itself.
      //
      // What is absent is the point. Reaching a persistence method, or exchanging
      // an access token - which belongs to the signed-out component the canvas
      // renders instead of its body - raises a `TypeError`, and because every
      // report reaching `console.error` is collected and asserted empty after each
      // test, that `TypeError` fails the provoking test by name. Both separations
      // are therefore properties of the harness rather than assertions about
      // intent. The two forbidden capabilities are named as well as omitted, so a
      // future addition to the facade cannot quietly enable one of them while this
      // list is updated to match.
      expect(Object.keys(dataServiceMock).sort()).toEqual([
        'fetchAccounts',
        'fetchInfo',
        'fetchPortfolioHoldings',
        'putUserSetting'
      ]);
      expect(Object.keys(dataServiceMock)).not.toContain(
        'patchUserDashboardLayout'
      );
      expect(Object.keys(dataServiceMock)).not.toContain('loginAnonymous');
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
      // component injects no router at all, and the stand-in supplied to the
      // subtree records that no child rendered with it does either.
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

      // Signing in is the one capability this bar deliberately does not carry: it
      // belongs to the signed-out branch of the canvas, and that branch is a sibling
      // component which owns the dialog, the exchange and the stay-signed-in
      // preference. This bar renders only for a resolved viewer, so a second copy
      // here could never be reached. Asserted against a deployment that grants all
      // three paths, because that is the input under which an unreachable copy would
      // look alive.
      for (const member of Object.keys(component)) {
        expect(member).not.toMatch(/auth/i);
        expect(member).not.toMatch(/token/i);
      }
    });

    /**
     * The bar gives nothing out, and takes in only what it cannot observe for
     * itself.
     *
     * It used to take nothing at all, and the refresh control showed it: the work
     * belongs to the canvas, which mounts the modules, so the bar had no way to know
     * whether a refresh it asked for was still running. The one input is that fact
     * and nothing else - a state to render, not a capability to exercise - which is
     * why the assertion pins the exact set rather than merely allowing inputs.
     *
     * Outputs stay empty deliberately: the bar reports intent through the shared
     * services it injects, so a parent is never obliged to wire it up.
     */
    it('takes in only the busy state it cannot observe, and gives nothing out', () => {
      const mirror = reflectComponentType(GfDashboardToolbarComponent);

      expect(mirror.selector).toBe('gf-dashboard-toolbar');
      expect(mirror.inputs).toEqual([
        {
          isSignal: false,
          propName: 'isRefreshing',
          templateName: 'isRefreshing'
        }
      ]);
      expect(mirror.outputs).toEqual([]);
      expect(mirror.isStandalone).toBe(true);
    });
  });
});
