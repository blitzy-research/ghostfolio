import { UpdateUserDashboardLayoutDto } from '@ghostfolio/common/dtos';
import { reportSanitizedError } from '@ghostfolio/common/helper';
import { UserDashboardLayout } from '@ghostfolio/common/interfaces';
import { DataService } from '@ghostfolio/ui/services';

import { DestroyRef, Injectable, OnDestroy } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ObservableStore } from '@codewithdan/observable-store';
import { BehaviorSubject, Observable, Subject, of, throwError } from 'rxjs';
import {
  catchError,
  debounceTime,
  filter,
  map,
  switchMap
} from 'rxjs/operators';

import { DashboardLayoutItem } from '../interfaces/interfaces';
import { DashboardLayoutStoreActions } from './dashboard-layout-store.actions';
import { DashboardLayoutStoreState } from './dashboard-layout-store.state';

/**
 * One snapshot of the canvas, stamped with the identity it belongs to.
 *
 * The stamp is the whole point. A write is authorised by whichever bearer token
 * happens to be in storage when the request is finally created, and that is
 * several hundred milliseconds after the arrangement was reported - long enough
 * for the token to have been replaced by signing in, signing out or creating an
 * account. Carrying the originating identity alongside the arrangement is what
 * lets the dispatch refuse a snapshot that would otherwise be written to
 * somebody else's account.
 */
/**
 * One complete arrangement, projected and attributed at the moment it changed.
 *
 * `layout` is the finished request body rather than the grid's own item array,
 * because the grid rewrites those items in place; `userId` is the viewer it
 * belongs to, which the dispatch re-checks after the debounce.
 */
interface DashboardLayoutSnapshot {
  layout: UpdateUserDashboardLayoutDto;
  userId: string;
}

