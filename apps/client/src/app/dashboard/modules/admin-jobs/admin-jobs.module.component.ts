import { GfAdminJobsComponent } from '@ghostfolio/client/components/admin-jobs/admin-jobs.component';

import { ChangeDetectionStrategy, Component } from '@angular/core';

/**
 * Dashboard module wrapper for the administration job queue feature.
 *
 * This is a purely structural adapter. It re-hosts the unmodified
 * `GfAdminJobsComponent` so the feature can be mounted inside a single cell of
 * the composable dashboard. Every behaviour — queue retrieval, status
 * filtering, table ordering and the per-job actions — stays owned by the
 * hosted component, which also resolves all of its own dependencies. This
 * wrapper therefore intentionally declares no state, no lifecycle hook, no
 * bindings and no stylesheet; its value lies entirely in what it does not do.
 *
 * Placement and dimensions are owned exclusively by the grid layer and are
 * never mirrored here. Access control is applied upstream from the shared
 * module metadata, so no authorisation check is duplicated in this file.
 *
 * The class is materialised lazily and exclusively through the central module
 * registration table. That dynamic-import boundary is what keeps the
 * administration feature out of the initial application bundle, so the export
 * below must remain a named export for the registration thunk to resolve it.
 */
@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [GfAdminJobsComponent],
  selector: 'gf-admin-jobs-module',
  templateUrl: './admin-jobs.module.html'
})
export class GfAdminJobsModuleComponent {}
