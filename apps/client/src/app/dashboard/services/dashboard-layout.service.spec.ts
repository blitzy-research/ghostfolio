import { UpdateUserDashboardLayoutDto } from '@ghostfolio/common/dtos';
import { UserDashboardLayout } from '@ghostfolio/common/interfaces';
import { DataService } from '@ghostfolio/ui/services';

import { HttpErrorResponse } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';
import { ObservableStore } from '@codewithdan/observable-store';
import type { StateHistory } from '@codewithdan/observable-store';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Observable, Subject, of, throwError } from 'rxjs';

import { DashboardModuleType } from '../enums/dashboard-module-type';
import { DashboardLayoutItem } from '../interfaces/interfaces';
import { DashboardLayoutStoreActions } from './dashboard-layout-store.actions';
import type { DashboardLayoutStoreState } from './dashboard-layout-store.state';
import { GfDashboardLayoutService } from './dashboard-layout.service';

/**
 * A burst of triggers inside the debounce window must collapse to one request
 * carrying the newest *complete* snapshot, and an arrangement reported after that
 * must supersede whatever has not yet been sent. Superseding happens at the
 * DISPATCHER rather than by cancelling a request in flight, and the distinction is
 * the whole point: unsubscribing from an HTTP request withdraws only this client's
 * interest in the reply, so a request the server has already accepted goes on to
 * commit and could land after a newer one. Writes are therefore serialised - one
 * request at a time - and a snapshot the queue finds already superseded is skipped
 * instead of sent. The assertions below are written against what the SERVER is
 * left holding and in what order it was asked, never against an RxJS teardown,
 * because a teardown says nothing about a transaction that was already accepted.
 *
 * 1. The wire projection. `DashboardLayoutItem` extends the grid engine's
 *    own item configuration type, which declares fourteen optional members
 *    *and* an index signature, so an item arrives carrying arbitrary extra
 *    properties —
 *    including functions. The API validates with `forbidNonWhitelisted: true`,
 *    which turns a single leaked property into an HTTP 400. Asserting the exact
 *    key set of every projected item is the only mechanical guard that exists.
 * 2. The cache sentinel. The store distinguishes "not yet fetched"
 *    (`undefined`) from "fetched and absent" (`null`). A truthiness-based cache
 *    check would collapse the two and re-fetch on every read for exactly the
 *    brand-new users the feature onboards, because their layout row does not
 *    exist yet.
 * 3. Operator placement. `catchError` sits *inside* the projected request. Were
 *    it on the outer pipe, the first network hiccup would terminate the save
 *    stream permanently; only a successful save *after* a failed one proves the
 *    placement.
 * 4. Trigger exclusivity. Every one of the four grid callbacks feeds one
 *    subject, and a burst inside the debounce window must collapse to a single
 *    request carrying the newest complete snapshot. Nothing else may originate an
 *    arrangement: the release before a departure and the retry after a failure both
 *    re-enter that same subject with the snapshot the grid already produced, and
 *    neither builds a body or reaches the facade. `the single write origin` below
 *    pins that structurally, because behaviour alone cannot express "there is only
 *    one call site".
 * 5. Viewer isolation. The service is provided in the root injector, so it
 *    outlives every individual viewer, while the canvas that feeds it is never
 *    rebuilt across a change of identity. A snapshot therefore has to be bound
 *    to the viewer who authored it and refused once that viewer is gone -
 *    otherwise one account's arrangement is written into another's row. Nothing
 *    about that is visible in a type, and no other test in the workspace can
 *    detect it.
 *
 * - `ObservableStore.getState()` is `protected`, so store contents are read through
 *   the public `stateHistory` getter (the service enables `trackStateHistory`) and
 *   through `get()`. That is strictly stronger than reading state, because it also
 *   pins the dispatched action name.
 * - `ObservableStore` keeps one shared store, and one shared state history, for
 *   the whole module registry: `stateHistory` is a getter that hands back the
 *   very array every store instance appends to. Both are therefore reset in
 *   `beforeEach`, *before* the service under test is constructed, so that
 *   `stateHistory[0]` is this test's own initialization rather than whichever
 *   test happened to run first. Without that reset the sentinel assertion below
 *   would be order-dependent, and a store left populated by a previous test
 *   would serve its layout to the next one as a cache hit.
 *   Tests that need a network read still force it with `get(true)` where the
 *   read is the subject, and the unforced `get()` is used to prove a cache hit
 *   after a known write.
 */
