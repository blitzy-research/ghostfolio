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
 */
export interface GfAppQueryParams extends Params {
  accessId?: string;
  accountDetailDialog?: string;
  accountId?: string;
  activityId?: string;
  createDialog?: string;
  dataSource?: DataSource;
  dialogModule?: DashboardModuleType;
  editDialog?: string;
  holdingDetailDialog?: string;
  jwt?: string;
  symbol?: string;
  transferBalanceDialog?: string;
  /**
   * Acquisition attribution, captured by the route guard and persisted to local
   * settings. Declared here rather than left to the inherited index signature so
   * that the guard reads a `string` instead of an `any` on its way into storage.
   */
  utm_source?: string;
}
