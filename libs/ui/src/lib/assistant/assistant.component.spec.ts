import {
  DashboardModule,
  DashboardModuleType,
  dashboardModules
} from '@ghostfolio/common/dashboard';
import { User } from '@ghostfolio/common/interfaces';
import { permissions } from '@ghostfolio/common/permissions';
import { AdminService, DataService } from '@ghostfolio/ui/services';

import { Component } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { provideRouter } from '@angular/router';
import { of } from 'rxjs';

import { GfAssistantComponent } from './assistant.component';
import { SearchMode } from './enums/search-mode';
import {
  QuickLinkSearchResultItem,
  SearchResultItem
} from './interfaces/interfaces';

/**
 * The assistant's public result contract, asserted from inside the library that owns
 * it.
 *
 * An activated search result names a module rather than an address: it carries a
 * `moduleType` drawn from the shared dashboard module vocabulary, and the consumer
 * surfaces that module instead of navigating to a `routerLink`. That contract spans
 * a library boundary and can regress silently, because this library cannot import
 * the application that hosts the modules - so nothing in the compiler relates what
 * is emitted here to what the consumer resolves. The consumer's own suite additionally stands the assistant in
 * for a hand-written double, which is the right call for testing the consumer and
 * the reason the producer needs a guard of its own.
 *
 * Three properties are therefore pinned here, and each of them can break without any
 * other test noticing:
 *
 * 1. **A result names a module, never an address.** No result kind may reintroduce a
 *    `routerLink`, and the quick link - the one genuinely navigational kind - must
 *    carry a discriminator instead.
 * 2. **Every discriminator is one the shared vocabulary declares.** An emitted value
 *    outside `DashboardModuleType` resolves to nothing in the registry, so the row
 *    would look live and do nothing when activated.
 * 3. **Gated modules are filtered by the viewer's own permissions.** This filter is
 *    part of what keeps administration out of an unentitled viewer's reach, there
 *    being no navigation chrome to gate it instead. The gated cases are derived from
 *    the shared map rather than listed, so a module gated later is covered without
 *    this file being touched.
 *
 * The component is driven through its real search pipeline - `setValue` on the search
 * control, the real 300 ms debounce, the real `fuse.js` index over the real shared
 * metadata - because the mapping under test lives at the end of that pipeline. Only
 * the two data services are doubled. Outputs are observed through a host component
 * that binds them by name rather than by reading the instance, so the binding the
 * consumer writes is the binding under test; an output that was renamed would fail
 * to compile here rather than quietly stop firing.
 */
