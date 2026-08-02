import type { DashboardModuleType } from '@ghostfolio/common/dashboard';

import type { Params } from '@angular/router';
import type { DataSource } from '@prisma/client';

/**
 * Query parameters understood by the single root route that hosts the dashboard
 * canvas.
 *
 * Dialog plumbing deliberately stays route-agnostic: producers keep calling
 * `router.navigate([], { queryParams: … })` against the current route. What
 * changes on a single-canvas shell is that every module is co-mounted
 * simultaneously, so a bare boolean flag such as `createDialog` or `editDialog`
 * is observed by *every* mounted module at once rather than by the one screen
 * that used to own the URL.
 *
 * Generic dialog flags are therefore only meaningful when paired with
 * `dialogModule`, which names the single module the flag is addressed to.
 * Consumers must compare it against their own `DashboardModuleType` and ignore
 * the flag otherwise. That comparison is fail-safe by construction: an
 * unqualified or foreign-qualified flag opens no dialog at all, so a producer
 * can never trigger an unrelated module's dialog.
 */
export interface GfAppQueryParams extends Params {
  accessId?: string;
  createDialog?: string;
  dataSource?: DataSource;
  dialogModule?: DashboardModuleType;
  editDialog?: string;
  holdingDetailDialog?: string;
  jwt?: string;
  symbol?: string;
}
