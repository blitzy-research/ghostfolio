import { hasPermission, permissions } from '@ghostfolio/common/permissions';

import { DashboardModuleType } from './enums/dashboard-module-type';

// `libs/common` is evaluated in three very different runtimes: the Angular
// browser bundle (where `$localize` is installed by the framework), the Node
// process that runs the NestJS API, and the Node/JSDOM process that runs Jest
// and the Storybook build. Only the first of those defines `$localize`, so a
// bare tagged template would throw `$localize is not defined` at module
// evaluation time in the other two. The guard below is reproduced verbatim
// from `libs/common/src/lib/routes/routes.ts` so that both shared metadata
// modules bootstrap identically; outside the browser it installs a pass-through
// tag that simply interpolates the source message.
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
 * Framework-free metadata contract for a single dashboard grid module.
 *
 * This is deliberately the *metadata half* of the module registry contract.
 * It is shared kernel code and therefore carries no Angular, no grid-engine
 * and no component references at all:
 *
 * - It is consumed by `libs/ui` (the assistant's quick-link search) and by
 *   `apps/client` (the registry that resolves a persisted `moduleType` to a
 *   component). `libs/ui` may not import `apps/client` — the workspace
 *   enforces that with `@nx/enforce-module-boundaries` at `error` severity —
 *   so the vocabulary both sides agree on has to live here.
 * - The lazy component-resolution thunk is intentionally *absent* from this
 *   contract. Collapsing the former route table removes every existing code
 *   splitting boundary, so the registry has to resolve components lazily in
 *   order to keep the production `initial` bundle inside its budget. A lazy
 *   dynamic import is inherently application-side, so it is contributed by the
 *   app-side registration table, which spreads this metadata and appends its
 *   own resolution thunk.
 *
 * Because that thunk is the only way to obtain a module component, and it
 * exists only inside the registry, ad-hoc insertion of a component into the
 * grid is structurally impossible rather than merely discouraged.
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
   * Smallest column span the module remains usable at. Never below 2: the grid
   * enforces a 2x2 minimum footprint, and a narrower module would clip the
   * content it hosts. The grid engine rejects any resize or drop that would
   * violate this value.
   */
  minItemCols: number;

  /**
   * Smallest row span the module remains usable at. Never below 2, for the
   * same reason as {@link DashboardModule.minItemCols}.
   */
  minItemRows: number;

  /**
   * Stable discriminator persisted in the user's saved layout. It is the only
   * identity the layout document stores, so it must never change once shipped.
   */
  moduleType: DashboardModuleType;

  /**
   * Localized display name shown in the module catalog and in the module
   * header. Reuses the exact source text of the corresponding legacy route
   * title so the existing translations are inherited unchanged.
   */
  name: string;

  /**
   * Optional permission the current user must hold for the module to be
   * offered in the catalog and rendered on the canvas.
   *
   * Only values that already exist in `@ghostfolio/common/permissions` are
   * used — no new permission constant is introduced by the dashboard. This
   * field is purely a user-interface exposure gate; the corresponding API
   * endpoints remain independently guarded server-side. Omit the field
   * entirely for modules every signed-in user may place.
   */
  permission?: string;
}

/**
 * The complete, canonical catalog of dashboard module types.
 *
 * This map is the single registration site for module *metadata*, and the
 * `satisfies Record<DashboardModuleType, DashboardModule>` clause makes that
 * completeness a compile-time guarantee: adding a member to
 * {@link DashboardModuleType} without registering it here fails the build.
 *
 * Entries are declared in {@link DashboardModuleType} order rather than
 * alphabetically, because that order is the intended catalog presentation
 * order — it groups the portfolio surface, then accounts and user settings,
 * then administration, then the assistant — which reads far better in a
 * searchable catalog than an alphabetical list that would interleave the
 * administration modules at the top. Keys *within* each entry are alphabetical,
 * matching the convention used by the shared route registry.
 *
 * Sizing follows five content archetypes, so that a module is never offered at
 * a footprint its content cannot use (a 12-column data table at 4 columns, for
 * example, is unusable):
 *
 * - compact — a single gauge or card: 3x3 minimum, 4x4 default
 * - standard — one chart or a medium table: 4x3/4x4 minimum, 6x5/8x6 default
 * - tall and narrow — a vertical list, a form or a chat transcript: a small
 *   column minimum with a generous row default
 * - wide table — a many-column paginated table: 6 columns minimum, full 12
 *   column default
 * - analytical — several stacked charts migrated from a full-page screen: 6
 *   columns minimum, full 12 column default with the tallest row budgets
 *
 * Every entry satisfies the grid contract: minimums are never below 2, defaults
 * are never below their own minimums, and no column value exceeds the fixed
 * 12-column grid width. Those bounds are mirrored by the server-side layout
 * payload validation, so a layout composed from these values always round-trips.
 */
export const dashboardModules = {
  // Portfolio surface
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
    // Proper noun, deliberately not localized — consistent with the legacy
    // route title it replaces
    name: 'FIRE'
  },
  [DashboardModuleType.X_RAY]: {
    defaultItemCols: 8,
    defaultItemRows: 6,
    minItemCols: 4,
    minItemRows: 4,
    moduleType: DashboardModuleType.X_RAY,
    // Proper noun, deliberately not localized — see FIRE above
    name: 'X-ray'
  },

  // Accounts and user settings
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

  // Administration — gated on the permission that the deleted header
  // navigation used to gate the admin control screens with
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

  // Assistant
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
 * Resolves whether a module may be surfaced to a user holding the given
 * permissions.
 *
 * Retiring the header navigation removed the only client-side gate on the
 * administration screens, so this predicate is the single authoritative
 * replacement. It is deliberately declared once, in the shared kernel, because
 * both the module catalog (which decides what a user may add) and the canvas
 * render path (which decides what a persisted layout may still show) have to
 * answer the question identically — two independent copies would inevitably
 * drift.
 *
 * The parameter is a structural `Pick`, so it accepts both the shared metadata
 * in {@link dashboardModules} and the richer application-side registry
 * definitions that extend it. A module without a declared permission is always
 * permitted.
 *
 * This is a user-interface exposure gate only; it is not a substitute for the
 * server-side guards, which remain in force regardless of what the client
 * renders.
 *
 * @example
 * const visible = Object.values(dashboardModules).filter((module) => {
 *   return isDashboardModulePermitted(module, user?.permissions);
 * });
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
