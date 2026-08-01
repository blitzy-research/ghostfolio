import { GfHomeMarketComponent } from '@ghostfolio/client/components/home-market/home-market.component';

import { ChangeDetectionStrategy, Component } from '@angular/core';

/**
 * Dashboard module wrapper for the free markets view.
 *
 * A deliberately inert structural adapter. Its only job is to re-host the
 * existing, unmodified `gf-home-market` feature component so that the canvas
 * can materialise it inside a single grid cell. That feature component keeps
 * sole ownership of its own data fetching and business logic, which this
 * wrapper never intercepts, proxies, rebuilds or short-circuits.
 *
 * Every adjacent concern is deliberately owned elsewhere:
 *
 * - Card chrome, title and remove action: the module host component.
 * - Placement and size: grid state, which is the single source of truth. This
 *   wrapper holds no layout state whatsoever.
 * - Discovery and lazy materialisation: the central dashboard module table,
 *   which reaches this class through a dynamic `import()` and resolves it as a
 *   named export. The coupling is strictly one-way, so this component never
 *   learns that it is hosted inside a grid, and that dynamic boundary is what
 *   preserves code splitting now that the lazy route boundaries are gone.
 * - Persistence: canvas-level grid state change events, exclusively.
 * - Minimum cell footprint: shared module metadata, enforced by the grid
 *   engine's item validation callback.
 * - Entitlement filtering: the catalog and the canvas. This is the free
 *   markets module, so nothing here gates it; the premium variant lives in a
 *   separate sibling module and hosts a different feature component.
 * - Neutralising the hosted view's page-scale container and heading: the
 *   global grid stylesheet. That is why this wrapper intentionally ships no
 *   stylesheet of its own.
 *
 * `OnPush` is declared explicitly rather than inherited. The wrapper binds no
 * inputs, so it cannot present stale data, and the hosted component drives its
 * own updates through an explicit change detector. Keeping every dashboard
 * wrapper on `OnPush` is what holds drag and resize inside their latency
 * budget under the application's zone-based change detection.
 */
@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [GfHomeMarketComponent],
  selector: 'gf-markets-module',
  templateUrl: './markets.module.html'
})
export class GfMarketsModuleComponent {}
