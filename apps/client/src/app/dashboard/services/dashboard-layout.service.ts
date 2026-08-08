import type { UpdateUserDashboardLayoutDto } from '@ghostfolio/common/dtos';
import { reportSanitizedError } from '@ghostfolio/common/helper';
import {
  DashboardModuleLayoutItem,
  UserDashboardLayout
} from '@ghostfolio/common/interfaces';
import { DataService } from '@ghostfolio/ui/services';

import { DestroyRef, Injectable, OnDestroy } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ObservableStore } from '@codewithdan/observable-store';
import {
  AsyncSubject,
  BehaviorSubject,
  Observable,
  Subject,
  merge,
  of,
  throwError
} from 'rxjs';
import {
  catchError,
  concatMap,
  debounceTime,
  filter,
  map,
  take,
  timeout
} from 'rxjs/operators';

import { DashboardLayoutStoreActions } from './dashboard-layout-store.actions';
import { DashboardLayoutStoreState } from './dashboard-layout-store.state';

// A drag crosses many cells and the grid reports every one of them, so the
// window is what turns one gesture into one request. It is also the accepted
// loss window: a viewer who closes the tab inside it loses that last change,
// while every exit the application itself drives releases the window instead of
// waiting it out.
const SAVE_DEBOUNCE_IN_MS = 500;

/**
 * One complete arrangement, projected and attributed at the moment it changed.
 *
 * `layout` is the finished request body rather than the grid's own item array,
 * because the grid rewrites those items in place. `userId` is the stamp that
 * matters: a write is authorised by whichever bearer token is in storage when
 * the request is finally created, which is several hundred milliseconds after
 * the arrangement was reported - long enough for the token to have been
 * replaced by signing in, signing out or creating an account. Carrying the
 * originating identity is what lets the dispatch refuse a snapshot that would
 * otherwise be written to somebody else's account.
 */
interface DashboardLayoutSnapshot {
  layout: UpdateUserDashboardLayoutDto;
  userId: string;
}

/**
 * How one snapshot's turn at the dispatcher ended, paired with the snapshot
 * itself so the subscriber can tell an acknowledgement of the arrangement still
 * outstanding from one that has since been superseded.
 *
 * Produced for EVERY snapshot the dispatcher takes, including the ones it
 * declines to send, which is what makes it usable as a completion signal: a
 * caller waiting on a particular snapshot is released whether it was written,
 * skipped as superseded, refused as unauthorised or failed.
 *
 * `error` present means the write was attempted and failed; `layout` present
 * means the server acknowledged one; neither present means it was never sent.
 */
interface DashboardLayoutWriteResult {
  error?: unknown;
  layout?: UserDashboardLayout;
  snapshot: DashboardLayoutSnapshot;
}

// Held so that a second request to flush the SAME arrangement joins the first
// rather than queueing a duplicate behind it: the two callers that flush are
// both on their way out of the document, and either may be reached twice.
interface DashboardLayoutFlush {
  completion: AsyncSubject<void>;
  snapshot: DashboardLayoutSnapshot;
}