describe('GfAssistantComponent', () => {
  /** The real debounce window in the component's own search pipeline. */
  const SEARCH_DEBOUNCE = 300;

  /** The real preselection delay, so the settled DOM is what gets asserted. */
  const PRESELECTION_DELAY = 100;

  /** Angular's advisory that a `@for` block tracks its items by identity. */
  const TRACK_BY_IDENTITY_ADVISORY = 'NG0956';

  /**
   * Every module the shared map gates behind a permission, taken from the map itself.
   * Listing them instead would leave a module gated tomorrow untested today.
   */
  // Narrowed by a type predicate rather than by a cast at each use: the shared
  // metadata declares `permission` optional because most modules carry none, and
  // this list is by definition the subset that does.
  const gatedModules = Object.values<DashboardModule>(dashboardModules).filter(
    (module): module is DashboardModule & { permission: string } => {
      return !!module.permission;
    }
  );

  /**
   * Each display name once. Two modules are called `Markets` and two are called
   * `Settings`, and the search pipeline suppresses a term that has not changed, so a
   * loop over the raw names would settle on an empty result set for the repeat.
   */
  const uniqueModuleNames = [
    ...new Set(
      Object.values<DashboardModule>(dashboardModules).map(({ name }) => {
        return name;
      })
    )
  ];

  let assistant: GfAssistantComponent;
  let fixture: ComponentFixture<GfTestAssistantHostComponent>;
  let host: GfTestAssistantHostComponent;

  /**
   * Collected rather than silenced. Rendering real results makes Angular advise that
   * the template tracks its rows by identity, which it genuinely does - the search
   * pipeline builds fresh result objects on every pass - so the advisory is a property
   * of the production template, not of this suite. Recognising it and asserting that
   * nothing else was warned keeps that property documented and keeps the run's log
   * meaningful, which a blanket spy on `console.warn` would destroy.
   */
  let trackingAdvisories: string[];

  /** Anything warned that was not that advisory; asserted empty and forwarded. */
  let otherWarnings: unknown[][];

  let adminServiceMock: { fetchAdminMarketData: jest.Mock };
  let dataServiceMock: {
    fetchAccounts: jest.Mock;
    fetchPortfolioHoldings: jest.Mock;
  };

  const createUser = (user: Partial<User> = {}): User => {
    return {
      permissions: [],
      settings: { language: 'en' },
      ...user
    } as unknown as User;
  };

  const createHost = async ({
    hasPermissionToAccessAdminControl = false,
    user = createUser()
  }: {
    hasPermissionToAccessAdminControl?: boolean;
    // Nullable deliberately: "no viewer has resolved" is one of the states the
    // permission filter has to answer for, and it is expressed as a null viewer
    // exactly as the shell expresses it.
    user?: User | null;
  } = {}) => {
    // Discarded first so that a test which needs two viewers - the same search run
    // once entitled and once not - can build a second host instead of being split in
    // two and losing the comparison that is the point of it.
    TestBed.resetTestingModule();

    adminServiceMock = {
      fetchAdminMarketData: jest.fn(() => {
        return of({
          count: 1,
          marketData: [
            {
              assetSubClass: 'STOCK',
              currency: 'USD',
              dataSource: 'YAHOO',
              name: 'Alphabet Inc.',
              symbol: 'GOOG'
            }
          ]
        });
      })
    };

    dataServiceMock = {
      fetchAccounts: jest.fn(() => {
        return of({
          accounts: [{ id: 'an-account-id', name: 'Alpha Brokerage' }]
        });
      }),
      fetchPortfolioHoldings: jest.fn(() => {
        return of({
          holdings: [
            {
              assetSubClass: 'STOCK',
              currency: 'CHF',
              dataSource: 'YAHOO',
              name: 'Alcon Inc.',
              symbol: 'ALC.SW'
            }
          ]
        });
      })
    };

    await TestBed.configureTestingModule({
      imports: [GfTestAssistantHostComponent],
      providers: [
        { provide: AdminService, useValue: adminServiceMock },
        { provide: DataService, useValue: dataServiceMock },
        // The rows render a link directive, so the router has to be real enough to
        // resolve one. No route is declared, because a quick link deliberately
        // derives none - which is half of what this suite exists to prove.
        provideRouter([])
      ]
    }).compileComponents();

    fixture = TestBed.createComponent(GfTestAssistantHostComponent);
    host = fixture.componentInstance;

    host.hasPermissionToAccessAdminControl = hasPermissionToAccessAdminControl;
    host.user = user;

    fixture.detectChanges();

    assistant = fixture.debugElement.query(By.directive(GfAssistantComponent))
      .componentInstance as GfAssistantComponent;

    // The real entry point the consumer calls when its panel opens, rather than a
    // shortcut into the search control: it arms the key manager, clears the term and
    // loads the holdings the filter form offers.
    assistant.initialize();

    jest.advanceTimersByTime(PRESELECTION_DELAY);

    fixture.detectChanges();

    return assistant;
  };

  /** Runs a real search and settles both the debounce and the preselection. */
  const search = (searchTerm: string) => {
    assistant.searchFormControl.setValue(searchTerm);

    jest.advanceTimersByTime(SEARCH_DEBOUNCE);

    fixture.detectChanges();

    jest.advanceTimersByTime(PRESELECTION_DELAY);

    fixture.detectChanges();
  };

  /**
   * The rendered host element, asserted rather than inferred: `nativeElement` is typed
   * `any`, so every query made through it would be an unchecked call.
   */
  const hostElement = () => fixture.nativeElement as HTMLElement;

  /** The first rendered result row, which is what a viewer activates. */
  const firstRow = () => {
    return hostElement().querySelector<HTMLAnchorElement>(
      'gf-assistant-list-item a'
    );
  };

  const quickLinks = () => {
    return assistant.searchResults.quickLinks as QuickLinkSearchResultItem[];
  };

  const quickLinkModuleTypes = () => {
    return quickLinks().map(({ moduleType }) => {
      return moduleType;
    });
  };

  /** Every result of every kind, for assertions that must hold across all of them. */
  const allResults = (): SearchResultItem[] => {
    const {
      accounts,
      assetProfiles,
      holdings,
      quickLinks: links
    } = assistant.searchResults;

    return [...accounts, ...assetProfiles, ...holdings, ...links];
  };

  beforeEach(() => {
    trackingAdvisories = [];
    otherWarnings = [];

    // Asserted on the expression rather than on the binding, so the stored value is
    // typed too: `Function.prototype.bind` widens its result to `any`, which would make
    // every forwarded warning an unchecked call.
    const reportWarning = console.warn.bind(console) as (
      ...args: unknown[]
    ) => void;

    jest.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
      const [detail] = args;
      const report = typeof detail === 'string' ? detail : '';

      if (report.includes(TRACK_BY_IDENTITY_ADVISORY)) {
        trackingAdvisories.push(report);

        return;
      }

      otherWarnings.push(args);

      reportWarning(...args);
    });

    // Installed before the component exists: the search pipeline schedules its
    // debounce as the very first value arrives, and a timer created against the real
    // clock would never be advanced by the fake one.
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  describe('the quick link contract', () => {
    it('names a dashboard module rather than an in-application address', async () => {
      await createHost();

      search('Holdings');

      expect(quickLinks().length).toBeGreaterThan(0);

      for (const quickLink of quickLinks()) {
        expect(quickLink.mode).toBe(SearchMode.QUICK_LINK);
        expect(quickLink).toHaveProperty('moduleType');
        expect(quickLink).not.toHaveProperty('routerLink');
        expect(quickLink).not.toHaveProperty('queryParams');
      }
    });

    it('offers no result kind of any mode an in-application address', async () => {
      await createHost({ hasPermissionToAccessAdminControl: true });

      // A term that reaches all four searches at once, so the assertion covers the
      // account and asset-profile kinds - which do carry a discriminator - and the
      // holding kind, which deliberately carries none because the dialog it opens
      // belongs to the application shell rather than to a module.
      search('Al');

      expect(allResults().length).toBeGreaterThan(0);

      for (const result of allResults()) {
        expect(result).not.toHaveProperty('routerLink');
      }

      expect(
        assistant.searchResults.holdings.every((holding) => {
          return !('moduleType' in holding);
        })
      ).toBe(true);
    });

    it('emits only discriminators the shared module vocabulary declares', async () => {
      await createHost({
        hasPermissionToAccessAdminControl: true,
        user: createUser({
          permissions: [
            permissions.accessAdminControl,
            permissions.readAiPrompt,
            permissions.readMarketDataOfMarkets
          ]
        })
      });

      const declared = Object.values(DashboardModuleType);
      const seen = new Set<DashboardModuleType>();

      // Every module in the map is reached, one search per distinct display name, so
      // the assertion covers the whole vocabulary rather than whichever entries a
      // single fuzzy search happened to return.
      //
      // Distinct names, because the pipeline discards a term that has not changed:
      // the value change clears the previous results *before* the debounce, and the
      // repeated term is then suppressed downstream, so searching the same name twice
      // in a row would settle on nothing at all. Two modules share `Markets` and two
      // share `Settings`, and one search finds both members of each pair anyway.
      for (const name of uniqueModuleNames) {
        search(name);

        expect(quickLinks().length).toBeGreaterThan(0);

        for (const moduleType of quickLinkModuleTypes()) {
          expect(declared).toContain(moduleType);

          seen.add(moduleType);
        }
      }

      // Not merely "nothing undeclared was emitted", which an empty result set would
      // satisfy: every declared module was actually reachable through its own name.
      expect([...seen].sort()).toEqual([...declared].sort());
    });

    it('carries the shared display name unchanged alongside the discriminator', async () => {
      await createHost();

      search('Watchlist');

      const sharedModules: Record<DashboardModuleType, DashboardModule> =
        dashboardModules;

      // The name and the discriminator have to agree, because the row shows one and
      // the consumer resolves the other. A mapping that paired them up wrongly would
      // surface a module the viewer did not ask for.
      for (const { moduleType, name } of quickLinks()) {
        expect(name).toBe(sharedModules[moduleType].name);
      }
    });

    it('names the module whose display name matched', async () => {
      await createHost();

      search('Watchlist');

      expect(quickLinkModuleTypes()).toContain(DashboardModuleType.WATCHLIST);
    });

    it('matches display names and never discriminators', async () => {
      await createHost({
        user: createUser({
          permissions: [permissions.readMarketDataOfMarkets]
        })
      });

      // `portfolio` occurs in three discriminators - `portfolio-overview`,
      // `portfolio-summary`, `portfolio-analysis` - and in no display name, so a
      // match here would mean the index had been widened to the persisted vocabulary.
      // That would be a contract change in itself: discriminators are frozen once
      // shipped and are not translated, so searching them would behave differently in
      // every locale.
      search('portfolio');

      expect(quickLinks()).toEqual([]);

      // `premium` likewise occurs only in the `markets-premium` discriminator.
      search('premium');

      expect(quickLinks()).toEqual([]);
    });
  });

  describe('permission filtering', () => {
    // Derived from the shared map, so a module gated in a later change is covered by
    // this suite the moment it is gated.
    it.each(
      gatedModules.map(({ moduleType, name, permission }) => {
        return { moduleType, name, permission };
      })
    )(
      'withholds $moduleType from a viewer without $permission',
      async ({ moduleType, name }) => {
        await createHost();

        search(name);

        expect(quickLinkModuleTypes()).not.toContain(moduleType);
      }
    );

    it.each(
      gatedModules.map(({ moduleType, name, permission }) => {
        return { moduleType, name, permission };
      })
    )(
      'offers $moduleType to a viewer holding $permission',
      async ({ moduleType, name, permission }) => {
        await createHost({
          hasPermissionToAccessAdminControl: true,
          user: createUser({ permissions: [permission] })
        });

        search(name);

        expect(quickLinkModuleTypes()).toContain(moduleType);
      }
    );

    it('offers a gated module and its ungated namesake to an entitled viewer, and only the namesake otherwise', async () => {
      await createHost({
        user: createUser({
          permissions: [permissions.readMarketDataOfMarkets]
        })
      });

      search('Markets');

      // Two modules share this display name and only one of them is gated, so the
      // filter has to discriminate by module rather than by the text it matched on.
      expect(quickLinkModuleTypes()).toContain(DashboardModuleType.MARKETS);
      expect(quickLinkModuleTypes()).toContain(
        DashboardModuleType.MARKETS_PREMIUM
      );

      await createHost();

      search('Markets');

      expect(quickLinkModuleTypes()).toContain(DashboardModuleType.MARKETS);
      expect(quickLinkModuleTypes()).not.toContain(
        DashboardModuleType.MARKETS_PREMIUM
      );
    });

    it('withholds every gated module from a viewer with no permissions at all', async () => {
      await createHost();

      for (const { moduleType, name } of gatedModules) {
        search(name);

        expect(quickLinkModuleTypes()).not.toContain(moduleType);
      }
    });

    it.each([
      { description: 'no viewer has resolved', user: null },
      {
        description: 'the viewer declares no permissions',
        user: { settings: {} } as unknown as User
      }
    ])('offers only ungated modules when $description', async ({ user }) => {
      await createHost({ user });

      search('Admin Control');

      expect(quickLinkModuleTypes()).not.toContain(
        DashboardModuleType.ADMIN_OVERVIEW
      );

      // Still functional rather than merely empty: an ungated module is offered, so
      // the filter is discriminating rather than refusing everything.
      search('Holdings');

      expect(quickLinkModuleTypes()).toContain(DashboardModuleType.HOLDINGS);
    });
  });

  describe('the search pipeline that carries the contract', () => {
    it('holds quick links back until the debounce window closes', async () => {
      await createHost();

      assistant.searchFormControl.setValue('Holdings');

      jest.advanceTimersByTime(SEARCH_DEBOUNCE - 1);

      fixture.detectChanges();

      expect(quickLinks()).toEqual([]);

      jest.advanceTimersByTime(1);

      fixture.detectChanges();

      expect(quickLinks().length).toBeGreaterThan(0);
    });

    it('offers at most the default result limit', async () => {
      await createHost({
        hasPermissionToAccessAdminControl: true,
        user: createUser({ permissions: [permissions.accessAdminControl] })
      });

      search('Settings');

      expect(quickLinks().length).toBeLessThanOrEqual(
        GfAssistantComponent.SEARCH_RESULTS_DEFAULT_LIMIT
      );
    });

    it('offers nothing for a term that is only whitespace', async () => {
      await createHost();

      search('   ');

      expect(quickLinks()).toEqual([]);
      expect(allResults()).toEqual([]);
    });

    it('matches a display name irrespective of case', async () => {
      await createHost();

      search('watchlist');

      expect(quickLinkModuleTypes()).toContain(DashboardModuleType.WATCHLIST);
    });

    it('reports no diagnostic beyond the template own identity tracking', async () => {
      await createHost();

      search('Holdings');

      // A second settled search is what provokes the advisory: the rows are re-created
      // only when the collection is replaced, which is exactly what the pipeline does.
      search('Holding');

      expect(quickLinks().length).toBeGreaterThan(0);

      // The advisory is expected, and asserting that it is the *only* thing warned is
      // what makes it evidence rather than noise: the template's `@for` blocks track
      // their rows by identity while the pipeline hands them freshly built objects, so
      // every settled search re-creates the rendered rows. That is the production
      // template's own characteristic and it is unchanged by this suite - but anything
      // else appearing here would be a real diagnostic that this suite must not hide.
      expect(trackingAdvisories.length).toBeGreaterThan(0);
      expect(otherWarnings).toEqual([]);
    });
  });

  describe('selecting a module', () => {
    it('publishes the discriminator it was handed, unchanged', async () => {
      await createHost();

      assistant.onSelectModule(DashboardModuleType.HOLDINGS);

      expect(host.events).toEqual([DashboardModuleType.HOLDINGS]);
    });

    it('reports the selection before it reports the close', async () => {
      await createHost();

      search('Watchlist');

      const row = firstRow();

      expect(row).toBeTruthy();

      row?.click();

      fixture.detectChanges();

      // Order, not merely occurrence: a consumer that closes its panel on selection
      // would otherwise be free to tear the panel down before the selection it
      // belongs to had been delivered.
      expect(host.events[0]).toBe(DashboardModuleType.WATCHLIST);
      expect(host.events).toContain('closed');
      expect(host.events.indexOf('closed')).toBeGreaterThan(0);
    });

    it('derives no address for the row it renders', async () => {
      await createHost();

      search('Watchlist');

      const row = firstRow();

      // The row is activated by its click handler alone. An `href` here would mean a
      // link directive had resolved a route, and this application declares none for
      // it to resolve.
      expect(row?.getAttribute('href')).toBeNull();
    });
  });
});

/**
 * Binds the assistant exactly as the application does, so the outputs under test are
 * exercised through their template names. Reading them off the instance instead would
 * keep passing after a rename, which is the regression this suite exists to catch.
 */
@Component({
  imports: [GfAssistantComponent],
  selector: 'gf-test-assistant-host',
  template: `<gf-assistant
    [hasPermissionToAccessAdminControl]="hasPermissionToAccessAdminControl"
    [user]="user"
    (closed)="events.push('closed')"
    (moduleSelected)="events.push($event)"
  />`
})
class GfTestAssistantHostComponent {
  public events: string[] = [];
  public hasPermissionToAccessAdminControl = false;
  public user: User | null = null;
}