@Injectable({
  providedIn: 'root'
})
export class GfDashboardLayoutService
  extends ObservableStore<DashboardLayoutStoreState>
  implements OnDestroy
{
  /**
   * Announces that the identity layout work belongs to is being replaced.
   *
   * Exposed read-only, and emitted only by {@link beginIdentityTransition} -
   * never by {@link adoptIdentity}, whose caller has by definition already
   * quiesced whatever it owns. A subscriber's obligation is to stop producing
   * arrangements and to discard the one it is holding, because neither belongs
   * to the identity that is arriving.
   *
   * Backed by a plain `Subject`: a transition is an event, and replaying a spent
   * one to a late subscriber would suspend a canvas that is already correct.
   */
  public identityTransition$: Observable<void>;

  /**
   * The identity writes are currently authorised for, or `null` while none is.
   *
   * `null` is the safe default and the state a transition returns to, so a
   * snapshot produced between a token being replaced and the new viewer being
   * adopted is refused rather than misattributed.
   */
  private activeUserId: string = null;

  /**
   * Whether the most recent write attempt failed and its snapshot is still
   * waiting to be persisted.
   *
   * Exposed so the canvas can tell the viewer that their arrangement is not
   * saved, which is the whole point of retaining the snapshot: a silent failure
   * would leave them believing a layout they can still see had been stored.
   * Cleared by the next successful write, from whichever attempt produces it,
   * and by an identity change - which discards the snapshot outright, so there
   * is nothing left to warn about.
   */
  private hasSaveError$ = new BehaviorSubject<boolean>(false);

  /**
   * Whether the cached arrangement belongs to the viewer currently adopted.
   *
   * Held explicitly rather than inferred from the store, because the store cannot
   * express "no longer valid": `setState({ layout: undefined })` is deep-cloned on
   * the way in and a deep clone drops an `undefined` member, so the stale value
   * survives and `get()` would serve one viewer's arrangement - or one viewer's
   * *absence* of an arrangement, which is what opens the catalog - to the next.
   */
  private hasCachedLayout = false;

  private identityTransitionSubject = new Subject<void>();

  /**
   * The newest snapshot that has not yet been acknowledged by the server.
   *
   * Holds the already-projected request body together with the identity it was
   * produced under, and both halves are essential. The projection is taken the
   * instant a change is reported, because the grid mutates its items in place
   * during a drag, so a retained reference to that array would silently mean
   * something different by the time it was replayed. The identity travels with
   * it because the write happens after a debounce, by which time the token that
   * would authorise it may belong to somebody else.
   *
   * Retained until a write SUCCEEDS - not until one is dispatched - so a failed
   * write leaves the latest arrangement recoverable, both for an explicit retry
   * and for the teardown flush. The one exception is an identity change, which
   * discards it: it describes a canvas that is no longer on screen, and offering
   * a retry for it would write one viewer's arrangement to another's account.
   */
  private pendingSnapshot: DashboardLayoutSnapshot = null;

  /**
   * The one channel every layout write travels down.
   *
   * Carries the projected request body rather than grid items, so the debounce,
   * the retry and the teardown flush all operate on exactly the same immutable
   * value and there is no second place a body can be built.
   */
  private snapshot$ = new Subject<DashboardLayoutSnapshot>();

  public constructor(
    private dataService: DataService,
    private destroyRef: DestroyRef
  ) {
    super({ trackStateHistory: true });

    this.identityTransition$ = this.identityTransitionSubject.asObservable();

    this.setState(
      { layout: undefined },
      DashboardLayoutStoreActions.Initialize
    );

    this.snapshot$
      .pipe(
        debounceTime(500),
        // The identity is re-checked *here*, after the debounce, rather than
        // where the snapshot was accepted. The check has to happen as late as
        // possible, because the window it closes is precisely the one the
        // debounce opens: the request is authorised by whichever token is in
        // storage at the moment it is created, so an arrangement reported by one
        // viewer must not be sent once another viewer is the one it would be
        // written for. A refused snapshot is discarded rather than deferred - it
        // describes a canvas that is no longer on screen - which is also what
        // stops it being offered to {@link retryFailedSave} afterwards.
        map((snapshot) => {
          if (this.isAuthorizedIdentity(snapshot.userId)) {
            return snapshot;
          }

          this.discardSnapshot(snapshot);

          return null;
        }),
        // Narrowed with a type guard rather than a bare predicate, so the
        // switched request below receives a snapshot and never a `null`.
        filter((snapshot): snapshot is DashboardLayoutSnapshot => !!snapshot),
        switchMap((snapshot) =>
          this.dataService.patchUserDashboardLayout(snapshot.layout).pipe(
            // Paired with the snapshot that produced it, so the subscriber can
            // tell whether the write that just succeeded is the one still
            // outstanding or a superseded attempt.
            map((layout) => ({ layout, snapshot })),
            // Caught inside the `switchMap` on purpose. An error allowed to reach
            // the outer pipe would terminate it, and a terminated pipe silently
            // stops saving for the rest of the session, so a single transient
            // failure would cost the viewer every later change they made.
            catchError((error) => {
              reportSanitizedError('GF-DASHBOARD-LAYOUT-PERSIST-FAILED', error);

              // Published, not merely logged. The snapshot is left exactly where
              // it is so the arrangement stays recoverable, and this is the only
              // channel that tells the canvas to offer the retry that recovers
              // it - without it the viewer is left believing an arrangement they
              // can still see had been stored.
              this.hasSaveError$.next(true);

              return of(null);
            })
          )
        ),
        takeUntilDestroyed(this.destroyRef)
      )
      .subscribe((result) => {
        if (!result) {
          return;
        }

        // Checked a second time, after the response. `switchMap` cancels an
        // in-flight write only when a newer one supersedes it, so a reply that
        // belongs to the previous viewer can still arrive after an identity
        // change - and caching it would serve one viewer's arrangement to
        // another out of this store.
        if (!this.isAuthorizedIdentity(result.snapshot.userId)) {
          return;
        }

        // Only the acknowledged snapshot is retired, and it is compared by
        // identity: a newer one scheduled while this write was in flight is a
        // different object, so clearing on anything else would discard an
        // arrangement the server has never seen.
        if (this.pendingSnapshot === result.snapshot) {
          this.clearPendingSnapshot();
        }

        if (result.layout) {
          this.setState(
            { layout: result.layout },
            DashboardLayoutStoreActions.UpdateDashboardLayout
          );
        }
      });
  }

  /**
   * Authorises layout writes for a resolved viewer.
   *
   * Idempotent for the identity already held, so it can be called on every
   * emission of the viewer store without consequence. Adopting a *different*
   * identity discards whatever the previous one left pending, for the same
   * reason the dispatch check exists: that work describes an arrangement this
   * viewer never made.
   *
   * Deliberately silent on {@link identityTransition$}. The only caller is the
   * canvas, at the point it is already invalidating what it holds, and emitting
   * here would ask it to do that work twice.
   */
  public adoptIdentity(userId: string) {
    if (userId === this.activeUserId) {
      return;
    }

    this.clearPendingSnapshot();

    this.hasCachedLayout = false;

    this.activeUserId = userId;
  }

  /**
   * Withdraws write authorisation ahead of an identity change, and announces
   * it.
   *
   * Called before a bearer token is replaced - creating an account, signing in,
   * signing out - so that the interval between the new token being stored and
   * the new viewer being resolved cannot produce a write at all. Writes stay
   * refused until {@link adoptIdentity} names the viewer that arrived, which is
   * what makes "reopen writes only after hydration" structural rather than a
   * matter of timing.
   *
   * The read cache is deliberately left alone. `ObservableStore` deep-clones
   * state and drops `undefined` in the process, so the not-yet-fetched sentinel
   * cannot be written back; the canvas instead forces its re-read, which
   * bypasses the cache outright, and before its first read there is nothing
   * cached to bypass.
   */
  public beginIdentityTransition() {
    this.clearPendingSnapshot();

    this.hasCachedLayout = false;

    this.activeUserId = null;

    this.identityTransitionSubject.next();
  }

  public get(force = false): Observable<UserDashboardLayout | null> {
    const state = this.getState();

    // Both conditions are required. The sentinel test keeps "not yet fetched"
    // (`undefined`) apart from "fetched and absent" (`null`), so a brand-new
    // viewer's missing row is cached rather than re-read on every access; the
    // validity flag additionally ties that cache to the viewer it was read for.
    if (this.hasCachedLayout && state?.layout !== undefined && force !== true) {
      // Get from cache
      return of(state.layout);
    }

    return this.fetchLayout();
  }

  /**
   * Whether the arrangement currently on screen has failed to persist.
   *
   * A stream rather than a flag so the canvas can react without polling, and
   * read-only so that only a write outcome can change it.
   */
  public getHasSaveError(): Observable<boolean> {
    return this.hasSaveError$.asObservable();
  }

  public ngOnDestroy() {
    this.flushPendingSnapshot();
  }

  /**
   * Persists the snapshot whose write most recently failed.
   *
   * Re-entered through the same subject every other write uses, so there is
   * still exactly one origin, one debounce and one request builder - and the
   * identity check the dispatch applies is applied to a retry too. Does nothing
   * when there is nothing outstanding, which makes it safe to call from a retry
   * affordance that may be pressed twice.
   */
  public retryFailedSave() {
    if (!this.pendingSnapshot) {
      return;
    }

    this.snapshot$.next(this.pendingSnapshot);
  }

  /**
   * Accepts one complete arrangement for later persistence.
   *
   * @param userId the viewer the arrangement belongs to. Required, and verified
   * again at dispatch: an arrangement whose identity no longer holds write
   * authorisation is discarded rather than sent. It never reaches the wire - the
   * request body is the five-field projection in {@link createLayoutDto} and
   * nothing else, because the server derives identity from the request itself.
   * @param modules the whole canvas, every time.
   */
  public scheduleSave(userId: string, modules: DashboardLayoutItem[]) {
    // Projected here rather than after the debounce, so what is queued is a
    // record of the arrangement at the instant it changed and cannot be altered
    // afterwards by the grid writing new coordinates onto its own items.
    this.pendingSnapshot = { layout: this.createLayoutDto(modules), userId };

    this.snapshot$.next(this.pendingSnapshot);
  }

  /**
   * Forgets the outstanding snapshot, and with it the failure warning.
   *
   * The dispatch, the retry and the teardown flush all read the same member, so
   * clearing it in one place is what keeps "already written", "discarded on an
   * identity change" and "never scheduled" indistinguishable to everything
   * downstream - each of them means there is nothing left to flush.
   */
  private clearPendingSnapshot() {
    this.pendingSnapshot = null;

    this.hasSaveError$.next(false);
  }

  private createLayoutDto(
    modules: DashboardLayoutItem[]
  ): UpdateUserDashboardLayoutDto {
    return {
      modules: (modules ?? []).map(({ cols, moduleType, rows, x, y }) => ({
        cols,
        moduleType,
        rows,
        x,
        y
      })),
      version: 1
    };
  }

  /**
   * Drops a snapshot that may already have been superseded.
   *
   * Compared by identity rather than cleared outright, because a newer
   * arrangement - reported by whoever is signed in now - may already be waiting,
   * and discarding a refused snapshot must not take that one with it.
   */
  private discardSnapshot(snapshot: DashboardLayoutSnapshot) {
    if (this.pendingSnapshot === snapshot) {
      this.clearPendingSnapshot();
    }
  }

  private fetchLayout(): Observable<UserDashboardLayout | null> {
    return this.dataService.fetchUserDashboardLayout().pipe(
      map((layout) => {
        this.hasCachedLayout = true;

        this.setState(
          { layout },
          DashboardLayoutStoreActions.GetDashboardLayout
        );

        return layout;
      }),
      catchError((error) => this.handleError(error))
    );
  }

  private flushPendingSnapshot() {
    // The identity check is the same one the debounced dispatch applies, and it
    // belongs here for the same reason: destruction is one of the ways an
    // identity ends, so the snapshot being flushed may already belong to a
    // viewer who is no longer the one this request would be authorised as.
    const snapshot = this.pendingSnapshot;

    this.clearPendingSnapshot();

    if (!snapshot || !this.isAuthorizedIdentity(snapshot.userId)) {
      return;
    }

    // Closing the browser tab inside the debounce is an accepted loss window.
    this.dataService.patchUserDashboardLayout(snapshot.layout).subscribe({
      error: (error) => {
        reportSanitizedError('GF-DASHBOARD-LAYOUT-FLUSH-FAILED', error);
      }
    });
  }

  private handleError(error: unknown) {
    reportSanitizedError('GF-DASHBOARD-LAYOUT-FETCH-FAILED', error);

    // Rethrown rather than absorbed into an empty layout. A failed read is not a
    // viewer with nothing saved, and the canvas relies on the difference: it
    // opens the module catalog for the second and must not for the first.
    return throwError(() => error);
  }

  /**
   * Whether a snapshot may be written as the identity it was produced under.
   *
   * An absent identity on either side never matches, so a snapshot scheduled
   * before a viewer resolved, and any snapshot at all while a transition is in
   * flight, is refused rather than treated as belonging to nobody in particular.
   */
  private isAuthorizedIdentity(userId: string): boolean {
    return !!userId && userId === this.activeUserId;
  }
}
