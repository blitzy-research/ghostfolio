import { DashboardModuleType } from '@ghostfolio/common/dashboard';

import { Injectable } from '@angular/core';
import { Observable, Subject } from 'rxjs';

/**
 * Intent bus a feature component uses to ask that a module be revealed, so it
 * needs no reference to the canvas that decides what revealing means.
 *
 * It lives in `core/` rather than `dashboard/` so the dependency points from
 * `components` to `core`, the direction in which `LayoutService` is already
 * consumed. Both folders are inside one Nx project, so nothing mechanically
 * forbids the reverse import: keeping `core` free of `dashboard` imports is a
 * convention this arrangement depends on, not a build-enforced boundary.
 *
 * The module discriminator is the entire payload, matching what the assistant
 * emits so an intent can be forwarded on unadapted. Resolving a discriminator to
 * a component belongs to the module registry and placing it to the grid.
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

  public getRevealModuleSubject() {
    return this.revealModuleSubject;
  }
}
