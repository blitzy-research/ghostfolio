import { internalRoutes } from '@ghostfolio/common/routes/routes';

import { Routes } from '@angular/router';

import { AuthGuard } from './core/auth.guard';
import { GfDashboardCanvasComponent } from './dashboard/dashboard-canvas/dashboard-canvas.component';

/**
 * The application's entire route table.
 *
 * Screen selection is no longer a routing concern: the dashboard canvas owns a
 * single grid model and every former screen is a module placed on it, so there
 * is exactly one route that renders anything. The router itself is untouched —
 * `RouterModule.forRoot` keeps its options, the service worker keeps handling
 * navigation, `PageTitleStrategy` still runs on every successful navigation and
 * `ModulePreloadService` remains the preloading strategy — only the set of
 * routes it resolves has collapsed.
 *
 * The root entry is declared with `component` rather than `loadComponent` on
 * purpose. It is the one thing every visit needs, so deferring it would only
 * add a round trip; code splitting now lives behind the module registry's lazy
 * loaders instead of behind route boundaries.
 *
 * `title` is set so the title strategy stays exercised rather than merely
 * registered, and it reuses an already-translated string from the shared route
 * registry so no new source message is introduced.
 */
export const routes: Routes = [
  {
    canActivate: [AuthGuard],
    component: GfDashboardCanvasComponent,
    path: '',
    title: internalRoutes.home.title
  },
  {
    // wildcard, if requested url doesn't match any paths for routes defined
    // earlier - every former deep link now lands on the canvas rather than on a
    // route that no longer exists
    path: '**',
    pathMatch: 'full',
    redirectTo: ''
  }
];
