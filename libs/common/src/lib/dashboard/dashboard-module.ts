import { hasPermission, permissions } from '@ghostfolio/common/permissions';

import { DashboardModuleType } from './enums/dashboard-module-type';

// Node/Jest do not install `$localize`; mirror `routes.ts` with a pass-through
// tag outside the browser.
if (typeof window !== 'undefined') {
  import('@angular/localize');
} else {
  (global as any).$localize = (
    messageParts: TemplateStringsArray,
    ...expressions: any[]
  ) => {
    return String.raw({ raw: messageParts }, ...expressions);
  };
}

/**
 * Framework-neutral module metadata; application-side loaders stay outside this
 * contract to preserve lazy code splitting.
 */
export interface DashboardModule {
  /**
   * Column span applied when the module is first placed on the canvas.
   * Must be greater than or equal to {@link DashboardModule.minItemCols} and
   * must not exceed the fixed 12-column width of the grid.
   */
  defaultItemCols: number;

  /**
   * Row span applied when the module is first placed on the canvas. Rows have
   * a constant pixel height, so this value is a direct height budget. Must be
   * greater than or equal to {@link DashboardModule.minItemRows}.
   */
  defaultItemRows: number;

  /**
   * Smallest column span the module remains usable at. Must be at least 2, and
   * grid policy must enforce it.
   */
  minItemCols: number;

  /**
   * Smallest row span the module remains usable at. Must be at least 2, and
   * grid policy must enforce it.
   */
  minItemRows: number;

  /**
   * Stable discriminator persisted in the user's saved layout. It is the only
   * identity the layout document stores, so it must never change once shipped.
   */
  moduleType: DashboardModuleType;

  /**
   * Localized display name; keep source text stable so existing translation IDs
   * remain reusable.
   */
  name: string;

  /**
   * Optional UI visibility permission. Server endpoints remain independently
   * guarded.
   */
  permission?: string;
}

/**
 * Canonical metadata map. Enum order is catalog order; `satisfies` enforces one
 * entry per module type.
 */