// A bound rather than an unbounded wait, because the callers that await a flush
// are about to leave the document and `HttpClient` imposes no deadline of its
// own. Expiry is reported to the caller as a failure, so the viewer is told
// their arrangement may not have been stored. A genuine backstop rather than an
// ordinary outcome, and that rests on the dispatcher announcing a result for
// every snapshot it takes - including the ones it skips as superseded - so
// reaching this bound means a request really did go unanswered.
const FLUSH_TIMEOUT = 5000;

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
   * Emitted only by {@link beginIdentityTransition} - never by {@link
   * adoptIdentity}, whose caller has by definition already quiesced whatever it
   * owns. A subscriber's obligation is to stop producing arrangements and to
   * discard the one it is holding.
   *
   * Backed by a plain `Subject`: replaying a spent transition to a late
   * subscriber would suspend a canvas that is already correct.
   */
  public identityTransition$: Observable<void>;

  // `null` is the safe default and the state a transition returns to, so a
  // snapshot produced between a token being replaced and the new viewer being
  // adopted is refused rather than misattributed.
  private activeUserId: string = null;

  // Exposed so the canvas can tell the viewer that their arrangement is not
  // saved, which is the whole point of retaining the snapshot. Cleared by the
  // next successful write and by an identity change, which discards the
  // snapshot outright.
  private hasSaveError$ = new BehaviorSubject<boolean>(false);

  // Held explicitly rather than inferred from the store, because the store
  // cannot express "no longer valid": `setState({ layout: undefined })` is
  // deep-cloned on the way in and a deep clone drops an `undefined` member, so
  // the stale value would survive and `get()` would serve one viewer's
  // arrangement - or one viewer's *absence* of one, which is what opens the
  // catalog - to the next.
  private hasCachedLayout = false;

  private identityTransitionSubject = new Subject<void>();

  // Cleared as soon as its snapshot settles, so a later flush of a genuinely
  // newer arrangement is never mistaken for one already under way.
  private pendingFlush: DashboardLayoutFlush = null;

  // The newest arrangement not yet acknowledged by the server, retained until a
  // write SUCCEEDS rather than until one is dispatched - so a failed write
  // leaves the latest arrangement recoverable both for an explicit retry and
  // for the release before a departure, and neither of those needs a body of
  // its own. An identity change is the one thing that discards it, because it
  // describes a canvas that is no longer on screen.
  private pendingSnapshot: DashboardLayoutSnapshot = null;

  // The one channel every layout write travels down. It carries the projected
  // request body rather than grid items, so the debounce, the retry and the
  // release before a departure all operate on the same immutable value and
  // there is no second place a body can be built.
  private snapshot$ = new Subject<DashboardLayoutSnapshot>();

  // The same channel entered past the debounce: a LANE, not a second write
  // origin. It joins {@link snapshot$} before the serialised dispatch, so a
  // flushed arrangement is queued behind whatever is in flight, screened by the
  // same identity check and sent by the same request builder. Bypassing the
  // debounce is the entire reason it is a separate subject - emitting onto
  // {@link snapshot$} would merely restart the quiet period a departing caller
  // cannot wait out.
  private immediateSnapshot$ = new Subject<DashboardLayoutSnapshot>();

  // Announced for every snapshot the dispatcher takes, so a caller holding one
  // can be told what became of it. It carries no request and builds no body,
  // which is what lets a flush be awaited without introducing a second way to
  // write a layout. A plain `Subject`: replaying a spent outcome to a later
  // flush would resolve it against a write that was not its own.
  private writeOutcome$ = new Subject<DashboardLayoutWriteResult>();

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

    // Two lanes, one dispatcher. The debounced lane carries every ordinary
    // change; the immediate lane carries a flush, which is the same arrangement
    // asked to leave now instead of at the end of its quiet period. They are
    // merged BEFORE the serialisation below, which is what keeps a flush inside
    // the single write path: it takes its turn in the same queue rather than
    // opening a second one. A flush that issued its own request could commit
    // before an older request already in flight, and the older reply would then
    // restore the geometry the viewer had just moved away from.
    merge(
      this.snapshot$.pipe(
        debounceTime(SAVE_DEBOUNCE_IN_MS),

        // A snapshot the immediate lane has already taken must not be sent
        // again when its own quiet period finally elapses. `pendingFlush` names
        // exactly that arrangement, and only while its release is unsettled, so
        // this drops the duplicate without ever dropping an ordinary change.
        filter((snapshot) => this.pendingFlush?.snapshot !== snapshot)
      ),
      this.immediateSnapshot$
    )
      .pipe(
        // `concatMap`, so each snapshot's turn begins only once the previous
        // one has settled. The alternative is unsafe rather than merely untidy:
        // `switchMap` would unsubscribe from a superseded request, and
        // unsubscribing from `HttpClient` withdraws only the CLIENT's interest
        // in the reply. A request the server has already accepted goes on to
        // commit regardless, so the newer arrangement could be written first
        // and the abandoned older one land on top of it. Complete bodies cannot
        // rescue that: completeness only says the LAST write wins, not which
        // write is last. Queueing does not mean sending stale bodies.
        // `dispatchSnapshot` skips any snapshot that is no longer {@link
        // pendingSnapshot} when its turn comes, so a burst of drags costs one
        // request for the newest arrangement plus a synchronous skip for each
        // one it replaced - and the skip still announces an outcome, so nothing
        // waiting on a superseded snapshot is left waiting.
        concatMap((snapshot) => this.dispatchSnapshot(snapshot)),
        takeUntilDestroyed(this.destroyRef)
      )
      .subscribe((result) => {
        this.settleWriteResult(result);

        // Announced LAST, deliberately. A caller awaiting a flush acts the
        // moment it hears - signing out clears the token and replaces the
        // document - so everything this service owes the outcome is already
        // recorded by then.
        this.writeOutcome$.next(result);
      });
  }

  /**
   * Authorises layout writes for a resolved viewer.
   *
   * Idempotent for the identity already held, so it can be called on every
   * emission of the viewer store. Adopting a *different* identity discards
   * whatever the previous one left pending, for the same reason the dispatch
   * check exists: that work describes an arrangement this viewer never made.
   *
   * Deliberately silent on {@link identityTransition$}: the only caller is the
   * canvas, at the point it is already invalidating what it holds.
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
   * signing out - so the interval between the new token being stored and the
   * new viewer being resolved cannot produce a write at all. Writes stay
   * refused until {@link adoptIdentity} names the viewer that arrived, which is
   * what makes reopening writes only after hydration structural rather than a
   * matter of timing.
   *
   * The read cache is deliberately left alone: `ObservableStore` deep-clones
   * state and drops `undefined`, so the not-yet-fetched sentinel cannot be
   * written back. The canvas forces its re-read instead, which bypasses the
   * cache outright.
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
      return of(state.layout);
    }

    return this.fetchLayout();
  }

  public getHasSaveError(): Observable<boolean> {
    return this.hasSaveError$.asObservable();
  }

  public ngOnDestroy() {
    this.releasePendingSave();
  }

  /**
   * Releases the outstanding arrangement immediately instead of waiting the
   * debounce window out.
   *
   * Signing out is the case that matters: it replaces the whole document rather
   * than routing within it, so nothing downstream of that call runs and a
   * change made in the last {@link SAVE_DEBOUNCE_IN_MS} milliseconds would be
   * dropped with no request, no error and no retry. That is NOT the loss window
   * this design accepts.
   *
   * It is emphatically not a write path, and that is structural: it builds no
   * request body, calls no facade method and reaches no HTTP client. It hands
   * the arrangement the grid already produced to {@link immediateSnapshot$},
   * which joins the ordinary channel before the one dispatcher.
   *
   * The pending snapshot is deliberately not cleared here. It is retired only
   * by an acknowledgement, so a departure whose write fails leaves the
   * arrangement recoverable through the retry the canvas offers.
   *
   * @returns a stream that completes once the released arrangement has settled
   * and errors if its write failed or did not answer within {@link
   * FLUSH_TIMEOUT}. Ignoring it is safe, because the arrangement is enqueued
   * either way. Asking twice for the same arrangement joins the release already
   * under way.
   */
  public releasePendingSave(): Observable<void> {
    return this.enqueueImmediateWrite().pipe(timeout({ each: FLUSH_TIMEOUT }));
  }

  // Re-entered through the same subject every other write uses, so there is
  // still exactly one origin, one debounce and one request builder.
  // Deliberately does not release the debounce: a retry is a considered act
  // rather than a departure, which is also what coalesces a viewer who presses
  // it twice.
  public retryFailedSave() {
    if (!this.pendingSnapshot) {
      return;
    }

    this.snapshot$.next(this.pendingSnapshot);
  }

  /**
   * Accepts one complete arrangement for later persistence.
   *
   * @param userId the viewer the arrangement belongs to. Verified again at
   * dispatch, and never sent: the request body is the five-field projection in
   * {@link createLayoutDto} and nothing else, because the server derives
   * identity from the request itself.
   * @param modules the whole arrangement, every time. Declared as the persisted
   * five-field shape rather than as a grid item, because the caller's complete
   * arrangement is not necessarily all on the canvas: a module the viewer is
   * not currently entitled to see holds a saved position and no grid cell, and
   * a snapshot that omitted it would delete it from the stored document.
   */
  public scheduleSave(userId: string, modules: DashboardModuleLayoutItem[]) {
    // Projected here rather than after the debounce, so what is queued is a
    // record of the arrangement at the instant it changed and cannot be altered
    // afterwards by the grid writing new coordinates onto its own items.
    this.pendingSnapshot = { layout: this.createLayoutDto(modules), userId };

    this.snapshot$.next(this.pendingSnapshot);
  }

  private clearPendingSnapshot() {
    this.pendingSnapshot = null;

    this.hasSaveError$.next(false);
  }

  private createLayoutDto(
    modules: DashboardModuleLayoutItem[]
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
   * Sends one snapshot, or declines to. Reached only from the serialised
   * dispatch above, one snapshot at a time, and that is what both checks depend
   * on: a snapshot can wait here behind an in-flight write, so neither question
   * can be answered before it is queued.
   *
   * **Superseded while queued.** {@link pendingSnapshot} is always the newest
   * arrangement reported, so a queued snapshot that is no longer it has been
   * replaced by one waiting behind it. Every snapshot carries the entire
   * arrangement, so sending the older one would put a document on the wire that
   * the very next request contradicts.
   *
   * **No longer authorised.** A write is authorised by whichever bearer token
   * is in storage when the request is created, and a queued snapshot may have
   * been produced by a viewer since replaced. Such a snapshot is discarded
   * rather than deferred, which is also what stops it being offered to {@link
   * retryFailedSave}.
   *
   * A skip still emits a result carrying neither a layout nor an error, because
   * two readers depend on hearing it: the subscriber must not retire a snapshot
   * it never wrote, and a flush waiting on this snapshot has to be released
   * rather than left waiting for a request that was never going to be made.
   */
  private dispatchSnapshot(
    aSnapshot: DashboardLayoutSnapshot
  ): Observable<DashboardLayoutWriteResult> {
    if (aSnapshot !== this.pendingSnapshot) {
      return of({ snapshot: aSnapshot });
    }

    if (!this.isAuthorizedIdentity(aSnapshot.userId)) {
      this.discardSnapshot(aSnapshot);

      return of({ snapshot: aSnapshot });
    }

    // The ONE place a layout is written. Every trigger - the four grid
    // callbacks through the debounce, an explicit retry, and a flush through
    // the immediate lane - arrives here, one snapshot at a time, so the last
    // document the server commits is by construction the last one the viewer
    // reported.
    return this.dataService.patchUserDashboardLayout(aSnapshot.layout).pipe(
      map((layout) => ({ layout, snapshot: aSnapshot })),

      // Caught inside the projected observable on purpose. An error allowed to
      // reach the outer pipe would terminate it, and a terminated pipe silently
      // stops saving for the rest of the session.
      catchError((error: unknown) => {
        reportSanitizedError('GF-DASHBOARD-LAYOUT-PERSIST-FAILED', error);

        // Published, not merely logged. The snapshot is left exactly where it
        // is so the arrangement stays recoverable, and this is the only channel
        // that tells the canvas to offer the retry that recovers it.
        this.hasSaveError$.next(true);

        // Carried on the result rather than rethrown, so the failure reaches a
        // caller awaiting this particular snapshot without terminating the
        // dispatcher every other write depends on.
        return of({ error, snapshot: aSnapshot });
      })
    );
  }

  // Compared by identity rather than cleared outright, because a newer
  // arrangement - reported by whoever is signed in now - may already be
  // waiting, and discarding a refused snapshot must not take that one with it.
  private discardSnapshot(snapshot: DashboardLayoutSnapshot) {
    if (this.pendingSnapshot === snapshot) {
      this.clearPendingSnapshot();
    }
  }

  /**
   * Puts the outstanding arrangement at the front of the one write queue and
   * hands back its outcome. The enqueue is eager and independent of the
   * returned stream, so the arrangement leaves whether or not anybody
   * subscribes.
   *
   * The outcome subscription is established BEFORE the arrangement is enqueued:
   * the dispatcher can settle a snapshot synchronously - it does so for one it
   * declines to send - and an outcome announced before anything was listening
   * would leave the caller waiting on a snapshot that had already been dealt
   * with.
   *
   * @returns a stream that completes when the arrangement settles and errors
   * when its write failed. Completes immediately when there is nothing
   * outstanding.
   */
  private enqueueImmediateWrite(): Observable<void> {
    const snapshot = this.pendingSnapshot;

    if (!snapshot) {
      return of(undefined);
    }

    // The same arrangement is already on its way. Joining that flush rather
    // than enqueueing a second one is what makes asking twice - a control
    // pressed twice, or a control followed by the teardown it causes - cost one
    // request.
    if (this.pendingFlush?.snapshot === snapshot) {
      return this.pendingFlush.completion.asObservable();
    }

    const completion = new AsyncSubject<void>();
    const flush: DashboardLayoutFlush = { completion, snapshot };

    this.pendingFlush = flush;

    this.writeOutcome$
      .pipe(
        // By identity, so an outcome belonging to some other arrangement - one
        // scheduled before this flush and still queued - cannot release it.
        filter((result) => result.snapshot === snapshot),
        take(1)
      )
      .subscribe(({ error }) => {
        if (this.pendingFlush === flush) {
          this.pendingFlush = null;
        }

        if (error === undefined) {
          // `AsyncSubject`, so the outcome is replayed to a caller that
          // subscribes after it arrived rather than being lost to a race with
          // its own enqueue.
          completion.next();
          completion.complete();
        } else {
          completion.error(error);
        }
      });

    this.immediateSnapshot$.next(snapshot);

    return completion.asObservable();
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

  private handleError(error: unknown) {
    reportSanitizedError('GF-DASHBOARD-LAYOUT-FETCH-FAILED', error);

    // Rethrown rather than absorbed into an empty layout. A failed read is not
    // a viewer with nothing saved, and the canvas relies on the difference: it
    // opens the module catalog for the second and must not for the first.
    return throwError(() => error);
  }

  // An absent identity on either side never matches, so a snapshot scheduled
  // before a viewer resolved - and any snapshot at all while a transition is in
  // flight - is refused rather than treated as belonging to nobody in
  // particular.
  private isAuthorizedIdentity(userId: string): boolean {
    return !!userId && userId === this.activeUserId;
  }

  private settleWriteResult(aResult: DashboardLayoutWriteResult) {
    // Checked again, after the response. An identity can change while a write
    // is in flight, so a reply belonging to the previous viewer can still
    // arrive afterwards - and caching it would serve one viewer's arrangement
    // to another out of this store.
    if (!this.isAuthorizedIdentity(aResult.snapshot.userId)) {
      return;
    }

    if (
      // Only an ACKNOWLEDGED snapshot is retired, compared by identity: a newer
      // one scheduled while this write was in flight is a different object, so
      // clearing on anything else would discard an arrangement the server has
      // never seen.
      aResult.error === undefined &&
      this.pendingSnapshot === aResult.snapshot
    ) {
      this.clearPendingSnapshot();
    }

    if (aResult.layout) {
      this.setState(
        { layout: aResult.layout },
        DashboardLayoutStoreActions.UpdateDashboardLayout
      );
    }
  }
}
