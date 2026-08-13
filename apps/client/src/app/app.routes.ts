import { internalRoutes } from '@ghostfolio/common/routes/routes';

import { Routes } from '@angular/router';

import { AuthGuard } from './core/auth.guard';
import { GfDashboardCanvasComponent } from './dashboard/dashboard-canvas/dashboard-canvas.component';

/**
 * Screen selection is not a routing concern: the dashboard canvas owns a single
 * grid model and every screen is a module placed on it, so exactly one route
 * renders anything. The router stays fully wired around it — `forRoot` options,
 * service-worker navigation, `PageTitleStrategy` and `ModulePreloadService`.
 *
 * The root entry names its `component` eagerly because it is the one thing every
 * visit needs, so deferring it would only add a round trip; code splitting lives
 * behind the module registry's lazy loaders instead. `title` is set so the title
 * strategy stays exercised rather than merely registered, and it reuses an
 * already-translated string so no new source message is introduced.
 *
 * The wildcard is a redirect rather than a second screen, so an address this
 * application does not serve lands on the canvas instead of resolving to nothing.
 */
export const routes: Routes = [
  {
    canActivate: [AuthGuard],
    component: GfDashboardCanvasComponent,
    path: '',
    title: internalRoutes.home.title
  },
  {
    path: '**',
    redirectTo: '',
    pathMatch: 'full'
  }
];
