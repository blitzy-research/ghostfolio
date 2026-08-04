import type { DashboardModuleType } from '@ghostfolio/common/dashboard';

import type { Params } from '@angular/router';
import type { DataSource } from '@prisma/client';

/**
 * Query parameters understood by the single root route that hosts the dashboard
 * canvas.
 *
 * Dialog plumbing stays route-agnostic: producers call
 * `router.navigate([], { queryParams: … })` against the current route. Because
 * every placed module is mounted at once, a bare flag such as `createDialog` or
 * `editDialog` is visible to every mounted module rather than to the one screen
 * that used to own the URL.
 *
 * Generic dialog flags are therefore only meaningful when paired with
 * `dialogModule`, which names the single module the flag is addressed to.
 * Consumers must compare it against their own `DashboardModuleType` and ignore
 * the flag otherwise. That comparison is fail-safe by construction: an
 * unqualified or foreign-qualified flag opens no dialog at all, so a producer
 * can never trigger an unrelated module's dialog.
 *
 * Two further rules follow from every module sharing one URL, and both are
 * obligations on producers rather than on this file:
 *
 * - **Clear only what you handled.** A dialog that closes must remove its own
 *   parameters with `queryParamsHandling: 'merge'` rather than replacing the
 *   whole set, because the rest of the set belongs to modules it knows nothing
 *   about - a shared-portfolio id among them.
 * - **Clear your own keys when handing off.** A dialog that closes itself and
 *   opens another module's dialog must drop the parameters that identify *it*
 *   in the same navigation. Otherwise the shell or the owning module sees its
 *   flag still standing and immediately reopens it on top of the dialog it just
 *   asked for.
 *
 * Exactly one flag departs from that default, and it is recorded here rather
 * than left to be rediscovered: `accountDetailDialog` has a **default owner**.
 * The accounts module hosts the shared `gf-accounts-table`, which issues the
 * flag itself without a qualifier and is deliberately left unchanged, so the
 * accounts module honours the unqualified form as well as its own. Every other
 * producer of that flag names its target module explicitly, which keeps the
 * invariant that matters intact: for any given address exactly one module reacts
 * and no dialog is ever opened twice.
 *
 * Flags are cleared the same way they are set — by navigating with an empty
 * command array — and every close path drops `dialogModule` along with the flag
 * it qualified, so a stale qualifier can never outlive its dialog.
 *
 * A third rule follows from the first two and is easy to miss: **a producer must
 * merge, never replace.** `router.navigate([], { queryParams })` without
 * `queryParamsHandling: 'merge'` discards every parameter it does not restate,
 * which on one shared URL means closing a sibling module's dialog and dropping the
 * shared-portfolio access identifier as a side effect of opening something
 * unrelated. Merging is what makes each key owned by the module that set it, and
 * it is also why every consumer has to tolerate being re-notified: once sibling
 * parameters survive a navigation, `route.queryParams` emits again for changes
 * that mean nothing to it, so a consumer that opens on every emission opens the
 * same dialog twice.
 *
 * Every member is declared rather than left to the inherited index signature. The
 * point is not documentation: a key that only exists in the signature is read as
 * `any`, so a typo in a producer and a typo in its consumer both compile, and the
 * dialog simply never opens. Listing them is what makes the two halves check
 * against each other.
 */
export interface GfAppQueryParams extends Params {
  accessId?: string;
  accountDetailDialog?: string;
  accountId?: string;
  activityId?: string;
  /** Owned by the market data administration module. */
  assetProfileDialog?: string;
  /**
   * Owned by `gf-benchmark`, which three modules can host at once — so unlike
   * every other dialog-naming flag it is *always* qualified with `dialogModule`,
   * and each instance reacts only to its own module's name.
   */
  benchmarkDetailDialog?: string;
  /** Owned by the market data administration module. */
  createAssetProfileDialog?: string;
  createDialog?: string;
  /** Owned by `gf-admin-platform`, hosted by the administration settings module. */
  createPlatformDialog?: string;
  /** Owned by `gf-admin-tag`, hosted by the administration settings module. */
  createTagDialog?: string;
  /** Owned by the watchlist module. */
  createWatchlistItemDialog?: string;
  dataSource?: DataSource;
  dialogModule?: DashboardModuleType;
  editDialog?: string;
  /** Owned by `gf-admin-platform`; pairs with `platformId`. */
  editPlatformDialog?: string;
  /** Owned by `gf-admin-tag`; pairs with `tagId`. */
  editTagDialog?: string;
  holdingDetailDialog?: string;
  jwt?: string;
  platformId?: string;
  symbol?: string;
  tagId?: string;
  transferBalanceDialog?: string;
  /**
   * Acquisition attribution, captured by the route guard and persisted to local
   * settings. Declared here rather than left to the inherited index signature so
   * that the guard reads a `string` instead of an `any` on its way into storage.
   */
  utm_source?: string;
}
