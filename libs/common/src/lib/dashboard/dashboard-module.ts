import { hasPermission, permissions } from '@ghostfolio/common/permissions';

// Type-only, and load-bearing: `@angular/localize` is what declares `$localize`
// on the global scope, and the message names below are tagged with it. Written as
// `import type` so it contributes the declaration at compile time and nothing at
// all at run time - the form this replaced was a value `import(...)` whose only
// observable effect was a floating promise, because its result was never awaited
// and never used.
import type {} from '@angular/localize';

import { DashboardModuleType } from './enums/dashboard-module-type';

/**
 * The shape `$localize` is used with in this file: a template tag returning the
 * message it was given.
 *
 * Deliberately narrower than `@angular/localize`'s own `LocalizeFn`, which also
 * carries `translate`, `TRANSLATIONS` and friends. Nothing here calls those, and
 * declaring only what is used is what lets the fallback below be a plain
 * function rather than a partially-implemented imitation of the real one.
 */
type LocalizeTag = (
  messageParts: TemplateStringsArray,
  ...expressions: readonly unknown[]
) => string;

/**
 * The global scope, seen through the one member this file cares about.
 *
 * Reached by an explicit two-step cast rather than by `as any`: `@angular/localize`
 * declares `$localize` as a global `const`, which makes the corresponding member of
 * `globalThis` read-only, so neither a direct assignment nor an intersection type
 * can express "install it if it is missing". The cast is confined to this one alias
 * and everything downstream of it stays typed.
 */
interface LocalizeGlobalScope {
  $localize?: LocalizeTag;
}

const localizeGlobalScope = globalThis as unknown as LocalizeGlobalScope;

/**
 * Installs a pass-through `$localize` when, and only when, nothing else has.
 *
 * The message names below are tagged at *module scope*, so `$localize` has to
 * exist by the time this module is evaluated — a requirement, not a preference.
 * In the application and in the client test environment it already does:
 * `apps/client/src/polyfills.ts` and `apps/client/src/test-setup.ts` both import
 * `@angular/localize/init` ahead of the first `@ghostfolio/*` import, and that
 * import is the *only* thing that installs the real, translating tag. Requiring
 * it there rather than attempting it here is the documented prerequisite.
 *
 * What is left is every consumer that has no such prerequisite — the Node
 * processes that reach this metadata through `@ghostfolio/common`, the API among
 * them, and any browser bundle that pulls this module in without the localize
 * polyfill. For those the guard installs a tag that returns the source message
 * verbatim, which is untranslated but correct, and it does so **synchronously**:
 * the previous form asked for the package with a floating `import(...)` whose
 * promise could not possibly settle before the tagged literals below were
 * evaluated, so in exactly the case it was meant to cover it installed nothing
 * at all and left a `ReferenceError`.
 *
 * The condition tests the member rather than the environment, which is what makes
 * it safe to run everywhere: where the real tag is present this is a no-op and
 * cannot shadow it, and where it is absent there is something to fall back on.
 */
if (typeof localizeGlobalScope.$localize !== 'function') {
  localizeGlobalScope.$localize = (messageParts, ...expressions) => {
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
 * Resolves a persisted discriminator to the module it names, or `undefined`.
 *
 * The parameter is a plain `string` on purpose. Every caller receives the
 * discriminator from outside the application — a saved layout document or a
 * request body — where it is whatever an older or hand-written client put there,
 * so narrowing it is this function's job rather than its precondition. That is
 * also why the lookup goes through `Object.hasOwn` instead of indexing the map
 * directly: a bare index would answer `constructor` or `toString` with an
 * inherited member of `Object.prototype`, and the caller would treat that as a
 * module definition.
 *
 * `undefined` is a meaningful answer and not a failure. A discriminator the
 * catalog no longer knows is how a layout saved before a module was renamed or
 * withdrawn still loads: the entry is dropped, per item, rather than invalidating
 * the whole arrangement.
 *
 * This is the single lookup site for module metadata, and both sides of the wire
 * use it — the layout DTO to reject a footprint smaller than the module declares,
 * and the canvas to normalize a stored one. Sharing it is what keeps the two from
 * disagreeing about what a module's minimum is.
 *
 * `hasOwnProperty` is called through `Object.prototype` rather than as
 * `Object.hasOwn`, which needs a newer `lib` than the API project compiles with,
 * and rather than off the map itself, which a discriminator named `hasOwnProperty`
 * would shadow.
 */
export function getDashboardModule(
  aModuleType: string
): DashboardModule | undefined {
  if (typeof aModuleType !== 'string') {
    return undefined;
  }

  return Object.prototype.hasOwnProperty.call(dashboardModules, aModuleType)
    ? (dashboardModules as Record<string, DashboardModule>)[aModuleType]
    : undefined;
}

export function isDashboardModulePermitted(
  aModule: Pick<DashboardModule, 'permission'>,
  aPermissions: string[] = []
): boolean {
  if (!aModule.permission) {
    return true;
  }

  return hasPermission(aPermissions, aModule.permission);
}
