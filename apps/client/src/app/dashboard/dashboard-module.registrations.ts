import { DashboardModuleType } from './enums/dashboard-module-type';
import type { DashboardModuleRegistration } from './interfaces/interfaces';

/**
 * The registration table the module registry builds its lookup map from, and so the
 * place a new module is introduced: one entry, rather than a second table, a
 * `switch` or anything inside a module wrapper.
 *
 * Three constraints govern it.
 *
 * 1. **Loaders, not component references.** These thunks are the application's only
 *    code-splitting seam, so holding component *types* here would pull every module
 *    tree into the initial chunk and breach the production `initial` budget (2 MB
 *    warning, 5 MB error).
 * 2. **No metadata duplication.** Display names, default and minimum cell dimensions
 *    and the optional visibility permission are authoritative in the
 *    framework-neutral `dashboardModules` map in `@ghostfolio/common/dashboard`,
 *    which `libs/ui` also reads. This file contributes only the
 *    discriminator-to-loader binding, and no layout geometry at all.
 * 3. **Order is catalog order.** Entries follow `DashboardModuleType` declaration
 *    order, and every enum member appears exactly once.
 *
 * Dependencies run one way: this table references module wrappers, and no wrapper
 * imports it or anything else from the canvas layer.
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