export const dashboardModules = {
  [DashboardModuleType.PORTFOLIO_OVERVIEW]: {
    defaultItemCols: 8,
    defaultItemRows: 6,
    minItemCols: 4,
    minItemRows: 4,
    moduleType: DashboardModuleType.PORTFOLIO_OVERVIEW,
    name: $localize`Overview`
  },
  [DashboardModuleType.HOLDINGS]: {
    defaultItemCols: 6,
    defaultItemRows: 6,
    minItemCols: 4,
    minItemRows: 4,
    moduleType: DashboardModuleType.HOLDINGS,
    name: $localize`Holdings`
  },
  [DashboardModuleType.PORTFOLIO_SUMMARY]: {
    defaultItemCols: 4,
    defaultItemRows: 8,
    minItemCols: 3,
    minItemRows: 4,
    moduleType: DashboardModuleType.PORTFOLIO_SUMMARY,
    name: $localize`Summary`
  },
  [DashboardModuleType.MARKETS]: {
    defaultItemCols: 4,
    defaultItemRows: 4,
    minItemCols: 3,
    minItemRows: 3,
    moduleType: DashboardModuleType.MARKETS,
    name: $localize`Markets`
  },
  [DashboardModuleType.MARKETS_PREMIUM]: {
    defaultItemCols: 8,
    defaultItemRows: 6,
    minItemCols: 4,
    minItemRows: 4,
    moduleType: DashboardModuleType.MARKETS_PREMIUM,
    name: $localize`Markets`,
    permission: permissions.readMarketDataOfMarkets
  },
  [DashboardModuleType.WATCHLIST]: {
    defaultItemCols: 6,
    defaultItemRows: 5,
    minItemCols: 4,
    minItemRows: 3,
    moduleType: DashboardModuleType.WATCHLIST,
    name: $localize`Watchlist`
  },
  [DashboardModuleType.PORTFOLIO_ANALYSIS]: {
    defaultItemCols: 12,
    defaultItemRows: 10,
    minItemCols: 6,
    minItemRows: 6,
    moduleType: DashboardModuleType.PORTFOLIO_ANALYSIS,
    name: $localize`Analysis`
  },
  [DashboardModuleType.ACTIVITIES]: {
    defaultItemCols: 12,
    defaultItemRows: 8,
    minItemCols: 6,
    minItemRows: 4,
    moduleType: DashboardModuleType.ACTIVITIES,
    name: $localize`Activities`
  },
  [DashboardModuleType.ALLOCATIONS]: {
    defaultItemCols: 12,
    defaultItemRows: 10,
    minItemCols: 6,
    minItemRows: 5,
    moduleType: DashboardModuleType.ALLOCATIONS,
    name: $localize`Allocations`
  },
  [DashboardModuleType.FIRE]: {
    defaultItemCols: 8,
    defaultItemRows: 8,
    minItemCols: 4,
    minItemRows: 5,
    moduleType: DashboardModuleType.FIRE,
    // Proper noun; intentionally not localized.
    name: 'FIRE'
  },
  [DashboardModuleType.X_RAY]: {
    defaultItemCols: 8,
    defaultItemRows: 6,
    minItemCols: 4,
    minItemRows: 4,
    moduleType: DashboardModuleType.X_RAY,
    // Proper noun; intentionally not localized.
    name: 'X-ray'
  },

  [DashboardModuleType.ACCOUNTS]: {
    defaultItemCols: 10,
    defaultItemRows: 7,
    minItemCols: 5,
    minItemRows: 4,
    moduleType: DashboardModuleType.ACCOUNTS,
    name: $localize`Accounts`
  },
  [DashboardModuleType.ACCOUNT_SETTINGS]: {
    defaultItemCols: 6,
    defaultItemRows: 8,
    minItemCols: 4,
    minItemRows: 4,
    moduleType: DashboardModuleType.ACCOUNT_SETTINGS,
    name: $localize`Settings`
  },
  [DashboardModuleType.ACCOUNT_MEMBERSHIP]: {
    defaultItemCols: 4,
    defaultItemRows: 4,
    minItemCols: 3,
    minItemRows: 3,
    moduleType: DashboardModuleType.ACCOUNT_MEMBERSHIP,
    name: $localize`Membership`
  },
  [DashboardModuleType.ACCOUNT_ACCESS]: {
    defaultItemCols: 6,
    defaultItemRows: 5,
    minItemCols: 4,
    minItemRows: 3,
    moduleType: DashboardModuleType.ACCOUNT_ACCESS,
    name: $localize`Access`
  },

  [DashboardModuleType.ADMIN_OVERVIEW]: {
    defaultItemCols: 6,
    defaultItemRows: 7,
    minItemCols: 4,
    minItemRows: 4,
    moduleType: DashboardModuleType.ADMIN_OVERVIEW,
    name: $localize`Admin Control`,
    permission: permissions.accessAdminControl
  },
  [DashboardModuleType.ADMIN_JOBS]: {
    defaultItemCols: 12,
    defaultItemRows: 7,
    minItemCols: 6,
    minItemRows: 4,
    moduleType: DashboardModuleType.ADMIN_JOBS,
    name: $localize`Job Queue`,
    permission: permissions.accessAdminControl
  },
  [DashboardModuleType.ADMIN_MARKET_DATA]: {
    defaultItemCols: 12,
    defaultItemRows: 9,
    minItemCols: 6,
    minItemRows: 5,
    moduleType: DashboardModuleType.ADMIN_MARKET_DATA,
    name: $localize`Market Data`,
    permission: permissions.accessAdminControl
  },
  [DashboardModuleType.ADMIN_SETTINGS]: {
    defaultItemCols: 8,
    defaultItemRows: 7,
    minItemCols: 4,
    minItemRows: 4,
    moduleType: DashboardModuleType.ADMIN_SETTINGS,
    name: $localize`Settings`,
    permission: permissions.accessAdminControl
  },
  [DashboardModuleType.ADMIN_USERS]: {
    defaultItemCols: 12,
    defaultItemRows: 7,
    minItemCols: 6,
    minItemRows: 4,
    moduleType: DashboardModuleType.ADMIN_USERS,
    name: $localize`Users`,
    permission: permissions.accessAdminControl
  },

  [DashboardModuleType.AI_CHAT]: {
    defaultItemCols: 5,
    defaultItemRows: 8,
    minItemCols: 3,
    minItemRows: 5,
    moduleType: DashboardModuleType.AI_CHAT,
    name: $localize`AI Chat`,
    permission: permissions.readAiPrompt
  }
} satisfies Record<DashboardModuleType, DashboardModule>;

/**
 * Applies the shared UI visibility rule; absence of a permission means visible,
 * while server authorization remains independent.
 */
export function isDashboardModulePermitted(
  aModule: Pick<DashboardModule, 'permission'>,
  aPermissions: string[] = []
): boolean {
  if (!aModule.permission) {
    return true;
  }

  return hasPermission(aPermissions, aModule.permission);
}
