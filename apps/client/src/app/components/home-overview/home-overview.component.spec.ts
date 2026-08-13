import { DashboardIntentService } from '@ghostfolio/client/core/dashboard-intent.service';
import { LayoutService } from '@ghostfolio/client/core/layout.service';
import { ImpersonationStorageService } from '@ghostfolio/client/services/impersonation-storage.service';
import { UserService } from '@ghostfolio/client/services/user/user.service';
import { DashboardModuleType } from '@ghostfolio/common/dashboard';
import { permissions } from '@ghostfolio/common/permissions';
import { DataService } from '@ghostfolio/ui/services';

import { CommonModule } from '@angular/common';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { DeviceDetectorService } from 'ngx-device-detector';
import { BehaviorSubject, Subject, of } from 'rxjs';

import { GfHomeOverviewComponent } from './home-overview.component';

/**
 * The three cross-module destinations this component offers.
 *
 * Each of these buttons publishes a reveal-module intent on a neutral bus, and two
 * things about that are worth pinning down.
 *
 * The first is the discriminator. An intent carrying the wrong module type still
 * compiles, still publishes and still surfaces *a* module, so nothing fails - the
 * viewer simply lands somewhere unintended. The mapping is therefore asserted per
 * handler.
 *
 * The second is that the handlers are actually reachable. These buttons are the
 * onboarding path for a brand new account, and a handler nobody calls is inert
 * without anything failing. So the buttons are found in the rendered template and
 * clicked for real rather than being invoked as methods. Child components are
 * stripped - the component already declares `CUSTOM_ELEMENTS_SCHEMA`, so their
 * unrecognised elements are tolerated - which keeps the charts and their canvas
 * dependencies out of a test about intents.
 */
describe('GfHomeOverviewComponent', () => {
  let dataServiceMock: { fetchPortfolioPerformance: jest.Mock };
  let fixture: ComponentFixture<GfHomeOverviewComponent>;

  /** Every intent the component published, in order. */
  let revealedModules: DashboardModuleType[];

  let stateChanged: BehaviorSubject<{ user: unknown } | null>;

  const createViewer = ({
    accountCount = 1,
    activitiesCount = 0
  }: { accountCount?: number; activitiesCount?: number } = {}) => {
    return {
      accounts: Array.from({ length: accountCount }, (_unused, index) => ({
        id: `account-${index}`
      })),
      activitiesCount,
      permissions: [permissions.createActivity],
      settings: { baseCurrency: 'CHF', locale: 'en-GB' }
    };
  };

  const createComponent = async (viewer: unknown = createViewer()) => {
    revealedModules = [];
    stateChanged = new BehaviorSubject<{ user: unknown } | null>({
      user: viewer
    });

    dataServiceMock = {
      fetchPortfolioPerformance: jest.fn(() =>
        of({ chart: [], errors: [], performance: {} })
      )
    };

    const dashboardIntentService = new DashboardIntentService();

    dashboardIntentService.revealModule$.subscribe((moduleType) => {
      revealedModules.push(moduleType);
    });

    await TestBed.configureTestingModule({
      imports: [GfHomeOverviewComponent],
      providers: [
        { provide: DashboardIntentService, useValue: dashboardIntentService },
        { provide: DataService, useValue: dataServiceMock },
        {
          provide: DeviceDetectorService,
          useValue: { getDeviceInfo: () => ({ deviceType: 'desktop' }) }
        },
        {
          provide: ImpersonationStorageService,
          useValue: { onChangeHasImpersonation: () => of(null) }
        },
        {
          provide: LayoutService,
          useValue: { shouldReloadContent$: new Subject<void>() }
        },
        { provide: UserService, useValue: { stateChanged } }
      ]
    })
      // The charts and the performance panel are irrelevant to an intent, and
      // rendering them would drag a canvas implementation into jsdom. `CommonModule`
      // is kept because the onboarding list items bind `ngClass`, and stripping it
      // makes that an unknown property on a plain `<li>` - which
      // `CUSTOM_ELEMENTS_SCHEMA` does not excuse for a standard element, so every
      // render would report NG0303.
      .overrideComponent(GfHomeOverviewComponent, {
        set: { imports: [CommonModule] }
      })
      .compileComponents();

    fixture = TestBed.createComponent(GfHomeOverviewComponent);

    fixture.detectChanges();

    return fixture.componentInstance;
  };

  /**
   * The single primary call to action rendered beneath the onboarding list.
   * Reached by its direct parent, because the component's root container also
   * carries `d-flex` and a bare descendant selector reaches the list instead.
   */
  const primaryButton = (): HTMLButtonElement => {
    return (fixture.nativeElement as HTMLElement).querySelector(
      '.introduction > .d-flex button'
    );
  };

  /** The onboarding button whose label starts with the given text. */
  const onboardingButton = (label: string) => {
    const buttons: HTMLButtonElement[] = Array.from(
      (fixture.nativeElement as HTMLElement).querySelectorAll('ol button')
    );

    return buttons.find((button) =>
      button.textContent.trim().startsWith(label)
    );
  };

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('the onboarding intents', () => {
    it.each([
      {
        expected: DashboardModuleType.ACCOUNTS,
        label: 'Setup your accounts'
      },
      {
        expected: DashboardModuleType.ACTIVITIES,
        label: 'Capture your activities'
      },
      {
        expected: DashboardModuleType.PORTFOLIO_ANALYSIS,
        label: 'Monitor and analyze your portfolio'
      }
    ])('reveals $expected from "$label"', async ({ expected, label }) => {
      await createComponent();

      const button = onboardingButton(label);

      // Asserted before the click, so a renamed or removed button reports itself
      // as a missing button rather than as a missing intent.
      expect(button).toBeDefined();

      button.click();

      expect(revealedModules).toEqual([expected]);
    });

    it('publishes nothing until the viewer acts', async () => {
      await createComponent();

      expect(revealedModules).toEqual([]);
    });

    it('publishes one intent per activation rather than accumulating', async () => {
      await createComponent();

      onboardingButton('Setup your accounts').click();
      onboardingButton('Capture your activities').click();
      onboardingButton('Setup your accounts').click();

      expect(revealedModules).toEqual([
        DashboardModuleType.ACCOUNTS,
        DashboardModuleType.ACTIVITIES,
        DashboardModuleType.ACCOUNTS
      ]);
    });
  });

  describe('the primary call to action', () => {
    it('sets up accounts while the viewer has only one', async () => {
      await createComponent(createViewer({ accountCount: 1 }));

      const button = primaryButton();

      expect(button.textContent.trim()).toBe('Setup accounts');

      button.click();

      expect(revealedModules).toEqual([DashboardModuleType.ACCOUNTS]);
    });

    it('moves on to activities once more than one account exists', async () => {
      await createComponent(createViewer({ accountCount: 2 }));

      const button = primaryButton();

      expect(button.textContent.trim()).toBe('Add activity');

      button.click();

      expect(revealedModules).toEqual([DashboardModuleType.ACTIVITIES]);
    });
  });

  describe('route independence', () => {
    it('needs no router at all', async () => {
      // No `Router` is provided anywhere in this suite, so the component would
      // fail to construct if it still held one. That is the assertion: revealing
      // a module is not a navigation, and this component performs none.
      await expect(createComponent()).resolves.toBeInstanceOf(
        GfHomeOverviewComponent
      );
    });
  });
});
