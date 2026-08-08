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

/**
 * The quiet period a reported arrangement waits out before it is written.
 *
 * A drag crosses many cells and the grid reports every one of them, so the window
 * is what turns one gesture into one request. It is also the accepted loss window:
 * a viewer who closes the tab inside it loses that last change, which nothing this
 * application can observe would prevent - every exit the application itself drives
 * releases the window instead of waiting it out.
 */
const SAVE_DEBOUNCE_IN_MS = 500;

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

/**
 * How one snapshot's turn at the dispatcher ended, paired with the snapshot
 * itself.
 *
 * The pairing is what lets the subscriber tell an acknowledgement of the
 * arrangement still outstanding from an acknowledgement of one that has since
 * been superseded, so only the former retires the pending snapshot.
 *
 * Produced for EVERY snapshot the dispatcher takes, including the ones it
 * declines to send, and that is what makes it usable as a completion signal: a
 * caller waiting on a particular snapshot must be released whether it was
 * written, skipped as superseded, refused as unauthorised or failed - never left
 * waiting on a request that was never going to be made.
 *
 * `error` present means the write was attempted and failed. `layout` present
 * means the server acknowledged one. Neither present means the dispatcher
 * declined to send this snapshot at all.
 */
interface DashboardLayoutWriteResult {
  error?: unknown;
  layout?: UserDashboardLayout;
  snapshot: DashboardLayoutSnapshot;
}

/**
 * One flush still waiting for its snapshot to settle.
 *
 * Held so that a second request to flush the SAME arrangement joins the first
 * rather than queueing a duplicate request behind it: the two callers that flush
 * are both on their way out of the document, and either may be reached twice.
 */
interface DashboardLayoutFlush {
  completion: AsyncSubject<void>;
  snapshot: DashboardLayoutSnapshot;
}

