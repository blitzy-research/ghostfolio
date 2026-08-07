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
   * Optional localized qualifier that tells two modules sharing one
   * {@link DashboardModule.name} apart.
   *
   * Secondary metadata, deliberately, and never folded into the name. The name is
   * the authoritative display string and is reused verbatim from the shared route
   * registry, which is what keeps all thirteen locales translated at no cost; the
   * route registry itself, however, gives two of its screens the same title -
   * `Markets` for both market screens and `Settings` for both the account and the
   * admin one - and behind a URL that was harmless. On a single canvas there is no
   * URL, so the distinction has to be rendered, and rendering it from a separate
   * field is what lets the name stay exact.
   *
   * Presentation only. The catalog draws it beside the name and folds it into the
   * row's accessible name; nothing keys off it, and a module without one is
   * complete.
   *
   * Populated exclusively from messages this application already translates, so a
   * qualifier never introduces an untranslated string into a locale.
   */
  context?: string;

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
   * Localized display name, reused verbatim from the shared route registry's
   * title for the screen this module replaces. Keep the source text identical to
   * that title: it is what makes the existing translation unit - and therefore
   * all twelve locales - apply to this module without a new message. Where two
   * registry titles collide, disambiguate through
   * {@link DashboardModule.context} rather than by editing this string.
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
  // Seven rows rather than six because this module's height requirement is
  // deterministic, so a default can actually satisfy it. Its chart is pinned to a
  // 16:9 box capped at 50rem, which at this width is exactly 450px, and the
  // performance figures below it add 4px of margin plus 115px - 569px in total,
  // against the 479px of body six rows leaves. The result was that the headline
  // value and the performance percentage sat entirely below the fold on a
  // freshly added module. Seven rows give 620px of cell and 569px of body: an
  // exact fit, with nothing hidden and no scrolling required.
  //
  // The data-driven modules are deliberately NOT treated this way. What a
  // holdings table or an admin list needs depends on the viewer's own data - the
  // users table measured 2,334px, which no sane default can accommodate - so
  // there the honest answer is the scroll hint on the module chrome, not a taller
  // default that would be wrong for the next viewer.
  [DashboardModuleType.PORTFOLIO_OVERVIEW]: {
    defaultItemCols: 8,
    defaultItemRows: 7,
    minItemCols: 4,
    minItemRows: 4,
    moduleType: DashboardModuleType.PORTFOLIO_OVERVIEW,
    name: $localize`Overview`
  },
  // Eight columns rather than six, because this module's table has a horizontal
  // requirement that is deterministic even though its vertical one is not. Its
  // header row is `min-width: max-content` per column - the rule that stops a
  // label being squeezed to "Sta" - so the columns it shows have a hard combined
  // floor of 720px, measured identically at every viewport. Six columns gave the
  // body 591px at a 1280px viewport, so the trailing performance column rendered
  // as a lone "P" and the ± figure beside it was cut off entirely. Eight give it
  // 803px: the whole table, with nothing clipped and no scrolling required, from
  // 1280px upward.
  //
  // The ROW count is deliberately left where it is, for the reason set out above:
  // how tall a holdings table needs to be depends on how many holdings the viewer
  // owns, so the honest answer there stays the scroll hint on the module chrome.
  // Width is the opposite case - the column set is fixed - which is why only one
  // of the two is being tuned.
  [DashboardModuleType.HOLDINGS]: {
    defaultItemCols: 8,
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
    defaultItemCols: 6,
    defaultItemRows: 4,
    minItemCols: 6,
    minItemRows: 4,
    moduleType: DashboardModuleType.MARKETS,
    name: $localize`Markets`
  },
  [DashboardModuleType.MARKETS_PREMIUM]: {
    // Qualified because the ungated markets module above carries the same name,
    // and it has to: the shared route registry gives both market screens the
    // title `Markets`, and the name is that title verbatim. The qualifier names
    // what the permission below actually grants, and it is a separate field so
    // the authoritative name stays exactly the message every locale already
    // translates.
    context: $localize`Market Data`,
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
    minItemCols: 6,
    minItemRows: 6,
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
    // Qualified because the admin module of the same purpose carries the same
    // name, and both are named `Settings` because that is the title the shared
    // route registry gives each of those screens. An administrator sees both rows
    // in one list, so the qualifier names the family this one belongs to - the
    // same word its sibling access and membership modules sit under.
    context: $localize`Account`,
    defaultItemCols: 6,
    defaultItemRows: 8,
    minItemCols: 4,
    minItemRows: 4,
    moduleType: DashboardModuleType.ACCOUNT_SETTINGS,
    // Deliberately the exact route title, unqualified. The distinction from the
    // admin module of the same name travels in {@link DashboardModule.context}
    // above rather than being welded into the name, so the name a viewer reads
    // stays identical to the one the shared route registry has always published
    // and every locale already translates - which is also why it mints no new
    // trans-unit.
    name: $localize`Settings`
  },
  [DashboardModuleType.ACCOUNT_MEMBERSHIP]: {
    defaultItemCols: 4,
    defaultItemRows: 5,
    minItemCols: 4,
    minItemRows: 5,
    moduleType: DashboardModuleType.ACCOUNT_MEMBERSHIP,
    name: $localize`Membership`
  },
  // Eight columns and six rows, and the minimum height raised with them.
  //
  // Its table was the worst case on the canvas: the trailing actions column -
  // the only way to edit or revoke a grant - sat entirely outside the visible
  // area at 1280px and below, so a control the feature depends on was reachable
  // only by discovering a horizontal scroll. Two things were wrong at once and
  // both are fixed: the share address in the details column had no width cap, so
  // it alone set an 858px floor that no viewport could reduce (capped in
  // `access-table.component.scss`), and six columns were too few even for the
  // reduced floor. Eight give the body 803px against a floor of roughly 574px.
  //
  // Six rows rather than five for the vertical half of the same defect: five left
  // 389px of body against 428px of content, so the last grant's row was cut off.
  //
  // `minItemRows` moves from three to four because three could not work: a
  // 3-row cell is 260px, and once the card header and the module gutter are taken
  // out that leaves about 180px - not enough for a table header plus a single
  // row. Raising it is safe for saved arrangements, because hydration clamps a
  // stored footprint UP to the declared minimum rather than rejecting it.
  [DashboardModuleType.ACCOUNT_ACCESS]: {
    defaultItemCols: 8,
    defaultItemRows: 6,
    minItemCols: 4,
    minItemRows: 4,
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
    // Qualified for the same reason as the account settings module above: an
    // administrator holds both, and the route registry titles both screens
    // `Settings`. The qualifier is the title of the route these admin screens sit
    // under, which is also the name of this family's own overview module.
    context: $localize`Admin Control`,
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
