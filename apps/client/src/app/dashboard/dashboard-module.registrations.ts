import { DashboardModuleType } from './enums/dashboard-module-type';
import type { DashboardModuleRegistration } from './interfaces/interfaces';

/**
 * Declarative application-side registration table for every dashboard module.
 *
 * This array is the *only* mechanism by which a module type becomes available
 * to the canvas: the module registry builds its lookup map from these entries,
 * and the canvas resolves a persisted discriminator exclusively through that
 * map. Introducing a module therefore means adding exactly one entry here —
 * never inserting a component into the grid ad hoc, and never registering from
 * a second table, a `switch` statement or a module wrapper.
 *
 * Two deliberate constraints govern each entry:
 *
 * 1. **Loaders, not component references.** Collapsing the former 22 lazy
 *    route boundaries removed every code-splitting seam in the application.
 *    Holding component *types* here would pull all 21 module trees — and
 *    everything they transitively import — into the initial chunk and breach
 *    the production `initial` budget (2 MB warning, 5 MB error). Each entry
 *    therefore stores a thunk that dynamically imports its wrapper, relocating
 *    code splitting from route boundaries to registry boundaries. A welcome
 *    side effect: a registry-held thunk is the only reachable way to obtain a
 *    module component, so ad-hoc insertion is structurally impossible rather
 *    than merely discouraged.
 *
 * 2. **No metadata duplication.** Display names, default and minimum cell
 *    dimensions, and the optional visibility permission are authoritative in
 *    the framework-neutral `dashboardModules` map exported from
 *    `@ghostfolio/common/dashboard`, which is shared with `libs/ui`. This file
 *    contributes nothing but the discriminator-to-loader binding, and carries
 *    no layout geometry whatsoever — a module's position and size live solely
 *    in grid state.
 *
 * Order matters: entries follow `DashboardModuleType` declaration order, which
 * is also catalog order, so the catalog listing stays stable and reviewable.
 * Every enum member appears exactly once, so the registry can resolve any
 * persisted discriminator it recognises and safely drop the ones it does not.
 *
 * Dependencies run one way only — this table references module wrappers, and
 * no wrapper imports this table or anything else from the canvas layer.
 *
 * @see {@link DashboardModuleType} for the persisted discriminator vocabulary.
 */
export const dashboardModuleRegistrations: DashboardModuleRegistration[] = [
  {
    loadComponent: () =>
      import('./modules/portfolio-overview/portfolio-overview.module.component').then(
        (m) => m.GfPortfolioOverviewModuleComponent
      ),
    moduleType: DashboardModuleType.PORTFOLIO_OVERVIEW
  },
  {
    loadComponent: () =>
      import('./modules/holdings/holdings.module.component').then(
        (m) => m.GfHoldingsModuleComponent
      ),
    moduleType: DashboardModuleType.HOLDINGS
  },
  {
    loadComponent: () =>
      import('./modules/portfolio-summary/portfolio-summary.module.component').then(
        (m) => m.GfPortfolioSummaryModuleComponent
      ),
    moduleType: DashboardModuleType.PORTFOLIO_SUMMARY
  },
  {
    loadComponent: () =>
      import('./modules/markets/markets.module.component').then(
        (m) => m.GfMarketsModuleComponent
      ),
    moduleType: DashboardModuleType.MARKETS
  },
  {
    loadComponent: () =>
      import('./modules/markets-premium/markets-premium.module.component').then(
        (m) => m.GfMarketsPremiumModuleComponent
      ),
    moduleType: DashboardModuleType.MARKETS_PREMIUM
  },
  {
    loadComponent: () =>
      import('./modules/watchlist/watchlist.module.component').then(
        (m) => m.GfWatchlistModuleComponent
      ),
    moduleType: DashboardModuleType.WATCHLIST
  },
  {
    loadComponent: () =>
      import('./modules/portfolio-analysis/portfolio-analysis.module.component').then(
        (m) => m.GfPortfolioAnalysisModuleComponent
      ),
    moduleType: DashboardModuleType.PORTFOLIO_ANALYSIS
  },
  {
    loadComponent: () =>
      import('./modules/activities/activities.module.component').then(
        (m) => m.GfActivitiesModuleComponent
      ),
    moduleType: DashboardModuleType.ACTIVITIES
  },
  {
    loadComponent: () =>
      import('./modules/allocations/allocations.module.component').then(
        (m) => m.GfAllocationsModuleComponent
      ),
    moduleType: DashboardModuleType.ALLOCATIONS
  },
  {
    loadComponent: () =>
      import('./modules/fire/fire.module.component').then(
        (m) => m.GfFireModuleComponent
      ),
    moduleType: DashboardModuleType.FIRE
  },
  {
    loadComponent: () =>
      import('./modules/x-ray/x-ray.module.component').then(
        (m) => m.GfXRayModuleComponent
      ),
    moduleType: DashboardModuleType.X_RAY
  },
  {
    loadComponent: () =>
      import('./modules/accounts/accounts.module.component').then(
        (m) => m.GfAccountsModuleComponent
      ),
    moduleType: DashboardModuleType.ACCOUNTS
  },
  {
    loadComponent: () =>
      import('./modules/account-settings/account-settings.module.component').then(
        (m) => m.GfAccountSettingsModuleComponent
      ),
    moduleType: DashboardModuleType.ACCOUNT_SETTINGS
  },
  {
    loadComponent: () =>
      import('./modules/account-membership/account-membership.module.component').then(
        (m) => m.GfAccountMembershipModuleComponent
      ),
    moduleType: DashboardModuleType.ACCOUNT_MEMBERSHIP
  },
  {
    loadComponent: () =>
      import('./modules/account-access/account-access.module.component').then(
        (m) => m.GfAccountAccessModuleComponent
      ),
    moduleType: DashboardModuleType.ACCOUNT_ACCESS
  },
  {
    loadComponent: () =>
      import('./modules/admin-overview/admin-overview.module.component').then(
        (m) => m.GfAdminOverviewModuleComponent
      ),
    moduleType: DashboardModuleType.ADMIN_OVERVIEW
  },
  {
    loadComponent: () =>
      import('./modules/admin-jobs/admin-jobs.module.component').then(
        (m) => m.GfAdminJobsModuleComponent
      ),
    moduleType: DashboardModuleType.ADMIN_JOBS
  },
  {
    loadComponent: () =>
      import('./modules/admin-market-data/admin-market-data.module.component').then(
        (m) => m.GfAdminMarketDataModuleComponent
      ),
    moduleType: DashboardModuleType.ADMIN_MARKET_DATA
  },
  {
    loadComponent: () =>
      import('./modules/admin-settings/admin-settings.module.component').then(
        (m) => m.GfAdminSettingsModuleComponent
      ),
    moduleType: DashboardModuleType.ADMIN_SETTINGS
  },
  {
    loadComponent: () =>
      import('./modules/admin-users/admin-users.module.component').then(
        (m) => m.GfAdminUsersModuleComponent
      ),
    moduleType: DashboardModuleType.ADMIN_USERS
  },
  {
    loadComponent: () =>
      import('./modules/ai-chat/ai-chat.module.component').then(
        (m) => m.GfAiChatModuleComponent
      ),
    moduleType: DashboardModuleType.AI_CHAT
  }
];