/**
 * How long a caller awaiting a flush waits before giving up on it.
 *
 * A bound rather than an unbounded wait, because the callers that await one are
 * about to leave the document: signing out is held open until the write settles,
 * and `HttpClient` imposes no deadline of its own, so a request that never
 * answers would leave the viewer pressing a control that appears to do nothing.
 * Generous enough that it expires only when something is genuinely wrong, and
 * expiry is reported to the caller as a failure rather than as a success, so the
 * viewer is told their arrangement may not have been stored.
 *
 * A genuine backstop rather than an ordinary outcome, and that rests on the
 * dispatcher announcing a result for EVERY snapshot it takes - including the ones
 * it skips as superseded. Nothing in the write path abandons a snapshot silently,
 * so reaching this bound means a request really did go unanswered rather than
 * that the arrangement was overtaken while it waited.
 */
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
   * The flush currently waiting on the dispatcher, or `null` when none is.
   *
   * Retained so that {@link releasePendingSave} can hand a second caller the
   * completion the first one is already waiting on. Both callers are leaving the
   * document and either may be reached twice - a control pressed twice, or a
   * control followed by the teardown that control causes - and without this each
   * would queue its own request for an arrangement that has not changed.
   *
   * Cleared as soon as its snapshot settles, so a later flush of a genuinely
   * newer arrangement is never mistaken for one already under way.
   */
  private pendingFlush: DashboardLayoutFlush = null;

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
   * and for the release before a departure. It is also what either of those
   * re-enters the pipeline with, which is why neither needs a body of its own. The
   * one exception is an identity change, which discards it: it describes a canvas
   * that is no longer on screen, and offering a retry for it would write one
   * viewer's arrangement to another's account.
   */
  private pendingSnapshot: DashboardLayoutSnapshot = null;

  /**
   * The one channel every layout write travels down.
   *
   * Carries the projected request body rather than grid items, so the debounce,
   * the retry and the release before a departure all operate on exactly the same
   * immutable value and there is no second place a body can be built.
   */
  private snapshot$ = new Subject<DashboardLayoutSnapshot>();

  /**
   * The same channel, entered past the debounce.
   *
   * A LANE, not a second write origin. It joins {@link snapshot$} before the
   * serialised dispatch below, so a flushed arrangement is queued behind whatever
   * is already in flight, is built by the same projection, is screened by the same
   * identity check and is sent by the same single request builder. All it changes
   * is when the arrangement leaves: now, rather than at the end of a quiet period
   * the caller will not be present for.
   *
   * Bypassing the debounce is the entire reason it exists as a separate subject.
   * Emitting onto {@link snapshot$} would merely restart the 500ms window, which
   * is the opposite of what a departing caller needs.
   */
  private immediateSnapshot$ = new Subject<DashboardLayoutSnapshot>();

  /**
   * How each snapshot's turn at the dispatcher ended.
   *
   * Announced for every snapshot the dispatcher takes, so that a caller holding
   * one can be told what became of it. This carries no request and builds no
   * body - it reports an outcome the single write path has already produced -
   * which is what lets a flush be awaited without introducing a second way to
   * write a layout.
   *
   * A plain `Subject`: an outcome is an event about one particular snapshot, and
   * replaying a spent one to a later flush would resolve it against a write that
   * was not its own.
   */
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
    // opening a second one alongside it. A flush that issued its own request -
    // as this service used to - could commit before an older request that was
    // already in flight, and the older reply would then restore the geometry the
    // viewer had just moved away from.
    merge(
      this.snapshot$.pipe(
        debounceTime(SAVE_DEBOUNCE_IN_MS),
        // A snapshot the immediate lane has already taken must not be sent a
        // second time when its own quiet period finally elapses. `pendingFlush`
        // names exactly that arrangement, and only while its release is still
        // unsettled, so this drops the duplicate without ever dropping an
        // ordinary change.
        filter((snapshot) => this.pendingFlush?.snapshot !== snapshot)
      ),
      this.immediateSnapshot$
    )
      .pipe(
        // `concatMap`, so each snapshot's turn begins only once the previous one
        // has settled. That is what makes the stored document deterministic, and
        // the alternative is genuinely unsafe rather than merely untidy:
        // `switchMap` would unsubscribe from a superseded request, and
        // unsubscribing from `HttpClient` withdraws only the CLIENT's interest in
        // the reply. A request the server has already accepted goes on to commit
        // regardless, so the newer arrangement could be written first and the
        // abandoned older one land on top of it - leaving the row holding a
        // document the viewer had already moved away from, with nothing left in
        // flight to correct it. The completeness of each body cannot rescue that,
        // because completeness only says the LAST write wins; it says nothing
        // about which write is last.
        //
        // Queueing does not mean sending stale bodies. `dispatchSnapshot` skips
        // any snapshot that is no longer {@link pendingSnapshot} by the time its
        // turn comes, so a burst of drags costs exactly one request for the
        // newest arrangement plus a synchronous skip for each one it replaced -
        // and the skip still announces an outcome, so nothing waiting on a
        // superseded snapshot is left waiting for a request that will never be
        // made. The cost is bounded at one round trip of latency for the newest
        // arrangement, which is what buys the ordering guarantee.
        //
        // The 500ms debounce above is unaffected: it is what turns one gesture
        // into one snapshot, and this operator only decides how snapshots that
        // survive it take their turn.
        concatMap((snapshot) => this.dispatchSnapshot(snapshot)),
        takeUntilDestroyed(this.destroyRef)
      )
      .subscribe((result) => {
        this.settleWriteResult(result);

        // Announced LAST, deliberately. A caller awaiting a flush acts the moment
        // it hears - signing out clears the token and replaces the document - so
        // everything this service owes the outcome must already be recorded by the
        // time it is published.
        this.writeOutcome$.next(result);
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

  /**
   * The report is deliberately not subscribed to. Teardown has nothing to
   * sequence and nothing left to update, and the flush issues its request
   * eagerly, so calling it is the whole of the obligation here.
   */
  public ngOnDestroy() {
    // The one release that is deliberately not awaited, because there is nobody
    // left to tell: the injector is going away and a failure has already been
    // reported by the dispatch that attempted it. The write is enqueued by the
    // call itself rather than by subscribing to what it returns, which is what
    // makes ignoring the result safe here and only here.
    //
    // Enqueued through the same lane a signed-out departure uses rather than
    // through a request of its own - one write path, no exceptions. Angular runs
    // provider `ngOnDestroy` hooks before the `DestroyRef` callbacks that end the
    // pipeline above, so the dispatcher is still listening at this point.
    this.releasePendingSave();
  }

  /**
   * Ends the quiet period early for the arrangement still inside it, and reports
   * what became of it.
   *
   * Public because a departure the application itself drives cannot afford to wait
   * the window out. Signing out is the case that matters: it replaces the whole
   * document rather than routing within it, so nothing downstream of that call
   * runs and a change made in the last {@link SAVE_DEBOUNCE_IN_MS} milliseconds
   * would be dropped with no request, no error and no retry. That is NOT the loss
   * window this design accepts - the accepted one is a viewer closing the tab,
   * which the application neither drives nor can observe reliably.
   *
   * It is emphatically NOT a write path, and that is structural rather than
   * asserted. It builds no request body, calls no facade method and reaches no
   * HTTP client; it hands the arrangement the grid already produced to
   * {@link immediateSnapshot$}, which joins the ordinary channel BEFORE the one
   * dispatcher. Everything after that is the pipeline every other write travels:
   * the same projection, the same identity check, the same single call to
   * `patchUserDashboardLayout`. The four grid callbacks therefore remain the only
   * origin an arrangement can come from.
   *
   * The pending snapshot is deliberately NOT cleared here. It is retired only by
   * an acknowledgement, exactly as an ordinary write's is, so a departure whose
   * write fails leaves the arrangement recoverable - through the retry the canvas
   * offers - instead of discarding the viewer's last change on the way out.
   *
   * @returns a stream that completes once the released arrangement has settled and
   * errors if its write failed or did not answer within {@link FLUSH_TIMEOUT}.
   * Awaiting it is what lets a caller hold a departure open until the write is
   * done; ignoring it is safe, because the arrangement is enqueued either way.
   * Asking twice for the same arrangement joins the release already under way
   * rather than queueing a duplicate request. Completes at once when nothing is
   * outstanding, which makes it safe to call from a teardown that follows a
   * control which already released.
   */
  public releasePendingSave(): Observable<void> {
    // Closing the browser tab inside the debounce remains an accepted loss
    // window; every in-application exit now releases instead.
    return this.enqueueImmediateWrite().pipe(timeout({ each: FLUSH_TIMEOUT }));
  }

  /**
   * Persists the snapshot whose write most recently failed.
   *
   * Re-entered through the same subject every other write uses, so there is
   * still exactly one origin, one debounce and one request builder - and the
   * identity check the dispatch applies is applied to a retry too. Does nothing
   * when there is nothing outstanding, which makes it safe to call from a retry
   * affordance that may be pressed twice.
   *
   * Deliberately does not release the debounce. A retry is a considered act rather
   * than a departure, so it waits out the ordinary quiet period like every other
   * write - which is also what coalesces a viewer who presses it twice.
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
   * @param modules the whole arrangement, every time. Declared as the persisted
   * five-field shape rather than as a grid item, because the caller's complete
   * arrangement is not necessarily all on the canvas: a module the viewer is not
   * currently entitled to see holds a saved position and no grid cell, and a
   * snapshot that omitted it would delete it from the stored document.
   */
  public scheduleSave(userId: string, modules: DashboardModuleLayoutItem[]) {
    // Projected here rather than after the debounce, so what is queued is a
    // record of the arrangement at the instant it changed and cannot be altered
    // afterwards by the grid writing new coordinates onto its own items.
    this.pendingSnapshot = { layout: this.createLayoutDto(modules), userId };

    this.snapshot$.next(this.pendingSnapshot);
  }

  /**
   * Forgets the outstanding snapshot, and with it the failure warning.
   *
   * The dispatch, the retry and the release before a departure all read the same
   * member, so clearing it in one place is what keeps "already written",
   * "discarded on an identity change" and "never scheduled" indistinguishable to
   * everything downstream - each of them means there is nothing left to send.
   */
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
   * Sends one snapshot, or declines to.
   *
   * Reached only from the serialised dispatch above, one snapshot at a time, and
   * that is what both checks below depend on: a snapshot can wait here behind an
   * in-flight write for as long as that write takes, so neither question can be
   * answered before it is queued.
   *
   * **Superseded while queued.** {@link pendingSnapshot} is always the newest
   * arrangement reported, so a queued snapshot that is no longer it has already
   * been replaced by one waiting behind it. Every snapshot carries the entire
   * arrangement, so sending the older one would put a document on the wire that
   * the very next request contradicts - and would spend a round trip doing it.
   * Skipping it is not a loss: the newer snapshot describes everything the older
   * one did.
   *
   * **No longer authorised.** The identity check belongs here for the same
   * reason it used to sit immediately after the debounce, only more so. A write
   * is authorised by whichever bearer token is in storage when the request is
   * created, and a queued snapshot may have been produced by a viewer who has
   * since been replaced by signing in, signing out or creating an account. Such a
   * snapshot is discarded rather than deferred - it describes a canvas that is no
   * longer on screen - which is also what stops it being offered to
   * {@link retryFailedSave} afterwards.
   *
   * A skip still emits a result, carrying neither a layout nor an error, because
   * two different readers depend on hearing about it: the subscriber
   * distinguishes "nothing was sent" from "a write succeeded" and must not retire
   * a snapshot it never wrote, and a flush waiting on this snapshot has to be
   * released rather than left waiting for a request that was never going to be
   * made.
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

    // The ONE place a layout is written. Every trigger - the four grid callbacks
    // through the debounce, an explicit retry, and a flush through the immediate
    // lane - arrives here, one snapshot at a time, so the last document the server
    // commits is by construction the last one the viewer reported.
    return this.dataService.patchUserDashboardLayout(aSnapshot.layout).pipe(
      // Paired with the snapshot that produced it, so the subscriber can tell
      // whether the write that just succeeded is the one still outstanding or a
      // superseded attempt.
      map((layout) => ({ layout, snapshot: aSnapshot })),
      // Caught inside the projected observable on purpose. An error allowed to
      // reach the outer pipe would terminate it, and a terminated pipe silently
      // stops saving for the rest of the session, so a single transient failure
      // would cost the viewer every later change they made.
      catchError((error: unknown) => {
        reportSanitizedError('GF-DASHBOARD-LAYOUT-PERSIST-FAILED', error);

        // Published, not merely logged. The snapshot is left exactly where it is
        // so the arrangement stays recoverable, and this is the only channel that
        // tells the canvas to offer the retry that recovers it - without it the
        // viewer is left believing an arrangement they can still see had been
        // stored.
        this.hasSaveError$.next(true);

        // Carried on the result rather than rethrown, so the failure reaches a
        // caller awaiting this particular snapshot without terminating the
        // dispatcher every other write depends on.
        return of({ error, snapshot: aSnapshot });
      })
    );
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

  /**
   * Puts the outstanding arrangement at the front of the one write queue and
   * hands back its outcome.
   *
   * The enqueue is eager and independent of the returned stream: the arrangement
   * leaves whether or not anybody subscribes, which is what lets the teardown
   * ignore the result while signing out awaits it.
   *
   * The outcome subscription is established BEFORE the arrangement is enqueued,
   * deliberately. The dispatcher can settle a snapshot synchronously - it does so
   * for one it declines to send, and it does so under test - and an outcome
   * announced before anything was listening would leave the caller waiting on a
   * snapshot that had already been dealt with.
   *
   * @returns a stream that completes when the arrangement settles and errors when
   * its write failed. Completes immediately when there is nothing outstanding, so
   * a caller need not ask first.
   */
  private enqueueImmediateWrite(): Observable<void> {
    const snapshot = this.pendingSnapshot;

    // Nothing outstanding: already written, discarded on an identity change, or
    // never scheduled. All three mean the caller may proceed at once.
    if (!snapshot) {
      return of(undefined);
    }

    // The same arrangement is already on its way. Joining that flush rather than
    // enqueueing a second one is what makes asking twice - a control pressed
    // twice, or a control followed by the teardown it causes - cost one request.
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
          // `AsyncSubject`, so the outcome is replayed to a caller that subscribes
          // after it arrived rather than being lost to a race with its own
          // enqueue.
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

  /**
   * Records what the dispatcher decided about one snapshot.
   *
   * Split out of the subscription so that settling the state and announcing the
   * outcome are visibly two steps in a fixed order: everything here has happened
   * before any caller awaiting the flush is released.
   */
  private settleWriteResult(aResult: DashboardLayoutWriteResult) {
    // Checked again, after the response. An identity can change while a write is
    // in flight, so a reply that belongs to the previous viewer can still arrive
    // afterwards - and caching it would serve one viewer's arrangement to another
    // out of this store.
    if (!this.isAuthorizedIdentity(aResult.snapshot.userId)) {
      return;
    }

    // Only an ACKNOWLEDGED snapshot is retired, and it is compared by identity: a
    // newer one scheduled while this write was in flight is a different object, so
    // clearing on anything else would discard an arrangement the server has never
    // seen. A failed write leaves it exactly where it is, which is what keeps the
    // arrangement recoverable by the retry and by any later flush.
    if (
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
