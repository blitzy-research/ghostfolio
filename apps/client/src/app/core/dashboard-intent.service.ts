import { DashboardModuleType } from '@ghostfolio/common/dashboard';

import { Injectable } from '@angular/core';
import { Observable, Subject } from 'rxjs';

/**
 * Neutral, application-internal intent bus for revealing a dashboard module.
 *
 * Feature components that previously sent the user to a different screen now
 * publish a reveal-module intent instead. The dashboard canvas subscribes and
 * decides what to do with it, so publishers never import - and never learn
 * about - the canvas layer.
 *
 * Why this lives in `core/` and not in `dashboard/`: the resulting dependency
 * only ever points from `components` to `core`, the same direction in which
 * `LayoutService` is already consumed. That makes the isolation structural
 * rather than conventional, because `core` never imports from `dashboard` and
 * `@nx/enforce-module-boundaries` fails the build if it ever tries.
 *
 * The module discriminator is the entire payload, matching the shape emitted by
 * the assistant so an intent can be forwarded onto this bus without
 * adaptation. Resolving a discriminator to a component is the module registry's
 * responsibility and positioning it is the grid's; neither belongs here.
 *
 * @example
 * // Publish, from any component under `apps/client/src/app`:
 * this.dashboardIntentService
 *   .getRevealModuleSubject()
 *   .next(DashboardModuleType.ACCOUNTS);
 *
 * // Observe, from the dashboard canvas:
 * this.dashboardIntentService.revealModule$
 *   .pipe(takeUntilDestroyed())
 *   .subscribe((moduleType) => this.revealModule(moduleType));
 */
@Injectable({ providedIn: 'root' })
export class DashboardIntentService {
  /**
   * Stream of reveal-module intents, exposed read-only so that subscribers
   * cannot publish. It is backed by a plain `Subject` because an intent is a
   * transient event rather than state: a late subscriber deliberately receives
   * no replay, since replaying a stale intent would spuriously surface a
   * module.
   */
  public revealModule$: Observable<DashboardModuleType>;

  private revealModuleSubject = new Subject<DashboardModuleType>();

  public constructor() {
    this.revealModule$ = this.revealModuleSubject.asObservable();
  }

  /**
   * Returns the raw subject so that callers can publish an intent, mirroring
   * `LayoutService.getShouldReloadSubject()`.
   */
  public getRevealModuleSubject() {
    return this.revealModuleSubject;
  }
}