describe('GfDashboardLayoutService', () => {
  /**
   * The viewer every scheduled snapshot in this file belongs to, and the one the
   * service is told to authorise writes for in `beforeEach`.
   *
   * Named rather than inlined because the identity is now half of the write
   * contract: a snapshot is only ever dispatched when the identity it was
   * produced under is still the authorised one, so a test that scheduled under
   * some other value would be asserting the refusal path by accident.
   */
  const VIEWER_ID = 'viewer-1';

  let consoleErrorSpy: jest.SpyInstance;
  let dataServiceMock: {
    deleteUserDashboardLayout: jest.Mock<Observable<void>, []>;
    fetchUserDashboardLayout: jest.Mock<Observable<UserDashboardLayout>, []>;
    patchUserDashboardLayout: jest.Mock<
      Observable<UserDashboardLayout>,
      [UpdateUserDashboardLayoutDto]
    >;
  };
  let service: GfDashboardLayoutService;
  let sharedStateHistory: StateHistory<DashboardLayoutStoreState>[];

  const wireFields = ['cols', 'moduleType', 'rows', 'x', 'y'];

  const strippedFields = [
    'callbackSpy',
    'compactEnabled',
    'dragEnabled',
    'id',
    'initCallback',
    'itemAspectRatio',
    'layerIndex',
    'maxItemArea',
    'maxItemCols',
    'maxItemRows',
    'minItemArea',
    'minItemCols',
    'minItemRows',
    'name',
    'resizableHandles',
    'resizeEnabled'
  ];

  /**
   * Everything a failed layout request carries that must never reach a log.
   *
   * Each of these sits somewhere on a real `HttpErrorResponse`: the token is in
   * the URL and in the body the server answered with, the address is in the URL
   * and in the message Angular composes from it, and the viewer's own identifier
   * is in the request body echoed back. `console.error(error)` prints all of it;
   * `reportSanitizedError` prints none of it. The two are indistinguishable to an
   * assertion that only checks *that* something was logged, which is why these
   * markers exist and why every failure below is built out of them.
   */
  const SECRET_TOKEN = 'SECRET-BEARER-TOKEN-9f3e2b6d';

  const SECRET_URL = `https://ghostfolio.test/api/v1/user/layout?access=${SECRET_TOKEN}`;

  const SENSITIVE_MARKERS = [
    SECRET_TOKEN,
    SECRET_URL,
    'ghostfolio.test',
    'Http failure',
    'viewer@example.test',
    'at GfDashboardLayoutService'
  ];

  /**
   * A failure shaped like the one the data facade really rejects with.
   *
   * `HttpErrorResponse`-like rather than the real class: what the reporting
   * contract reads is a numeric `status`, and what a leak would expose is the
   * URL, the body, the composed message and the stack. All five are present here,
   * so this object is a faithful stand-in for the thing being protected against
   * without dragging `HttpClient` into a spec that has no HTTP in it.
   */
  const createRequestFailure = ({
    status = 500
  }: { status?: number } = {}) => ({
    error: { detail: `rejected for ${SECRET_TOKEN}` },
    message: `Http failure response for ${SECRET_URL}: ${status} Internal Server Error`,
    name: 'HttpErrorResponse',
    stack: `at GfDashboardLayoutService (${SECRET_URL})`,
    status,
    statusText: 'Internal Server Error',
    url: SECRET_URL,
    viewer: 'viewer@example.test'
  });

  /** Every logged argument rendered as text, whatever shape it arrived in. */
  const loggedArgumentsAsText = () => {
    return consoleErrorSpy.mock.calls.flat().map((argument: unknown) => {
      if (typeof argument === 'string') {
        return argument;
      }

      if (argument instanceof Error) {
        return [argument.name, argument.message, argument.stack].join(' ');
      }

      if (argument && typeof argument === 'object') {
        const record = argument as Record<string, unknown>;

        // The revealing members are read one by one as well as serialised,
        // because a member reached through the prototype chain - which is where
        // `HttpErrorResponse` keeps `message` - does not appear in
        // `JSON.stringify`.
        const members = ['message', 'stack', 'statusText', 'url']
          .map((key) => (typeof record[key] === 'string' ? record[key] : ''))
          .join(' ');

        return `${members} ${JSON.stringify(record)}`;
      }

      return JSON.stringify(argument) ?? '';
    });
  };

  /**
   * Asserts the exact report a failing path is allowed to emit.
   *
   * Deep-equality on `mock.calls` rather than a containment check, because the
   * defect being guarded against - `console.error(error)`, or
   * `console.error(eventId, error)` - satisfies containment in full while
   * printing the whole failure. The marker sweep that follows is the second half:
   * it catches a report that is a single string and still built out of the
   * failure's own message.
   */
  const expectSanitizedReport = (aEventId: string, aStatus?: number) => {
    const expected =
      typeof aStatus === 'number'
        ? `${aEventId} (status ${aStatus})`
        : aEventId;

    expect(consoleErrorSpy.mock.calls).toEqual([[expected]]);

    for (const text of loggedArgumentsAsText()) {
      for (const marker of SENSITIVE_MARKERS) {
        expect(text).not.toContain(marker);
      }
    }
  };

  const createGridItem = (
    overrides: Partial<DashboardLayoutItem> = {}
  ): DashboardLayoutItem => ({
    cols: 6,
    compactEnabled: false,
    dragEnabled: true,
    layerIndex: 2,
    maxItemCols: 12,
    maxItemRows: 12,
    minItemCols: 2,
    minItemRows: 2,
    moduleType: DashboardModuleType.PORTFOLIO_OVERVIEW,
    resizeEnabled: true,
    rows: 4,
    x: 0,
    y: 0,
    ...overrides
  });

  const createService = () => {
    TestBed.configureTestingModule({
      providers: [
        GfDashboardLayoutService,
        { provide: DataService, useValue: dataServiceMock }
      ]
    });

    return TestBed.inject(GfDashboardLayoutService);
  };

  /**
   * Returns the shared store and its shared history to their pristine state.
   *
   * Both are process-global in `@codewithdan/observable-store`: `clearState`
   * nulls the one store every service slices, and `stateHistory` is a getter that
   * returns the one array every service appends to - which is why the array is
   * emptied in place rather than reassigned. Called before the service under test
   * is constructed, so that service's own initialization is the first entry.
   *
   * The very first call has nothing to clear, because a Jest test file gets its
   * own module registry; every later call is what makes this suite independent of
   * execution order.
   */
  const resetObservableStore = () => {
    ObservableStore.clearState(false);

    sharedStateHistory?.splice(0);
  };

  /** The request body of the n-th PATCH the service issued. */
  const readPatchedDto = (index: number): UpdateUserDashboardLayoutDto =>
    dataServiceMock.patchUserDashboardLayout.mock.calls[index][0];

  const readStoreAction = (): string => {
    const history = service.stateHistory;

    return history[history.length - 1].action;
  };

  const readStoreLayout = (): UserDashboardLayout => {
    const history = service.stateHistory;

    return history[history.length - 1].endState?.layout;
  };

  beforeEach(() => {
    // The service reports every failure through `console.error`. Spying keeps
    // the expected failures out of the test output and makes them assertable.
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {
      return undefined;
    });

    dataServiceMock = {
      // The endpoint answers a discard with nothing at all, so the double completes
      // without a value. Typed as `void` rather than left untyped so a test that
      // expected a layout back from a delete would not compile.
      deleteUserDashboardLayout: jest.fn(() => of(undefined as void)),
      fetchUserDashboardLayout: jest.fn(() => of(null)),
      // The endpoint answers a write with the layout it stored, so the default
      // mock echoes the request back. Declaring the parameter also keeps the
      // mock's call signature identical to the facade's, which is what makes
      // `mock.calls[n][0]` typed and every assertion below cast-free.
      patchUserDashboardLayout: jest.fn((aData: UpdateUserDashboardLayoutDto) =>
        of({ modules: aData.modules, version: 1 })
      )
    };

    resetObservableStore();

    service = createService();

    // Writes are refused until an identity has been adopted, which is what makes
    // a snapshot produced across a token replacement undispatchable. Every test
    // that expects a PATCH therefore has to start from an authorised identity,
    // exactly as the canvas establishes one the moment it adopts a viewer.
    service.adoptIdentity(VIEWER_ID);

    sharedStateHistory = service.stateHistory;
  });

  afterEach(() => {
    jest.useRealTimers();

    // Destroyed here, deliberately, and BEFORE the spy is handed back.
    //
    // The service releases whatever is still pending when it is destroyed, and a
    // snapshot whose write has already failed is released again and reported
    // again - which is behaviour this suite asserts on purpose. Angular's
    // automatic teardown is registered at ROOT level, by `setupZoneTestEnv()` in
    // `apps/client/src/test-setup.ts`, so it runs AFTER every hook declared
    // inside a `describe`: the destroy used to happen once the spy below had
    // already been restored, and eight sanitized reports reached the real
    // `console.error` on a fully passing run. Nothing was wrong with the
    // assertions - the reports simply arrived after the only thing that was
    // capturing them had gone. Resetting here brings the destroy back inside the
    // spy's lifetime, where it is captured and assertable; Angular's own
    // teardown then finds nothing left to destroy.
    TestBed.resetTestingModule();

    consoleErrorSpy.mockRestore();
    jest.restoreAllMocks();
  });

  describe('initialization and reads', () => {
    it('records the initialize action without reading from the endpoint', () => {
      expect(readStoreAction()).toBe(DashboardLayoutStoreActions.Initialize);
      expect(dataServiceMock.fetchUserDashboardLayout).not.toHaveBeenCalled();
      expect(dataServiceMock.patchUserDashboardLayout).not.toHaveBeenCalled();
    });

    it('seeds the store as not yet fetched, which is distinct from an absent layout', () => {
      // The history was emptied immediately before this test's service was
      // constructed, so its first - and, before anything else runs, only - entry
      // is that construction. Its begin state is the cleared store and its end
      // state carries no layout at all: `undefined`, not `null`. That distinction
      // is what lets `get()` tell a never-read store from one that read an absent
      // row.
      expect(service.stateHistory).toHaveLength(1);

      const bootEntry = service.stateHistory[0];

      expect(bootEntry.action).toBe(DashboardLayoutStoreActions.Initialize);
      expect(bootEntry.beginState).toBeNull();
      expect(bootEntry.endState.layout).toBeUndefined();
      expect(bootEntry.endState.layout).not.toBeNull();
    });

    it('preserves a null layout from the endpoint', () => {
      dataServiceMock.fetchUserDashboardLayout.mockReturnValue(of(null));

      let emitted: UserDashboardLayout;
      let emissions = 0;

      service.get(true).subscribe((layout) => {
        emissions += 1;
        emitted = layout;
      });

      expect(emissions).toBe(1);
      expect(emitted).toBeNull();
      expect(emitted).not.toBeUndefined();
      expect(emitted).not.toEqual({ modules: [] });
      expect(readStoreAction()).toBe(
        DashboardLayoutStoreActions.GetDashboardLayout
      );
      expect(readStoreLayout()).toBeNull();
    });

    it('preserves an empty modules array from the endpoint', () => {
      dataServiceMock.fetchUserDashboardLayout.mockReturnValue(
        of({ modules: [] })
      );

      let emitted: UserDashboardLayout;

      service.get(true).subscribe((layout) => (emitted = layout));

      expect(emitted).toEqual({ modules: [] });
      expect(emitted.modules).toHaveLength(0);
      expect(emitted).not.toBeNull();
      expect(readStoreLayout()).toEqual({ modules: [] });
    });

    it('preserves a hydrated layout from the endpoint', () => {
      const persisted: UserDashboardLayout = {
        modules: [
          { cols: 6, moduleType: 'portfolio-overview', rows: 4, x: 0, y: 0 },
          { cols: 6, moduleType: 'holdings', rows: 8, x: 6, y: 0 }
        ],
        version: 1
      };

      dataServiceMock.fetchUserDashboardLayout.mockReturnValue(of(persisted));

      let emitted: UserDashboardLayout;

      service.get(true).subscribe((layout) => (emitted = layout));

      expect(emitted).toEqual(persisted);
      expect(readStoreLayout()).toEqual(persisted);
      expect(readStoreAction()).toBe(
        DashboardLayoutStoreActions.GetDashboardLayout
      );
    });
  });

  describe('caching', () => {
    it('serves a second read from cache', () => {
      dataServiceMock.fetchUserDashboardLayout.mockReturnValue(
        of({ modules: [], version: 1 })
      );

      let first: UserDashboardLayout;
      let second: UserDashboardLayout;

      service.get(true).subscribe((layout) => (first = layout));
      service.get().subscribe((layout) => (second = layout));

      expect(dataServiceMock.fetchUserDashboardLayout).toHaveBeenCalledTimes(1);
      expect(second).toEqual(first);
    });

    it('re-fetches when force is true', () => {
      dataServiceMock.fetchUserDashboardLayout.mockReturnValue(
        of({ modules: [], version: 1 })
      );

      service.get(true).subscribe();
      service.get(true).subscribe();

      expect(dataServiceMock.fetchUserDashboardLayout).toHaveBeenCalledTimes(2);
    });

    it('serves a cached null from cache without re-fetching', () => {
      dataServiceMock.fetchUserDashboardLayout.mockReturnValue(of(null));

      let cached: UserDashboardLayout;
      let emissions = 0;

      service.get(true).subscribe();
      service.get().subscribe((layout) => {
        emissions += 1;
        cached = layout;
      });

      expect(dataServiceMock.fetchUserDashboardLayout).toHaveBeenCalledTimes(1);
      expect(emissions).toBe(1);
      expect(cached).toBeNull();
    });
  });

  describe('debounced persistence', () => {
    it('coalesces the four grid callbacks into a single PATCH', () => {
      jest.useFakeTimers();

      // The four snapshots below stand for the four — and only the four — grid
      // state change events that may trigger a save. Each one is a complete
      // snapshot of the canvas at that instant, and the removal case is
      // deliberately shorter than the ones before it.

      // itemInitCallback: the canvas hydrated two modules.
      service.scheduleSave(VIEWER_ID, [
        createGridItem(),
        createGridItem({
          moduleType: DashboardModuleType.HOLDINGS,
          x: 6
        })
      ]);

      // itemChangeCallback: the second module was dragged one row down.
      service.scheduleSave(VIEWER_ID, [
        createGridItem(),
        createGridItem({
          moduleType: DashboardModuleType.HOLDINGS,
          x: 6,
          y: 4
        })
      ]);

      // itemResizeCallback: the second module was widened to the full grid.
      service.scheduleSave(VIEWER_ID, [
        createGridItem(),
        createGridItem({
          cols: 12,
          moduleType: DashboardModuleType.HOLDINGS,
          x: 0,
          y: 4
        })
      ]);

      // itemRemovedCallback: the first module was removed, leaving one behind.
      service.scheduleSave(VIEWER_ID, [
        createGridItem({
          cols: 12,
          moduleType: DashboardModuleType.HOLDINGS,
          x: 0,
          y: 4
        })
      ]);

      jest.advanceTimersByTime(499);

      expect(dataServiceMock.patchUserDashboardLayout).not.toHaveBeenCalled();

      jest.advanceTimersByTime(1);

      expect(dataServiceMock.patchUserDashboardLayout).toHaveBeenCalledTimes(1);
      expect(readPatchedDto(0)).toEqual({
        modules: [{ cols: 12, moduleType: 'holdings', rows: 4, x: 0, y: 4 }],
        version: 1
      });
    });

    it('projects each item to exactly the five wire fields', () => {
      jest.useFakeTimers();

      service.scheduleSave(VIEWER_ID, [
        createGridItem({
          callbackSpy: () => undefined,
          id: 'should-not-be-sent',
          initCallback: () => undefined,
          name: 'should-not-be-sent'
        })
      ]);

      jest.advanceTimersByTime(500);

      const dto = readPatchedDto(0);

      expect(Object.keys(dto.modules[0]).sort()).toEqual(wireFields);
      expect(Object.keys(dto).sort()).toEqual(['modules', 'version']);
      expect(dto.version).toBe(1);

      for (const strippedField of strippedFields) {
        expect(dto.modules[0]).not.toHaveProperty(strippedField);
      }

      expect(
        Object.values(dto.modules[0]).every(
          (value) => typeof value !== 'function'
        )
      ).toBe(true);
      expect(JSON.parse(JSON.stringify(dto))).toEqual(dto);
    });

    it('projects an empty snapshot to an empty modules array', () => {
      jest.useFakeTimers();

      service.scheduleSave(VIEWER_ID, []);

      jest.advanceTimersByTime(500);

      expect(dataServiceMock.patchUserDashboardLayout).toHaveBeenCalledTimes(1);
      expect(readPatchedDto(0).modules).toEqual([]);
      expect(readPatchedDto(0).version).toBe(1);
    });

    it('does not clamp or coerce geometry values', () => {
      jest.useFakeTimers();

      service.scheduleSave(VIEWER_ID, [
        createGridItem({ cols: 1, rows: 1, x: 99, y: -3 })
      ]);

      jest.advanceTimersByTime(500);

      expect(readPatchedDto(0).modules[0]).toEqual({
        cols: 1,
        moduleType: 'portfolio-overview',
        rows: 1,
        x: 99,
        y: -3
      });
    });

    it('does not translate the module type discriminator', () => {
      jest.useFakeTimers();

      service.scheduleSave(VIEWER_ID, [
        createGridItem({ moduleType: DashboardModuleType.AI_CHAT }),
        createGridItem({ moduleType: DashboardModuleType.X_RAY, x: 6 })
      ]);

      jest.advanceTimersByTime(500);

      const persistedTypes = readPatchedDto(0).modules.map(
        (module) => module.moduleType
      );

      expect(persistedTypes).toEqual(['ai-chat', 'x-ray']);
    });

    it('persists each subsequent debounced snapshot', () => {
      jest.useFakeTimers();

      service.scheduleSave(VIEWER_ID, [createGridItem()]);

      jest.advanceTimersByTime(500);

      expect(dataServiceMock.patchUserDashboardLayout).toHaveBeenCalledTimes(1);

      service.scheduleSave(VIEWER_ID, [createGridItem({ cols: 8, x: 2 })]);

      jest.advanceTimersByTime(500);

      expect(dataServiceMock.patchUserDashboardLayout).toHaveBeenCalledTimes(2);
      expect(readPatchedDto(1).modules[0]).toEqual({
        cols: 8,
        moduleType: 'portfolio-overview',
        rows: 4,
        x: 2,
        y: 0
      });
    });

    it('never has two writes outstanding at once, so the server is never asked out of order', () => {
      // A request the server has ALREADY ACCEPTED cannot be recalled: dropping the
      // client's subscription only stops it listening for the reply, while the
      // transaction goes on to commit. The only way to know which document the row
      // is left holding is therefore never to have two of them accepted at the same
      // time, and that is what is asserted here - from the server's side of the
      // boundary, by counting how many requests were open at once, rather than from
      // an RxJS teardown, which says nothing about a transaction already begun.
      const acknowledge: (() => void)[] = [];
      let openRequests = 0;
      let peakOpenRequests = 0;

      dataServiceMock.patchUserDashboardLayout.mockImplementation(
        (aData: UpdateUserDashboardLayoutDto) =>
          new Observable<UserDashboardLayout>((subscriber) => {
            openRequests += 1;
            peakOpenRequests = Math.max(peakOpenRequests, openRequests);

            acknowledge.push(() => {
              openRequests -= 1;

              subscriber.next({ modules: aData.modules, version: 1 });
              subscriber.complete();
            });
          })
      );

      jest.useFakeTimers();

      service.scheduleSave(VIEWER_ID, [createGridItem({ cols: 4 })]);

      jest.advanceTimersByTime(500);

      expect(dataServiceMock.patchUserDashboardLayout).toHaveBeenCalledTimes(1);

      // Two further arrangements reported while that request is still open.
      service.scheduleSave(VIEWER_ID, [createGridItem({ cols: 6 })]);

      jest.advanceTimersByTime(500);

      service.scheduleSave(VIEWER_ID, [createGridItem({ cols: 8 })]);

      jest.advanceTimersByTime(500);

      // Still exactly one, because the queue waits for the open request to settle
      // instead of opening a second one alongside it.
      expect(dataServiceMock.patchUserDashboardLayout).toHaveBeenCalledTimes(1);

      acknowledge[0]();

      // The queue moves on, and the two arrangements waiting behind it collapse to
      // the newest: the six-column body is never sent at all, because by the time
      // its turn came it had already been replaced.
      expect(dataServiceMock.patchUserDashboardLayout).toHaveBeenCalledTimes(2);
      expect(readPatchedDto(1).modules[0].cols).toBe(8);

      acknowledge[1]();

      expect(dataServiceMock.patchUserDashboardLayout).toHaveBeenCalledTimes(2);
      expect(peakOpenRequests).toBe(1);
    });

    it('leaves the server holding the newest reported arrangement, asked for last', () => {
      // The ordering claim stated as the thing that actually matters: not which
      // requests were abandoned, but the sequence of documents the server was asked
      // to store, and which one it was asked for last.
      const acknowledge: (() => void)[] = [];

      dataServiceMock.patchUserDashboardLayout.mockImplementation(
        (aData: UpdateUserDashboardLayoutDto) =>
          new Observable<UserDashboardLayout>((subscriber) => {
            acknowledge.push(() => {
              subscriber.next({ modules: aData.modules, version: 1 });
              subscriber.complete();
            });
          })
      );

      jest.useFakeTimers();

      for (const cols of [4, 6, 8, 10]) {
        service.scheduleSave(VIEWER_ID, [createGridItem({ cols })]);

        // Each arrangement is acknowledged before the next is reported, so all four
        // reach the wire rather than collapsing into one another - which is what
        // makes the requested sequence, and therefore its order, observable.
        jest.advanceTimersByTime(500);

        acknowledge[acknowledge.length - 1]();
      }

      const requestedColumns =
        dataServiceMock.patchUserDashboardLayout.mock.calls.map(
          ([aData]: [UpdateUserDashboardLayoutDto]) => aData.modules[0].cols
        );

      // Strictly ascending, so no older arrangement was ever asked for after a newer
      // one - which is precisely the property an accepted-then-abandoned request
      // breaks, and which no assertion about unsubscription could establish.
      expect(requestedColumns).toEqual([4, 6, 8, 10]);

      // And the last document the server was asked to store is the last one the
      // viewer reported.
      expect(requestedColumns[requestedColumns.length - 1]).toBe(10);
      expect(readStoreLayout().modules[0].cols).toBe(10);
    });

    it('settles a release whose arrangement was superseded rather than leaving it to time out', () => {
      // The other half of what abandoning a request costs. A superseded write that
      // produced no outcome would leave a caller awaiting the release of that
      // arrangement - signing out is held open until it settles - waiting out the
      // whole five-second bound only to be told the save had failed. Every
      // snapshot the dispatcher takes announces an outcome, including the ones it
      // declines to send.
      const acknowledge: (() => void)[] = [];

      dataServiceMock.patchUserDashboardLayout.mockImplementation(
        (aData: UpdateUserDashboardLayoutDto) =>
          new Observable<UserDashboardLayout>((subscriber) => {
            acknowledge.push(() => {
              subscriber.next({ modules: aData.modules, version: 1 });
              subscriber.complete();
            });
          })
      );

      jest.useFakeTimers();

      service.scheduleSave(VIEWER_ID, [createGridItem({ cols: 4 })]);

      jest.advanceTimersByTime(500);

      // Reported while the first request is still open, so this arrangement is
      // queued rather than sent - and it is the one the release below waits for.
      service.scheduleSave(VIEWER_ID, [createGridItem({ cols: 8 })]);

      jest.advanceTimersByTime(500);

      let hasSettled = false;
      let failure: unknown;

      service.releasePendingSave().subscribe({
        complete: () => {
          hasSettled = true;
        },
        error: (error: unknown) => {
          failure = error;
        }
      });

      // Nothing can settle while the open request is unanswered.
      expect(hasSettled).toBe(false);

      acknowledge[0]();

      expect(hasSettled).toBe(false);

      acknowledge[1]();

      // Settled by the write of the very arrangement it was waiting for, and well
      // inside the five-second bound - which the clock has not been advanced past.
      expect(hasSettled).toBe(true);
      expect(failure).toBeUndefined();

      jest.advanceTimersByTime(5000);

      expect(failure).toBeUndefined();
    });

    it('spends one request on a burst inside a single quiet period', () => {
      jest.useFakeTimers();

      // What a drag actually looks like: the grid reports every cell it crosses.
      service.scheduleSave(VIEWER_ID, [createGridItem({ x: 1 })]);

      jest.advanceTimersByTime(100);

      service.scheduleSave(VIEWER_ID, [createGridItem({ x: 2 })]);

      jest.advanceTimersByTime(100);

      service.scheduleSave(VIEWER_ID, [createGridItem({ x: 3 })]);

      jest.advanceTimersByTime(500);

      // Coalesced by the debounce rather than by the operator that follows it, so
      // the intermediate positions never reach the wire at all.
      expect(dataServiceMock.patchUserDashboardLayout).toHaveBeenCalledTimes(1);
      expect(readPatchedDto(0).modules[0].x).toBe(3);
    });

    it('updates store state from a successful PATCH response', () => {
      const persisted: UserDashboardLayout = {
        modules: [{ cols: 6, moduleType: 'holdings', rows: 4, x: 0, y: 0 }],
        version: 1
      };

      dataServiceMock.patchUserDashboardLayout.mockReturnValue(of(persisted));

      jest.useFakeTimers();

      service.scheduleSave(VIEWER_ID, [
        createGridItem({ moduleType: DashboardModuleType.HOLDINGS })
      ]);

      jest.advanceTimersByTime(500);

      expect(readStoreAction()).toBe(
        DashboardLayoutStoreActions.UpdateDashboardLayout
      );
      expect(readStoreLayout()).toEqual(persisted);
    });

    it('tolerates a null snapshot', () => {
      jest.useFakeTimers();

      // The canvas always hands over an array, but a save must never be the
      // thing that throws: an absent snapshot degrades to an empty layout.
      service.scheduleSave(VIEWER_ID, null);

      jest.advanceTimersByTime(500);

      expect(dataServiceMock.patchUserDashboardLayout).toHaveBeenCalledTimes(1);
      expect(readPatchedDto(0)).toEqual({ modules: [], version: 1 });
      expect(consoleErrorSpy).not.toHaveBeenCalled();
    });

    it('writes back the entries the canvas could not draw alongside the ones it did', () => {
      jest.useFakeTimers();

      // The canvas hands over its *canonical* arrangement: the modules it drew,
      // plus the saved entries it had to withhold - a module type the registry no
      // longer knows, or one gated behind a permission the viewer does not
      // currently hold. Sending only what has a grid cell would make every
      // ordinary drag a deletion of everything the viewer cannot presently see.
      service.scheduleSave(VIEWER_ID, [
        createGridItem({ cols: 6, x: 1 }),
        { cols: 8, moduleType: 'admin-overview', rows: 6, x: 0, y: 6 },
        { cols: 4, moduleType: 'legacy-net-worth', rows: 4, x: 8, y: 6 }
      ]);

      jest.advanceTimersByTime(500);

      expect(readPatchedDto(0)).toEqual({
        modules: [
          { cols: 6, moduleType: 'portfolio-overview', rows: 4, x: 1, y: 0 },
          { cols: 8, moduleType: 'admin-overview', rows: 6, x: 0, y: 6 },
          { cols: 4, moduleType: 'legacy-net-worth', rows: 4, x: 8, y: 6 }
        ],
        version: 1
      });
    });

    it('projects the withheld entries onto the wire fields too', () => {
      jest.useFakeTimers();

      // Projected rather than spread through, because the server applies
      // `forbidNonWhitelisted`: one stray key on one entry rejects the whole
      // request with 400 and the arrangement would stop saving altogether.
      service.scheduleSave(VIEWER_ID, [
        createGridItem(),
        {
          cols: 8,
          minItemCols: 4,
          moduleType: 'admin-overview',
          rows: 6,
          x: 0,
          y: 6
        }
      ] as never);

      jest.advanceTimersByTime(500);

      const dto = readPatchedDto(0);

      expect(Object.keys(dto.modules[1]).sort()).toEqual(wireFields);
      expect(dto.modules[1]).not.toHaveProperty('minItemCols');
    });

    it('writes exactly what it was given when nothing had to be withheld', () => {
      jest.useFakeTimers();

      // The ordinary case, asserted next to the one above so that carrying the
      // withheld entries through cannot be mistaken for adding an entry of its
      // own: an arrangement whose every module is on the canvas is written as it
      // stands.
      service.scheduleSave(VIEWER_ID, [createGridItem()]);

      jest.advanceTimersByTime(500);

      expect(readPatchedDto(0).modules).toHaveLength(1);
      expect(consoleErrorSpy).not.toHaveBeenCalled();
    });
  });

  describe('error handling', () => {
    it('keeps the save stream alive after a PATCH failure', () => {
      dataServiceMock.patchUserDashboardLayout
        .mockReturnValueOnce(throwError(() => createRequestFailure()))
        .mockReturnValueOnce(of({ modules: [], version: 1 }));

      jest.useFakeTimers();

      service.scheduleSave(VIEWER_ID, [createGridItem()]);

      expect(() => jest.advanceTimersByTime(500)).not.toThrow();
      expect(dataServiceMock.patchUserDashboardLayout).toHaveBeenCalledTimes(1);
      expectSanitizedReport('GF-DASHBOARD-LAYOUT-PERSIST-FAILED', 500);

      service.scheduleSave(VIEWER_ID, [createGridItem({ cols: 8 })]);

      jest.advanceTimersByTime(500);

      expect(dataServiceMock.patchUserDashboardLayout).toHaveBeenCalledTimes(2);
      expect(readPatchedDto(1).modules[0].cols).toBe(8);
    });

    it('does not update store state when a PATCH fails', () => {
      dataServiceMock.patchUserDashboardLayout.mockReturnValue(
        throwError(() => createRequestFailure())
      );

      jest.useFakeTimers();

      const actionBeforeWrite = readStoreAction();

      service.scheduleSave(VIEWER_ID, [createGridItem()]);

      jest.advanceTimersByTime(500);

      // The recovery emits nothing usable, so the store must be left exactly as
      // the last successful action left it rather than being overwritten with a
      // failure value.
      expect(readStoreAction()).toBe(actionBeforeWrite);
      expect(readStoreAction()).not.toBe(
        DashboardLayoutStoreActions.UpdateDashboardLayout
      );
      expectSanitizedReport('GF-DASHBOARD-LAYOUT-PERSIST-FAILED', 500);
    });

    it('publishes the failure so the canvas can report an unsaved arrangement', () => {
      dataServiceMock.patchUserDashboardLayout.mockReturnValue(
        throwError(() => new Error('PATCH failed'))
      );

      const observed: boolean[] = [];

      service.getHasSaveError().subscribe((hasSaveError) => {
        observed.push(hasSaveError);
      });

      jest.useFakeTimers();

      service.scheduleSave(VIEWER_ID, [createGridItem()]);

      jest.advanceTimersByTime(500);

      // A silent failure would leave the viewer believing an arrangement they can
      // still see had been stored, which is the whole reason the snapshot is kept.
      expect(observed).toEqual([false, true]);
    });

    it('retains the failed snapshot so it can still be released on destroy', () => {
      dataServiceMock.patchUserDashboardLayout.mockReturnValueOnce(
        throwError(() => new Error('PATCH failed'))
      );

      jest.useFakeTimers();

      service.scheduleSave(VIEWER_ID, [createGridItem({ cols: 8, x: 2 })]);

      jest.advanceTimersByTime(500);

      expect(dataServiceMock.patchUserDashboardLayout).toHaveBeenCalledTimes(1);

      service.ngOnDestroy();

      // Discarding the snapshot before the write was acknowledged would lose the
      // newest arrangement permanently, with nothing left to release.
      expect(dataServiceMock.patchUserDashboardLayout).toHaveBeenCalledTimes(2);
      expect(readPatchedDto(1)).toEqual(readPatchedDto(0));
      expect(readPatchedDto(1).modules[0]).toEqual({
        cols: 8,
        moduleType: 'portfolio-overview',
        rows: 4,
        x: 2,
        y: 0
      });
    });

    it('re-sends the failed snapshot through the one write origin on retry', () => {
      dataServiceMock.patchUserDashboardLayout.mockReturnValueOnce(
        throwError(() => new Error('PATCH failed'))
      );

      const observed: boolean[] = [];

      service.getHasSaveError().subscribe((hasSaveError) => {
        observed.push(hasSaveError);
      });

      jest.useFakeTimers();

      service.scheduleSave(VIEWER_ID, [createGridItem({ cols: 8 })]);

      jest.advanceTimersByTime(500);

      service.retryFailedSave();

      // The retry is debounced exactly like every other write, because it
      // re-enters through the same subject rather than calling the facade itself.
      expect(dataServiceMock.patchUserDashboardLayout).toHaveBeenCalledTimes(1);

      jest.advanceTimersByTime(500);

      expect(dataServiceMock.patchUserDashboardLayout).toHaveBeenCalledTimes(2);
      expect(readPatchedDto(1)).toEqual(readPatchedDto(0));
      expect(observed).toEqual([false, true, false]);
    });

    it('gives up the failed snapshot when it is discarded', () => {
      dataServiceMock.patchUserDashboardLayout.mockReturnValueOnce(
        throwError(() => new Error('PATCH failed'))
      );

      const observed: boolean[] = [];

      service.getHasSaveError().subscribe((hasSaveError) => {
        observed.push(hasSaveError);
      });

      jest.useFakeTimers();

      service.scheduleSave(VIEWER_ID, [createGridItem({ cols: 8 })]);

      jest.advanceTimersByTime(500);

      expect(dataServiceMock.patchUserDashboardLayout).toHaveBeenCalledTimes(1);
      expect(observed).toEqual([false, true]);

      // The canvas calls this when a viewer abandons an arrangement that could not
      // be read and starts a blank one: what was outstanding describes the
      // arrangement they have just left, so it stops being offered and stops being
      // reported as unsaved.
      service.discardFailedSave();

      expect(observed).toEqual([false, true, false]);

      service.retryFailedSave();

      jest.advanceTimersByTime(500);

      // And it is genuinely given up rather than merely hidden - the retry has
      // nothing left to send, so no second request appears.
      expect(dataServiceMock.patchUserDashboardLayout).toHaveBeenCalledTimes(1);
    });

    it('does nothing on discarding when every snapshot has been acknowledged', () => {
      jest.useFakeTimers();

      service.scheduleSave(VIEWER_ID, [createGridItem()]);

      jest.advanceTimersByTime(500);

      expect(dataServiceMock.patchUserDashboardLayout).toHaveBeenCalledTimes(1);

      expect(() => service.discardFailedSave()).not.toThrow();

      jest.advanceTimersByTime(500);

      expect(dataServiceMock.patchUserDashboardLayout).toHaveBeenCalledTimes(1);
    });

    it('does nothing on retry when every snapshot has been acknowledged', () => {
      jest.useFakeTimers();

      service.scheduleSave(VIEWER_ID, [createGridItem()]);

      jest.advanceTimersByTime(500);

      expect(dataServiceMock.patchUserDashboardLayout).toHaveBeenCalledTimes(1);

      service.retryFailedSave();
      service.retryFailedSave();

      jest.advanceTimersByTime(500);

      // Safe to press twice, and never a source of a duplicate write.
      expect(dataServiceMock.patchUserDashboardLayout).toHaveBeenCalledTimes(1);
    });

    it('lets a newer arrangement supersede one whose write failed', () => {
      dataServiceMock.patchUserDashboardLayout.mockReturnValueOnce(
        throwError(() => new Error('PATCH failed'))
      );

      jest.useFakeTimers();

      service.scheduleSave(VIEWER_ID, [createGridItem({ cols: 8 })]);

      jest.advanceTimersByTime(500);

      service.scheduleSave(VIEWER_ID, [createGridItem({ cols: 10 })]);

      jest.advanceTimersByTime(500);

      expect(dataServiceMock.patchUserDashboardLayout).toHaveBeenCalledTimes(2);
      expect(readPatchedDto(1).modules[0].cols).toBe(10);

      service.ngOnDestroy();

      // The newer snapshot replaced the failed one and was then acknowledged, so
      // there is nothing outstanding and the stale arrangement is never replayed.
      expect(dataServiceMock.patchUserDashboardLayout).toHaveBeenCalledTimes(2);
    });

    it('propagates a fetch failure to the caller', () => {
      const failure = createRequestFailure();

      dataServiceMock.fetchUserDashboardLayout.mockReturnValue(
        throwError(() => failure)
      );

      let emitted: UserDashboardLayout;
      let emissions = 0;
      let receivedError: unknown;

      service.get(true).subscribe({
        error: (error: unknown) => (receivedError = error),
        next: (layout) => {
          emissions += 1;
          emitted = layout;
        }
      });

      expect(receivedError).toBe(failure);
      // Rethrown to the caller in full and reported to the log sanitized: the
      // subscriber needs the failure, the log must not have it.
      expectSanitizedReport('GF-DASHBOARD-LAYOUT-FETCH-FAILED', 500);
      expect(emissions).toBe(0);
      expect(emitted).toBeUndefined();
      expect(emitted).not.toEqual({ modules: [] });
      expect(readStoreAction()).not.toBe(
        DashboardLayoutStoreActions.GetDashboardLayout
      );
    });
  });

  describe('the release on teardown', () => {
    it('releases a still-debounced snapshot on destroy', () => {
      jest.useFakeTimers();

      service.scheduleSave(VIEWER_ID, [createGridItem({ cols: 8 })]);

      jest.advanceTimersByTime(200);

      expect(dataServiceMock.patchUserDashboardLayout).not.toHaveBeenCalled();

      service.ngOnDestroy();

      // The release travels the one pipeline a debounced save travels — it ends the
      // quiet period, and nothing else. There is no second projection, no second
      // request builder and no second call to the facade; the single `concatMap`
      // issues this request too. Closing the browser tab inside the window
      // therefore remains an accepted loss window rather than an excuse to invent a
      // transport, because the endpoint takes PATCH and no fire-and-forget
      // transport can issue one.
      expect(dataServiceMock.patchUserDashboardLayout).toHaveBeenCalledTimes(1);
      expect(Object.keys(readPatchedDto(0).modules[0]).sort()).toEqual(
        wireFields
      );
      expect(readPatchedDto(0).modules[0].cols).toBe(8);
      expect(readPatchedDto(0).version).toBe(1);
    });

    it('does not write twice when destroyed repeatedly', () => {
      jest.useFakeTimers();

      service.scheduleSave(VIEWER_ID, [createGridItem()]);

      jest.advanceTimersByTime(200);

      service.ngOnDestroy();
      service.ngOnDestroy();

      expect(dataServiceMock.patchUserDashboardLayout).toHaveBeenCalledTimes(1);
    });

    it('sends nothing when the debounced save already dispatched', () => {
      jest.useFakeTimers();

      service.scheduleSave(VIEWER_ID, [createGridItem()]);

      jest.advanceTimersByTime(500);

      expect(dataServiceMock.patchUserDashboardLayout).toHaveBeenCalledTimes(1);

      service.ngOnDestroy();

      expect(dataServiceMock.patchUserDashboardLayout).toHaveBeenCalledTimes(1);
    });

    it('sends nothing when nothing was ever scheduled', () => {
      service.ngOnDestroy();

      expect(dataServiceMock.patchUserDashboardLayout).not.toHaveBeenCalled();
      expect(consoleErrorSpy).not.toHaveBeenCalled();
    });

    it('reports a failed release without throwing', () => {
      dataServiceMock.patchUserDashboardLayout.mockReturnValue(
        throwError(() => createRequestFailure())
      );

      jest.useFakeTimers();

      service.scheduleSave(VIEWER_ID, [createGridItem()]);

      jest.advanceTimersByTime(200);

      // A failure while the page is going away has nowhere to surface, so it is
      // contained by the same inner `catchError` every other write is contained by:
      // an unhandled error here would break teardown for every consumer of the
      // service. It is reported through the sanitized channel, under the identifier
      // every persistence failure uses, because a released write is not a different
      // kind of write.
      expect(() => service.ngOnDestroy()).not.toThrow();
      expect(dataServiceMock.patchUserDashboardLayout).toHaveBeenCalledTimes(1);
      expectSanitizedReport('GF-DASHBOARD-LAYOUT-PERSIST-FAILED', 500);
    });
  });

  /**
   * A departure the application itself performs.
   *
   * Destroying this service is not the only way an arrangement can be stranded
   * inside the debounce window. Signing out replaces the whole document, and it
   * does so on the application's own initiative rather than the browser's - so
   * unlike a closed tab it CAN carry the pending write out with it, and therefore
   * must. That makes the same release reachable from outside the lifecycle hook.
   *
   * What these tests are really pinning is that reachability costs nothing
   * architecturally: the release carries no arrangement, builds no body and calls
   * no facade method. It re-enters the one subject the grid's own callbacks feed
   * and then ends the quiet period, so the grid remains the only place an
   * arrangement can originate.
   */
  describe('a save released before leaving the document', () => {
    it('issues a still-debounced snapshot on request', () => {
      jest.useFakeTimers();

      service.scheduleSave(VIEWER_ID, [createGridItem({ cols: 9 })]);

      jest.advanceTimersByTime(200);

      expect(dataServiceMock.patchUserDashboardLayout).not.toHaveBeenCalled();

      service.releasePendingSave();

      // Same projection, same facade, same version - the quiet period ended early
      // rather than a second way of building a request, which is what keeps the
      // single write origin single.
      expect(dataServiceMock.patchUserDashboardLayout).toHaveBeenCalledTimes(1);
      expect(Object.keys(readPatchedDto(0).modules[0]).sort()).toEqual(
        wireFields
      );
      expect(readPatchedDto(0).modules[0].cols).toBe(9);
      expect(readPatchedDto(0).version).toBe(1);
    });

    it('issues nothing when no arrangement is pending', () => {
      service.releasePendingSave();

      expect(dataServiceMock.patchUserDashboardLayout).not.toHaveBeenCalled();
      expect(consoleErrorSpy).not.toHaveBeenCalled();
    });

    it('issues nothing when the debounced save already went out', () => {
      jest.useFakeTimers();

      service.scheduleSave(VIEWER_ID, [createGridItem()]);

      jest.advanceTimersByTime(500);

      expect(dataServiceMock.patchUserDashboardLayout).toHaveBeenCalledTimes(1);

      service.releasePendingSave();

      // Idempotent, because the caller cannot know whether the window had already
      // elapsed - and a second write of the same arrangement would be a wasted
      // request rather than a wrong one, which is not a reason to allow it.
      expect(dataServiceMock.patchUserDashboardLayout).toHaveBeenCalledTimes(1);
    });

    it('issues once however many times it is asked', () => {
      jest.useFakeTimers();

      service.scheduleSave(VIEWER_ID, [createGridItem()]);

      jest.advanceTimersByTime(200);

      service.releasePendingSave();
      service.releasePendingSave();

      expect(dataServiceMock.patchUserDashboardLayout).toHaveBeenCalledTimes(1);
    });

    it('leaves the quiet period it ended with nothing to send', () => {
      jest.useFakeTimers();

      service.scheduleSave(VIEWER_ID, [createGridItem()]);

      jest.advanceTimersByTime(200);

      service.releasePendingSave();

      // The release ends the quiet period rather than running alongside it, so the
      // buffered arrangement has already left and letting the full window elapse
      // here produces nothing. In the browser the document is usually gone by now,
      // but "usually" is not a guarantee, and a duplicate write of an arrangement
      // nobody changed would be the visible cost.
      jest.advanceTimersByTime(500);

      expect(dataServiceMock.patchUserDashboardLayout).toHaveBeenCalledTimes(1);
    });

    it('leaves nothing for the teardown to release again', () => {
      jest.useFakeTimers();

      service.scheduleSave(VIEWER_ID, [createGridItem()]);

      jest.advanceTimersByTime(200);

      service.releasePendingSave();
      service.ngOnDestroy();

      // Both callers share one pending snapshot, so signing out and then being torn
      // down - which is exactly what happens - must not write twice.
      expect(dataServiceMock.patchUserDashboardLayout).toHaveBeenCalledTimes(1);
    });

    it('contains a failure rather than raising it at the caller', () => {
      dataServiceMock.patchUserDashboardLayout.mockReturnValue(
        throwError(() => createRequestFailure())
      );

      jest.useFakeTimers();

      service.scheduleSave(VIEWER_ID, [createGridItem()]);

      jest.advanceTimersByTime(200);

      // The caller is about to leave the document; an error thrown back at it
      // would abandon the sign-out itself, which is far worse than a lost
      // arrangement.
      expect(() => service.releasePendingSave()).not.toThrow();
      expect(dataServiceMock.patchUserDashboardLayout).toHaveBeenCalledTimes(1);
      expectSanitizedReport('GF-DASHBOARD-LAYOUT-PERSIST-FAILED', 500);
    });

    it('refuses a snapshot belonging to an identity that has since left', () => {
      jest.useFakeTimers();

      service.scheduleSave(VIEWER_ID, [createGridItem()]);

      jest.advanceTimersByTime(200);

      service.beginIdentityTransition();

      service.releasePendingSave();

      // The identity guard is not bypassed by ending the window early. Signing out
      // begins exactly such a transition, so a release that ignored it would write
      // the departing viewer's arrangement with whatever token had replaced theirs.
      expect(dataServiceMock.patchUserDashboardLayout).not.toHaveBeenCalled();
    });

    it('takes its turn behind a write still in flight rather than racing it', () => {
      const firstWrite = new Subject<UserDashboardLayout>();

      dataServiceMock.patchUserDashboardLayout.mockReturnValueOnce(
        firstWrite.asObservable()
      );

      jest.useFakeTimers();

      service.scheduleSave(VIEWER_ID, [createGridItem({ cols: 4 })]);

      jest.advanceTimersByTime(500);

      expect(dataServiceMock.patchUserDashboardLayout).toHaveBeenCalledTimes(1);
      expect(readPatchedDto(0).modules[0].cols).toBe(4);

      // A newer arrangement, then a release of it - while the first request is
      // still unanswered.
      service.scheduleSave(VIEWER_ID, [createGridItem({ cols: 8 })]);
      service.releasePendingSave();

      // Nothing new leaves yet, and that IS the assertion. Sending the newer
      // arrangement now would put a second request on the wire beside one the server
      // may already have accepted, and the two could then commit in either order -
      // leaving the row holding the four-column arrangement the viewer had already
      // moved away from, with nothing outstanding to correct it. Abandoning the
      // first request would not help: unsubscribing withdraws only this client's
      // interest in the reply, never the transaction.
      expect(dataServiceMock.patchUserDashboardLayout).toHaveBeenCalledTimes(1);

      firstWrite.next({ modules: [], version: 1 });
      firstWrite.complete();

      // Once the first write has answered, the released arrangement takes its turn -
      // so it is still written, just second, and the server is left holding it.
      expect(dataServiceMock.patchUserDashboardLayout).toHaveBeenCalledTimes(2);
      expect(readPatchedDto(1).modules[0].cols).toBe(8);
      expect(readStoreLayout().modules[0].cols).toBe(8);

      // The quiet period the newer arrangement never waited out elapses. It must not
      // be written a second time: by now it has been acknowledged, so the dispatcher
      // finds nothing outstanding and skips it.
      jest.advanceTimersByTime(500);

      expect(dataServiceMock.patchUserDashboardLayout).toHaveBeenCalledTimes(2);
    });

    it('reports completion to a caller that waits for it', () => {
      jest.useFakeTimers();

      service.scheduleSave(VIEWER_ID, [createGridItem()]);

      jest.advanceTimersByTime(200);

      let hasCompleted = false;
      let raised: unknown = null;

      service.releasePendingSave().subscribe({
        complete: () => {
          hasCompleted = true;
        },
        error: (error: unknown) => {
          raised = error;
        }
      });

      // The awaitable half of the contract. Signing out holds the document open
      // until it hears this, so a flush that reported nothing would leave the
      // caller either navigating too early or waiting for ever.
      expect(hasCompleted).toBe(true);
      expect(raised).toBeNull();
    });

    it('reports a failure to a caller that waits for it', () => {
      dataServiceMock.patchUserDashboardLayout.mockReturnValue(
        throwError(() => new Error('flush failed'))
      );

      jest.useFakeTimers();

      service.scheduleSave(VIEWER_ID, [createGridItem()]);

      jest.advanceTimersByTime(200);

      let hasCompleted = false;
      let raised: Error = null;

      service.releasePendingSave().subscribe({
        complete: () => {
          hasCompleted = true;
        },
        error: (error: Error) => {
          raised = error;
        }
      });

      // Raised at the caller rather than swallowed, so the departure it precedes
      // can say so instead of leaving silently while the viewer believes the
      // arrangement in front of them was stored.
      expect(hasCompleted).toBe(false);
      expect(raised?.message).toBe('flush failed');
    });

    it('completes at once when there is nothing to flush', () => {
      let hasCompleted = false;

      service.releasePendingSave().subscribe({
        complete: () => {
          hasCompleted = true;
        }
      });

      expect(hasCompleted).toBe(true);
      expect(dataServiceMock.patchUserDashboardLayout).not.toHaveBeenCalled();
    });

    it('keeps a failed arrangement recoverable', () => {
      dataServiceMock.patchUserDashboardLayout.mockReturnValueOnce(
        throwError(() => new Error('flush failed'))
      );

      jest.useFakeTimers();

      service.scheduleSave(VIEWER_ID, [createGridItem({ cols: 7 })]);

      jest.advanceTimersByTime(200);

      service.releasePendingSave().subscribe({
        error: () => {
          return undefined;
        }
      });

      expect(dataServiceMock.patchUserDashboardLayout).toHaveBeenCalledTimes(1);

      // The snapshot survives the failure. Discarded before the request was even
      // made, it would leave the viewer's last arrangement unrecoverable: no retry
      // could reach it and no later flush could send it.
      service.retryFailedSave();

      jest.advanceTimersByTime(500);

      expect(dataServiceMock.patchUserDashboardLayout).toHaveBeenCalledTimes(2);
      expect(readPatchedDto(1).modules[0].cols).toBe(7);
    });

    it('warns the canvas that the flushed arrangement is unsaved', () => {
      dataServiceMock.patchUserDashboardLayout.mockReturnValue(
        throwError(() => new Error('flush failed'))
      );

      jest.useFakeTimers();

      const failures: boolean[] = [];

      service.getHasSaveError().subscribe((hasSaveError) => {
        failures.push(hasSaveError);
      });

      service.scheduleSave(VIEWER_ID, [createGridItem()]);

      jest.advanceTimersByTime(200);

      service.releasePendingSave().subscribe({
        error: () => {
          return undefined;
        }
      });

      // A flush is now an ordinary write in every respect, so its failure raises
      // the same notice any other failed write raises - which is what offers the
      // retry that recovers the snapshot above.
      expect(failures).toEqual([false, true]);
    });

    /**
     * Two properties of the release that only appear when it is asked for twice, or
     * when the quiet period it jumped ahead of finally elapses.
     */
    describe('when a release overlaps the window it jumped', () => {
      /** Records how the returned report settled, in order. */
      const observeRelease = () => {
        const settlements: string[] = [];

        service.releasePendingSave().subscribe({
          complete: () => settlements.push('complete'),
          error: () => settlements.push('error'),
          next: () => settlements.push('next')
        });

        return settlements;
      };

      it('sends one request when a release is asked for twice while in flight', () => {
        let answer: (layout: UserDashboardLayout) => void;

        dataServiceMock.patchUserDashboardLayout.mockReturnValue(
          new Observable<UserDashboardLayout>((subscriber) => {
            answer = (layout) => {
              subscriber.next(layout);
              subscriber.complete();
            };

            return undefined;
          })
        );

        jest.useFakeTimers();

        service.scheduleSave(VIEWER_ID, [createGridItem()]);

        jest.advanceTimersByTime(200);

        const first = observeRelease();
        const second = observeRelease();

        // One request between them, and both callers are told about the same one.
        // A control that releases and the teardown that follows it must not cost two
        // unconditional upserts of the same document.
        expect(dataServiceMock.patchUserDashboardLayout).toHaveBeenCalledTimes(
          1
        );

        answer({ modules: [], version: 1 });

        // `AsyncSubject`-backed, so each report emits once and then completes. The
        // value carries nothing; the settlement is the contract, which is why both
        // sign-out callers depart on `complete` rather than on `next` - and why the
        // toolbar suite pins that they depart exactly once.
        expect(first).toEqual(['next', 'complete']);
        expect(second).toEqual(['next', 'complete']);
      });

      it('does not let the window it jumped send the same snapshot again', () => {
        jest.useFakeTimers();

        service.scheduleSave(VIEWER_ID, [createGridItem()]);

        // Released while its quiet period is still running, so the debounced copy of
        // the very same snapshot is still on its way.
        jest.advanceTimersByTime(200);

        observeRelease();

        expect(dataServiceMock.patchUserDashboardLayout).toHaveBeenCalledTimes(
          1
        );

        // The window elapses. Without the guard on the debounced lane this would be
        // a second unconditional upsert of a document the server already has.
        jest.advanceTimersByTime(500);

        expect(dataServiceMock.patchUserDashboardLayout).toHaveBeenCalledTimes(
          1
        );
      });
    });
  });

  /**
   * The identity boundary.
   *
   * A layout write is authorised by whichever bearer token is in storage when the
   * request is created, and the debounce puts half a second between the
   * arrangement being reported and that moment. Signing in, signing out and
   * creating an account all replace the token inside that window, so without an
   * identity stamped onto each snapshot the previous viewer's arrangement would be
   * written to the account that just arrived. Nothing about that is observable
   * from the request body — the projection is identical either way — so these
   * assertions are the only guard that exists.
   */
  describe('the identity boundary', () => {
    it('refuses a snapshot scheduled before any identity was adopted', () => {
      jest.useFakeTimers();

      service.beginIdentityTransition();
      service.scheduleSave(VIEWER_ID, [createGridItem()]);

      jest.advanceTimersByTime(500);

      // No identity holds write authorisation between a transition beginning and
      // the viewer that follows it being adopted, and an arrangement reported in
      // that interval belongs to whoever was there before. It is dropped rather
      // than deferred.
      expect(dataServiceMock.patchUserDashboardLayout).not.toHaveBeenCalled();
    });

    it('refuses a snapshot whose viewer no longer holds write authorisation', () => {
      jest.useFakeTimers();

      service.scheduleSave(VIEWER_ID, [createGridItem()]);

      jest.advanceTimersByTime(200);

      // The token is replaced mid-debounce. This is the exact defect the stamp
      // exists for: the request below would be authorised as `viewer-2` while
      // carrying `viewer-1`'s arrangement.
      service.adoptIdentity('viewer-2');

      jest.advanceTimersByTime(500);

      expect(dataServiceMock.patchUserDashboardLayout).not.toHaveBeenCalled();
    });

    it('keeps the save stream alive after refusing a stale snapshot', () => {
      jest.useFakeTimers();

      service.scheduleSave(VIEWER_ID, [createGridItem()]);

      jest.advanceTimersByTime(200);

      service.adoptIdentity('viewer-2');

      jest.advanceTimersByTime(500);

      service.scheduleSave('viewer-2', [createGridItem({ cols: 8 })]);

      jest.advanceTimersByTime(500);

      // A refusal must not terminate the stream, or one identity change would
      // disable persistence for the rest of the session.
      expect(dataServiceMock.patchUserDashboardLayout).toHaveBeenCalledTimes(1);
      expect(readPatchedDto(0).modules[0].cols).toBe(8);
    });

    it('persists a snapshot for a newly adopted identity', () => {
      jest.useFakeTimers();

      service.adoptIdentity('viewer-2');
      service.scheduleSave('viewer-2', [createGridItem({ cols: 10 })]);

      jest.advanceTimersByTime(500);

      expect(dataServiceMock.patchUserDashboardLayout).toHaveBeenCalledTimes(1);
      expect(readPatchedDto(0).modules[0].cols).toBe(10);
      // The identity is a client-side authorisation check and never travels: the
      // server derives it from the request itself, and the strict endpoint would
      // reject an unrecognised property outright.
      expect(Object.keys(readPatchedDto(0).modules[0]).sort()).toEqual(
        wireFields
      );
      expect(Object.keys(readPatchedDto(0)).sort()).toEqual([
        'modules',
        'version'
      ]);
    });

    it('discards pending work when a different identity is adopted', () => {
      jest.useFakeTimers();

      service.scheduleSave(VIEWER_ID, [createGridItem()]);

      jest.advanceTimersByTime(200);

      service.adoptIdentity('viewer-2');
      service.ngOnDestroy();

      // The teardown flush reads the same pending snapshot the debounce would
      // have sent, so it has to be discarded at the point the identity changes
      // rather than only screened at dispatch.
      expect(dataServiceMock.patchUserDashboardLayout).not.toHaveBeenCalled();
    });

    it('discards pending work when a transition begins', () => {
      jest.useFakeTimers();

      service.scheduleSave(VIEWER_ID, [createGridItem()]);

      jest.advanceTimersByTime(200);

      service.beginIdentityTransition();
      service.ngOnDestroy();

      expect(dataServiceMock.patchUserDashboardLayout).not.toHaveBeenCalled();
    });

    it('refuses the teardown flush of a snapshot that names no viewer', () => {
      jest.useFakeTimers();

      // What the canvas reports when a grid callback fires before a viewer has
      // resolved: a real arrangement belonging to nobody in particular. The flush
      // applies the same check the debounced dispatch does rather than trusting
      // that its caller already screened it, because destruction is one of the
      // ways an identity ends.
      service.scheduleSave(undefined, [createGridItem()]);

      jest.advanceTimersByTime(200);

      service.ngOnDestroy();

      expect(dataServiceMock.patchUserDashboardLayout).not.toHaveBeenCalled();
    });

    it('adopting the identity already held changes nothing', () => {
      jest.useFakeTimers();

      service.scheduleSave(VIEWER_ID, [createGridItem({ cols: 8 })]);

      jest.advanceTimersByTime(200);

      // The viewer store emits for reasons that have nothing to do with identity
      // — a settings write, a refreshed subscription — and the canvas re-asserts
      // the identity on each of them. Doing so must not discard a save the viewer
      // has just made.
      service.adoptIdentity(VIEWER_ID);

      jest.advanceTimersByTime(500);

      expect(dataServiceMock.patchUserDashboardLayout).toHaveBeenCalledTimes(1);
      expect(readPatchedDto(0).modules[0].cols).toBe(8);
    });

    it('announces a transition to whoever is producing arrangements', () => {
      let announcements = 0;

      const subscription = service.identityTransition$.subscribe(() => {
        announcements += 1;
      });

      service.beginIdentityTransition();
      service.adoptIdentity('viewer-2');

      subscription.unsubscribe();

      // Only a transition announces itself. Adopting an identity is the *end* of
      // one, and its caller has already quiesced what it owns, so emitting there
      // would ask the canvas to invalidate an arrangement it is in the middle of
      // hydrating.
      expect(announcements).toBe(1);
    });
  });

  /**
   * The single write origin, asserted as an architectural fact rather than
   * trusted as a convention.
   *
   * Every other test in this file describes what the service does; these describe
   * how many ways it can do it, which is a property no amount of behaviour can
   * express. "One dispatcher and one request expression" is satisfied by a service
   * with two call sites whose second one merely happens not to be reached by any
   * test - so the count is read off the source, exactly as the global theme suite
   * reads its stylesheet.
   *
   * A second call site would compile, would pass every test above whenever its
   * request happened to answer first, and would only misbehave under a timing
   * nobody can arrange on demand. Reading the source is the only way to observe
   * the thing being forbidden.
   */

  /**
   * The concurrency token, and what it is for.
   *
   * Two clients of one account each hold the arrangement they read. Without a
   * token the second one to save silently replaces the first one's dashboard,
   * because a layout is a whole document and the write says nothing about what it
   * was built on. The token is the row's own `updatedAt`, carried on the read and
   * handed back on the write, which turns the write into "replace the arrangement
   * I read" rather than "replace whatever is there".
   *
   * It is transport-only: it describes the ROW, never the arrangement, so it must
   * not travel inside the stored document and must not survive a change of
   * identity.
   */
  describe('the concurrency token', () => {
    const REVISION = '2026-01-01T00:00:00.000Z';

    const SUPERSEDING_REVISION = '2026-02-02T12:30:00.000Z';

    it('carries the token it read back on the next write', () => {
      jest.useFakeTimers();

      dataServiceMock.fetchUserDashboardLayout.mockReturnValue(
        of({
          modules: [{ cols: 6, moduleType: 'holdings', rows: 4, x: 0, y: 0 }],
          revision: REVISION,
          version: 1
        })
      );

      service.get(true).subscribe();

      service.scheduleSave(VIEWER_ID, [createGridItem()]);

      jest.advanceTimersByTime(500);

      expect(readPatchedDto(0).revision).toBe(REVISION);
    });

    it('adopts the token the write produced, so the write after it is not refused', () => {
      jest.useFakeTimers();

      dataServiceMock.fetchUserDashboardLayout.mockReturnValue(
        of({
          modules: [{ cols: 6, moduleType: 'holdings', rows: 4, x: 0, y: 0 }],
          revision: REVISION,
          version: 1
        })
      );

      service.get(true).subscribe();

      dataServiceMock.patchUserDashboardLayout.mockImplementation(
        (aData: UpdateUserDashboardLayoutDto) =>
          of({
            modules: aData.modules,
            revision: SUPERSEDING_REVISION,
            version: 1
          })
      );

      service.scheduleSave(VIEWER_ID, [createGridItem()]);

      jest.advanceTimersByTime(500);

      service.scheduleSave(VIEWER_ID, [createGridItem({ cols: 8 })]);

      jest.advanceTimersByTime(500);

      // The row has moved on, so a second write still carrying the token the first
      // one superseded would be refused - and every write after it too.
      expect(readPatchedDto(1).revision).toBe(SUPERSEDING_REVISION);
    });

    it('omits the token entirely when it holds none, rather than sending an empty one', () => {
      jest.useFakeTimers();

      service.scheduleSave(VIEWER_ID, [createGridItem()]);

      jest.advanceTimersByTime(500);

      // Absent means unconditional, and the API validates with
      // `forbidNonWhitelisted`. A key present but undefined is neither of those
      // things, so the key set is asserted rather than the value.
      expect(Object.keys(readPatchedDto(0)).sort()).toEqual([
        'modules',
        'version'
      ]);
      expect(readPatchedDto(0)).not.toHaveProperty('revision');
    });

    it('drops the token when a different viewer is adopted', () => {
      jest.useFakeTimers();

      dataServiceMock.fetchUserDashboardLayout.mockReturnValue(
        of({
          modules: [{ cols: 6, moduleType: 'holdings', rows: 4, x: 0, y: 0 }],
          revision: REVISION,
          version: 1
        })
      );

      service.get(true).subscribe();

      // The token belongs to the previous viewer's row. Carrying it into the next
      // viewer's first write would have that write compared against a revision of
      // somebody else's row.
      service.adoptIdentity('viewer-2');

      service.scheduleSave('viewer-2', [createGridItem()]);

      jest.advanceTimersByTime(500);

      expect(readPatchedDto(0)).not.toHaveProperty('revision');
    });
  });

  /**
   * What happens when the row has moved past the arrangement being written.
   *
   * The refusal is reported rather than retried, because the two things that can
   * be done about it - take the newer document, or overwrite it - are choices only
   * the viewer can make. It is deliberately NOT reported as a save failure: the
   * write did not fail, it was declined, and the retry a failure offers would be
   * declined again for exactly the same reason.
   */
  describe('a write the row has moved past', () => {
    /**
     * A refusal as the facade really rejects with one.
     *
     * A real `HttpErrorResponse` rather than the plain stand-in the other failure
     * tests use, because the service narrows the refusal on the response TYPE as
     * well as the status - a plain object carrying `status: 409` is deliberately
     * not a conflict, so a stand-in here would assert the fallback path instead.
     * It still carries every marker a leak would expose, so the reporting contract
     * stays under test.
     */
    const createConflict = () =>
      new HttpErrorResponse({
        error: { detail: `rejected for ${SECRET_TOKEN}` },
        status: 409,
        statusText: 'Conflict',
        url: SECRET_URL
      });

    it('does not mistake a status carried on a plain object for a refusal', () => {
      jest.useFakeTimers();

      const conflicts: boolean[] = [];

      service.getHasConflict().subscribe((hasConflict) => {
        conflicts.push(hasConflict);
      });

      dataServiceMock.patchUserDashboardLayout.mockReturnValue(
        throwError(() => createRequestFailure({ status: 409 }))
      );

      service.scheduleSave(VIEWER_ID, [createGridItem()]);

      jest.advanceTimersByTime(500);

      expect(conflicts).toEqual([false]);
    });

    it('reports a conflict rather than a save failure', () => {
      jest.useFakeTimers();

      const conflicts: boolean[] = [];
      const failures: boolean[] = [];

      service.getHasConflict().subscribe((hasConflict) => {
        conflicts.push(hasConflict);
      });

      service.getHasSaveError().subscribe((hasSaveError) => {
        failures.push(hasSaveError);
      });

      dataServiceMock.patchUserDashboardLayout.mockReturnValue(
        throwError(() => createConflict())
      );

      service.scheduleSave(VIEWER_ID, [createGridItem()]);

      jest.advanceTimersByTime(500);

      expect(conflicts).toEqual([false, true]);
      expect(failures).toEqual([false]);
    });

    it('reports a failure that is not a conflict as a failure', () => {
      jest.useFakeTimers();

      const conflicts: boolean[] = [];

      service.getHasConflict().subscribe((hasConflict) => {
        conflicts.push(hasConflict);
      });

      dataServiceMock.patchUserDashboardLayout.mockReturnValue(
        throwError(() => createRequestFailure({ status: 500 }))
      );

      service.scheduleSave(VIEWER_ID, [createGridItem()]);

      jest.advanceTimersByTime(500);

      expect(conflicts).toEqual([false]);
    });

    it('keeps holding the refused arrangement so the viewer can still choose to keep it', () => {
      jest.useFakeTimers();

      dataServiceMock.patchUserDashboardLayout.mockReturnValue(
        throwError(() => createConflict())
      );

      service.scheduleSave(VIEWER_ID, [createGridItem({ cols: 8 })]);

      jest.advanceTimersByTime(500);

      dataServiceMock.patchUserDashboardLayout.mockImplementation(
        (aData: UpdateUserDashboardLayoutDto) =>
          of({ modules: aData.modules, version: 1 })
      );

      service.overwriteAfterConflict();

      jest.advanceTimersByTime(500);

      // The arrangement written is the one that was refused, not a rebuilt one: the
      // canvas hands over nothing here, so if the snapshot had been dropped there
      // would be nothing left to keep.
      expect(dataServiceMock.patchUserDashboardLayout).toHaveBeenCalledTimes(2);
      expect(readPatchedDto(1).modules).toEqual([
        { cols: 8, moduleType: 'portfolio-overview', rows: 4, x: 0, y: 0 }
      ]);
    });

    it('writes the kept arrangement unconditionally, which is what makes the overwrite deliberate', () => {
      jest.useFakeTimers();

      dataServiceMock.fetchUserDashboardLayout.mockReturnValue(
        of({
          modules: [{ cols: 6, moduleType: 'holdings', rows: 4, x: 0, y: 0 }],
          revision: '2026-01-01T00:00:00.000Z',
          version: 1
        })
      );

      service.get(true).subscribe();

      dataServiceMock.patchUserDashboardLayout.mockReturnValue(
        throwError(() => createConflict())
      );

      service.scheduleSave(VIEWER_ID, [createGridItem()]);

      jest.advanceTimersByTime(500);

      expect(readPatchedDto(0).revision).toBe('2026-01-01T00:00:00.000Z');

      dataServiceMock.patchUserDashboardLayout.mockImplementation(
        (aData: UpdateUserDashboardLayoutDto) =>
          of({ modules: aData.modules, version: 1 })
      );

      service.overwriteAfterConflict();

      jest.advanceTimersByTime(500);

      // Dropping the token is the whole mechanism: a conditional write would be
      // refused again for exactly the same reason it was refused the first time. The
      // member is absent rather than present-and-undefined, because absence is what
      // the server reads as unconditional.
      expect(readPatchedDto(1)).not.toHaveProperty('revision');
      expect(Object.keys(readPatchedDto(1)).sort()).toEqual([
        'modules',
        'version'
      ]);
    });

    it('clears the conflict when it is dismissed', () => {
      jest.useFakeTimers();

      const conflicts: boolean[] = [];

      dataServiceMock.patchUserDashboardLayout.mockReturnValue(
        throwError(() => createConflict())
      );

      service.scheduleSave(VIEWER_ID, [createGridItem()]);

      jest.advanceTimersByTime(500);

      service.getHasConflict().subscribe((hasConflict) => {
        conflicts.push(hasConflict);
      });

      service.dismissConflict();

      expect(conflicts).toEqual([true, false]);
    });

    it('drops the refused arrangement when it is dismissed, so taking the newer one cannot resurrect it', () => {
      jest.useFakeTimers();

      dataServiceMock.patchUserDashboardLayout.mockReturnValue(
        throwError(() => createConflict())
      );

      service.scheduleSave(VIEWER_ID, [createGridItem()]);

      jest.advanceTimersByTime(500);

      service.dismissConflict();

      dataServiceMock.patchUserDashboardLayout.mockImplementation(
        (aData: UpdateUserDashboardLayoutDto) =>
          of({ modules: aData.modules, version: 1 })
      );

      // Nothing may re-enter the queue afterwards: the release before a departure
      // and the retry after a failure both re-send whatever is still pending, and a
      // dismissed arrangement is one the viewer has decided against.
      service.releasePendingSave();

      jest.advanceTimersByTime(500);

      expect(dataServiceMock.patchUserDashboardLayout).toHaveBeenCalledTimes(1);
    });
  });

  /**
   * Discarding the stored arrangement.
   *
   * The reason this exists is that a document this build cannot interpret leaves
   * the canvas refusing every write, so the dashboard is unreachable from the UI
   * without it. It is emphatically not a fifth persistence trigger: it stores no
   * arrangement, which is why the endpoint behind it is a DELETE.
   */
  describe('discarding the stored arrangement', () => {
    it('deletes rather than writing an emptied arrangement', () => {
      service.discard().subscribe();

      expect(dataServiceMock.deleteUserDashboardLayout).toHaveBeenCalledTimes(
        1
      );
      expect(dataServiceMock.patchUserDashboardLayout).not.toHaveBeenCalled();
    });

    it('leaves the store reporting a genuine absence rather than a stale layout', () => {
      jest.useFakeTimers();

      dataServiceMock.fetchUserDashboardLayout.mockReturnValue(
        of({
          modules: [{ cols: 6, moduleType: 'holdings', rows: 4, x: 0, y: 0 }],
          version: 1
        })
      );

      service.get(true).subscribe();

      expect(readStoreLayout()).not.toBeNull();

      service.discard().subscribe();

      // `null` is the store's "fetched and absent", which is exactly the state the
      // account is now in - and it is what opens the catalog on the next read
      // rather than serving the document that was just deleted.
      expect(readStoreLayout()).toBeNull();
      expect(readStoreAction()).toBe(
        DashboardLayoutStoreActions.DeleteDashboardLayout
      );
    });

    it('never serves the discarded document again, even unforced', () => {
      dataServiceMock.fetchUserDashboardLayout.mockReturnValue(
        of({
          modules: [{ cols: 6, moduleType: 'holdings', rows: 4, x: 0, y: 0 }],
          version: 1
        })
      );

      service.get(true).subscribe();
      service.discard().subscribe();

      dataServiceMock.fetchUserDashboardLayout.mockReturnValue(of(null));

      let served: UserDashboardLayout = {
        modules: [],
        version: 1
      };

      // Unforced, which is the read a later hydration makes. The cache was
      // invalidated by the discard rather than merely overwritten, so this goes back
      // to the endpoint instead of answering from a state the client inferred - and
      // either way the document that was deleted can never be handed back.
      service.get().subscribe((layout) => {
        served = layout;
      });

      expect(served).toBeNull();
      expect(dataServiceMock.fetchUserDashboardLayout).toHaveBeenCalledTimes(2);
    });

    it('drops a pending arrangement, so nothing writes the dashboard back after it was discarded', () => {
      jest.useFakeTimers();

      service.scheduleSave(VIEWER_ID, [createGridItem()]);

      service.discard().subscribe();

      jest.advanceTimersByTime(500);

      // The pending snapshot was produced from the arrangement being destroyed. A
      // debounce window that outlived the discard would re-create the very row the
      // viewer asked to be rid of.
      expect(dataServiceMock.patchUserDashboardLayout).not.toHaveBeenCalled();
    });

    it('drops the token, so the first write after a discard is unconditional', () => {
      jest.useFakeTimers();

      dataServiceMock.fetchUserDashboardLayout.mockReturnValue(
        of({
          modules: [{ cols: 6, moduleType: 'holdings', rows: 4, x: 0, y: 0 }],
          revision: '2026-01-01T00:00:00.000Z',
          version: 1
        })
      );

      service.get(true).subscribe();
      service.discard().subscribe();

      service.scheduleSave(VIEWER_ID, [createGridItem()]);

      jest.advanceTimersByTime(500);

      // There is no row for the token to be compared against, so a conditional write
      // would be refused and the viewer's first arrangement after starting over
      // would never be stored.
      expect(readPatchedDto(0)).not.toHaveProperty('revision');
    });

    it('clears an outstanding conflict, because the document it was about is gone', () => {
      jest.useFakeTimers();

      const conflicts: boolean[] = [];

      dataServiceMock.patchUserDashboardLayout.mockReturnValue(
        throwError(
          () =>
            new HttpErrorResponse({
              status: 409,
              statusText: 'Conflict',
              url: SECRET_URL
            })
        )
      );

      service.scheduleSave(VIEWER_ID, [createGridItem()]);

      jest.advanceTimersByTime(500);

      service.getHasConflict().subscribe((hasConflict) => {
        conflicts.push(hasConflict);
      });

      service.discard().subscribe();

      expect(conflicts).toEqual([true, false]);
    });

    it('reports a failed discard to its caller and changes nothing', () => {
      dataServiceMock.fetchUserDashboardLayout.mockReturnValue(
        of({
          modules: [{ cols: 6, moduleType: 'holdings', rows: 4, x: 0, y: 0 }],
          version: 1
        })
      );

      service.get(true).subscribe();

      dataServiceMock.deleteUserDashboardLayout.mockReturnValue(
        throwError(() => createRequestFailure({ status: 500 }))
      );

      let reported: unknown = null;

      service.discard().subscribe({
        error: (error: unknown) => {
          reported = error;
        }
      });

      // Nothing was destroyed, so the store must not say it was: a cleared slice
      // here would leave the canvas showing a blank dashboard over a row that is
      // still stored.
      expect(reported).not.toBeNull();
      expect(readStoreLayout()).not.toBeNull();
    });

    it('reports a failed discard without disclosing what the request carried', () => {
      dataServiceMock.deleteUserDashboardLayout.mockReturnValue(
        throwError(() => createRequestFailure({ status: 500 }))
      );

      service.discard().subscribe({
        error: () => undefined
      });

      expectSanitizedReport('GF-DASHBOARD-LAYOUT-DISCARD-FAILED', 500);
    });
  });

  describe('the single write origin', () => {
    /** Resolved from this spec's own location, so the walk cannot drift. */
    const clientAppDirectory = join(__dirname, '..', '..');

    /** Every non-spec TypeScript source under the client application tree. */
    const collectSources = (directory: string): string[] => {
      return readdirSync(directory, { withFileTypes: true }).flatMap(
        (entry) => {
          const path = join(directory, entry.name);

          if (entry.isDirectory()) {
            return collectSources(path);
          }

          return entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts')
            ? [path]
            : [];
        }
      );
    };

    const source = readFileSync(
      join(__dirname, 'dashboard-layout.service.ts'),
      'utf8'
    );

    it('builds a layout request in exactly one place', () => {
      // A second call site is how a release, a retry or a teardown quietly becomes
      // its own write origin, bypassing the debounce, the identity check or the
      // supersession rule that the one place applies.
      expect(source.match(/patchUserDashboardLayout\(/g)).toHaveLength(1);
    });

    it('is the only file in the client application that writes a layout', () => {
      const writers = collectSources(clientAppDirectory).filter((path) => {
        return readFileSync(path, 'utf8').includes('patchUserDashboardLayout(');
      });

      expect(writers).toEqual([join(__dirname, 'dashboard-layout.service.ts')]);
    });

    it('feeds that place from one dispatcher fed by two merged lanes', () => {
      // The debounced lane carries every ordinary change and the immediate lane
      // carries a released one. They are merged BEFORE the dispatcher, so a
      // release takes its turn in the same queue instead of opening a second one.
      expect(source.match(/^ {4}merge\($/gm)).toHaveLength(1);
      expect(source.match(/debounceTime\(/g)).toHaveLength(1);
      expect(source.match(/concatMap\(/g)).toHaveLength(1);
      expect(source).toContain('debounceTime(SAVE_DEBOUNCE_IN_MS)');
    });

    it('serialises rather than cancels, deliberately', () => {
      // The operator choice is load-bearing rather than incidental, and it is the
      // one thing behaviour cannot fully pin: an operator that cancels looks
      // identical to one that serialises in every test where the abandoned request
      // happens never to have been accepted. Unsubscribing from `HttpClient`
      // withdraws only this client's interest in the reply, so a request the server
      // has already accepted still commits - and could commit after a newer one.
      // Serialising is what makes the stored document deterministic, so no operator
      // that can leave two writes outstanding may appear here.
      expect(source).not.toMatch(/switchMap\(/);
      expect(source).not.toMatch(/mergeMap\(/);
      expect(source).not.toMatch(/exhaustMap\(/);

      // And not imported either, so a future edit cannot reach for one without the
      // import line making it obvious.
      const operatorImport = /from 'rxjs\/operators';/.exec(source);

      expect(operatorImport).not.toBeNull();
      expect(source.slice(0, operatorImport.index)).not.toMatch(
        /switchMap|mergeMap|exhaustMap/
      );
    });

    it('exposes no method that subscribes to a request of its own', () => {
      // The three public entry points that re-send an arrangement - the release
      // before a departure, the retry after a failure, and the overwrite after a
      // refusal - all hand the pending snapshot back to a subject the one dispatcher
      // drains, and stop there. The overwrite differs only in dropping the
      // concurrency token, which is what makes it unconditional; it builds no body
      // of its own and issues no request of its own.
      expect(source).toContain('public releasePendingSave(): Observable<void>');
      expect(source).toContain('public retryFailedSave()');
      expect(source).toContain('public overwriteAfterConflict()');
      expect(source.match(/this\.snapshot\$\.next\(/g)).toHaveLength(3);
      expect(source.match(/this\.immediateSnapshot\$\.next\(/g)).toHaveLength(
        1
      );

      // The one write call in the file, so no entry point can have grown a second
      // request path of its own. The discard beside it is a DELETE and stores no
      // arrangement, which is exactly why recovering from an uninterpretable layout
      // does not count as a write.
      expect(
        source.match(/this\.dataService\.patchUserDashboardLayout\(/g)
      ).toHaveLength(1);
      expect(
        source.match(/this\.dataService\.deleteUserDashboardLayout\(/g)
      ).toHaveLength(1);

      // Two subscriptions, both internal and neither of them to the facade: the
      // dispatcher itself, and the one that reports a released snapshot's outcome
      // back to the caller awaiting it. The discard is returned to its caller
      // unsubscribed, so it adds none.
      expect(source.match(/\.subscribe\(/g)).toHaveLength(2);
    });
  });

  /**
   * What a failure is allowed to say, as distinct from whether one is reported.
   *
   * Each of the three failing paths above now asserts its report exactly, and
   * this group covers what those assertions rest on: that the failure they are
   * given genuinely carries the things that must not leak, that the identifier
   * belongs to the path that emitted it, and that the statusless shape is
   * handled too. Without the first of these the marker sweep would pass over a
   * failure that never contained a marker, and every one of those assertions
   * would be decoration.
   */
  describe('the shape of a reported failure', () => {
    it('builds a failure that really does carry everything that must not leak', () => {
      // The positive control. If this ever stops holding, the sweeps elsewhere in
      // this file stop meaning anything, and they would go on passing.
      const failure = createRequestFailure();

      const serialised = [
        failure.message,
        failure.stack,
        failure.url,
        failure.viewer,
        JSON.stringify(failure.error)
      ].join(' ');

      for (const marker of SENSITIVE_MARKERS) {
        expect(serialised).toContain(marker);
      }

      expect(failure.status).toBe(500);
    });

    it('reports a failure that carries no status as the bare identifier', () => {
      // Not every rejection is an HTTP response: an interceptor, a serialisation
      // fault or an offline browser rejects with a plain error, and the report has
      // to stay a single sanitized string for those too.
      dataServiceMock.fetchUserDashboardLayout.mockReturnValue(
        throwError(() => new Error(`viewer@example.test lost ${SECRET_TOKEN}`))
      );

      service.get(true).subscribe({ error: () => undefined });

      expectSanitizedReport('GF-DASHBOARD-LAYOUT-FETCH-FAILED');
    });

    it.each([
      {
        act: () => {
          service.get(true).subscribe({ error: () => undefined });
        },
        arrange: () => {
          dataServiceMock.fetchUserDashboardLayout.mockReturnValue(
            throwError(() => createRequestFailure({ status: 503 }))
          );
        },
        eventId: 'GF-DASHBOARD-LAYOUT-FETCH-FAILED',
        path: 'a read'
      },
      {
        act: () => {
          service.scheduleSave(VIEWER_ID, [createGridItem()]);

          jest.advanceTimersByTime(500);
        },
        arrange: () => {
          jest.useFakeTimers();

          dataServiceMock.patchUserDashboardLayout.mockReturnValue(
            throwError(() => createRequestFailure({ status: 503 }))
          );
        },
        eventId: 'GF-DASHBOARD-LAYOUT-PERSIST-FAILED',
        path: 'a debounced write'
      },
      {
        act: () => {
          service.scheduleSave(VIEWER_ID, [createGridItem()]);

          jest.advanceTimersByTime(200);

          service.releasePendingSave();
        },
        arrange: () => {
          jest.useFakeTimers();

          dataServiceMock.patchUserDashboardLayout.mockReturnValue(
            throwError(() => createRequestFailure({ status: 503 }))
          );
        },
        eventId: 'GF-DASHBOARD-LAYOUT-PERSIST-FAILED',
        path: 'a flush'
      }
    ])(
      'reports $path under its own identifier and nothing else',
      ({ act, arrange, eventId }) => {
        arrange();

        act();

        // Pinned per path, so a copied handler that kept a neighbour's identifier
        // is caught: the identifier is the only thing a reader of the log has to
        // tell the three apart with.
        expectSanitizedReport(eventId, 503);
      }
    );
  });
});
