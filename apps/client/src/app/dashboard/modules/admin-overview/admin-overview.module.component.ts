import { GfAdminOverviewComponent } from '@ghostfolio/client/components/admin-overview/admin-overview.component';

import { ChangeDetectionStrategy, Component } from '@angular/core';

/**
 * Grid module wrapper for the administration overview.
 *
 * Structural adapter only: it re-hosts the preserved
 * `GfAdminOverviewComponent` unchanged inside a dashboard grid cell. That
 * feature component injects its own services, so this wrapper declares no
 * dependencies, no inputs and no outputs.
 *
 * The omissions are deliberate. Module chrome is rendered by the module host
 * and grid chrome is themed globally, so there is no stylesheet and no host
 * class. Grid state owns position and size, and layout writes originate only
 * from canvas-level callbacks, so no layout state lives here. Admin
 * visibility is enforced by the `permission` metadata on the module
 * registration, so no permission check lives here either.
 *
 * `OnPush` is declared explicitly: it keeps a default change-detection node
 * out of a tree that re-renders while a module is dragged or resized.
 *
 * The module registry resolves this class by name through a lazy loader, so
 * the exported name must not be renamed.
 */
@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [GfAdminOverviewComponent],
  selector: 'gf-admin-overview-module',
  templateUrl: './admin-overview.module.html'
})
export class GfAdminOverviewModuleComponent {}
