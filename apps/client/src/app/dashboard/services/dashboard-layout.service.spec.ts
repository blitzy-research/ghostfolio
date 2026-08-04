import { UpdateUserDashboardLayoutDto } from '@ghostfolio/common/dtos';
import { UserDashboardLayout } from '@ghostfolio/common/interfaces';
import { DataService } from '@ghostfolio/ui/services';

import { TestBed } from '@angular/core/testing';
import { ObservableStore } from '@codewithdan/observable-store';
import type { StateHistory } from '@codewithdan/observable-store';
import { Observable, of, throwError } from 'rxjs';

import { DashboardModuleType } from '../enums/dashboard-module-type';
import { DashboardLayoutItem } from '../interfaces/interfaces';
import { DashboardLayoutStoreActions } from './dashboard-layout-store.actions';
import type { DashboardLayoutStoreState } from './dashboard-layout-store.state';
import { GfDashboardLayoutService } from './dashboard-layout.service';

/**
 * A burst of triggers inside the debounce window must collapse to one request
 * carrying the newest *complete* snapshot, and two snapshots that escape the same
 * window must reach the server in the order they were reported. The second half is
 * what an in-flight cancellation cannot deliver: unsubscribing from a response does
 * not withdraw a request the server has already accepted, and because the endpoint
 * upserts a whole document, two requests in flight leave the stored arrangement
 * decided by commit order. The writes are therefore serialised, and a snapshot a
 * newer one has already superseded is dropped rather than replayed.
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
 *    request carrying the newest complete snapshot.
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

    it('holds a newer snapshot back until the in-flight PATCH settles, instead of cancelling it', () => {
      const firstTeardown = jest.fn();
      let completeFirst: () => void;

      const first$ = new Observable<UserDashboardLayout>((subscriber) => {
        completeFirst = () => {
          subscriber.next({ modules: [], version: 1 });
          subscriber.complete();
        };

        return firstTeardown;
      });

      dataServiceMock.patchUserDashboardLayout
        .mockReturnValueOnce(first$)
        .mockReturnValueOnce(of({ modules: [], version: 1 }));

      jest.useFakeTimers();

      service.scheduleSave(VIEWER_ID, [createGridItem()]);

      jest.advanceTimersByTime(500);

      expect(dataServiceMock.patchUserDashboardLayout).toHaveBeenCalledTimes(1);
      expect(firstTeardown).not.toHaveBeenCalled();

      service.scheduleSave(VIEWER_ID, [createGridItem({ cols: 8 })]);

      jest.advanceTimersByTime(500);

      // The older request is deliberately NOT unsubscribed, and the newer one is
      // deliberately NOT sent yet. Unsubscribing is only ever a cancellation on
      // this side of the wire: by now the first request has very likely been
      // accepted by the server, and dropping the response does not withdraw it.
      // Because the endpoint upserts a whole document, two requests in flight
      // leave the stored arrangement decided by which one the database commits
      // last rather than by the order the viewer made the changes in - a drag
      // whose result silently reverts. Serialising removes the possibility.
      expect(dataServiceMock.patchUserDashboardLayout).toHaveBeenCalledTimes(1);
      expect(firstTeardown).not.toHaveBeenCalled();

      completeFirst();

      // Only once the first write has settled does the second go out, so the last
      // document the server sees is by construction the last one reported.
      expect(dataServiceMock.patchUserDashboardLayout).toHaveBeenCalledTimes(2);
      expect(readPatchedDto(1).modules[0].cols).toBe(8);
    });

    it('sends only the newest arrangement when several queue behind an in-flight PATCH', () => {
      let completeFirst: () => void;

      const first$ = new Observable<UserDashboardLayout>((subscriber) => {
        completeFirst = () => {
          subscriber.next({ modules: [], version: 1 });
          subscriber.complete();
        };
      });

      dataServiceMock.patchUserDashboardLayout
        .mockReturnValueOnce(first$)
        .mockReturnValue(of({ modules: [], version: 1 }));

      jest.useFakeTimers();

      service.scheduleSave(VIEWER_ID, [createGridItem({ cols: 4 })]);

      jest.advanceTimersByTime(500);

      service.scheduleSave(VIEWER_ID, [createGridItem({ cols: 6 })]);

      jest.advanceTimersByTime(500);

      service.scheduleSave(VIEWER_ID, [createGridItem({ cols: 8 })]);

      jest.advanceTimersByTime(500);

      expect(dataServiceMock.patchUserDashboardLayout).toHaveBeenCalledTimes(1);

      completeFirst();

      // Serialising must not mean replaying. Every snapshot is a complete
      // arrangement, so the intermediate one describes nothing the newest one
      // does not - sending it would spend a round trip writing a document the very
      // next request contradicts. Exactly two requests therefore leave: the one
      // that was already in flight, and the newest.
      expect(dataServiceMock.patchUserDashboardLayout).toHaveBeenCalledTimes(2);
      expect(readPatchedDto(1).modules[0].cols).toBe(8);
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
  });

  describe('error handling', () => {
    it('keeps the save stream alive after a PATCH failure', () => {
      dataServiceMock.patchUserDashboardLayout
        .mockReturnValueOnce(throwError(() => new Error('PATCH failed')))
        .mockReturnValueOnce(of({ modules: [], version: 1 }));

      jest.useFakeTimers();

      service.scheduleSave(VIEWER_ID, [createGridItem()]);

      expect(() => jest.advanceTimersByTime(500)).not.toThrow();
      expect(dataServiceMock.patchUserDashboardLayout).toHaveBeenCalledTimes(1);
      expect(consoleErrorSpy).toHaveBeenCalled();

      service.scheduleSave(VIEWER_ID, [createGridItem({ cols: 8 })]);

      jest.advanceTimersByTime(500);

      expect(dataServiceMock.patchUserDashboardLayout).toHaveBeenCalledTimes(2);
      expect(readPatchedDto(1).modules[0].cols).toBe(8);
    });

    it('does not update store state when a PATCH fails', () => {
      dataServiceMock.patchUserDashboardLayout.mockReturnValue(
        throwError(() => new Error('PATCH failed'))
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
      expect(consoleErrorSpy).toHaveBeenCalled();
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

    it('retains the failed snapshot so it can still be flushed on destroy', () => {
      dataServiceMock.patchUserDashboardLayout.mockReturnValueOnce(
        throwError(() => new Error('PATCH failed'))
      );

      jest.useFakeTimers();

      service.scheduleSave(VIEWER_ID, [createGridItem({ cols: 8, x: 2 })]);

      jest.advanceTimersByTime(500);

      expect(dataServiceMock.patchUserDashboardLayout).toHaveBeenCalledTimes(1);

      service.ngOnDestroy();

      // Discarding the snapshot before the write was acknowledged would lose the
      // newest arrangement permanently, with nothing left to flush.
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
      const failure = new Error('GET failed');

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
      expect(consoleErrorSpy).toHaveBeenCalled();
      expect(emissions).toBe(0);
      expect(emitted).toBeUndefined();
      expect(emitted).not.toEqual({ modules: [] });
      expect(readStoreAction()).not.toBe(
        DashboardLayoutStoreActions.GetDashboardLayout
      );
    });
  });

  describe('teardown flush', () => {
    it('flushes a still-debounced snapshot on destroy', () => {
      jest.useFakeTimers();

      service.scheduleSave(VIEWER_ID, [createGridItem({ cols: 8 })]);

      jest.advanceTimersByTime(200);

      expect(dataServiceMock.patchUserDashboardLayout).not.toHaveBeenCalled();

      service.ngOnDestroy();

      // The flush travels the same projection path as a debounced save — it is a
      // shortcut through the timer, not a second way of building a request. It
      // also uses the same data service facade, because the layout endpoint
      // takes PATCH and no fire-and-forget transport can issue one; closing the
      // browser tab inside the debounce window therefore remains an accepted
      // loss window rather than an excuse to invent a transport.
      expect(dataServiceMock.patchUserDashboardLayout).toHaveBeenCalledTimes(1);
      expect(Object.keys(readPatchedDto(0).modules[0]).sort()).toEqual(
        wireFields
      );
      expect(readPatchedDto(0).modules[0].cols).toBe(8);
      expect(readPatchedDto(0).version).toBe(1);
    });

    it('does not flush twice when destroyed repeatedly', () => {
      jest.useFakeTimers();

      service.scheduleSave(VIEWER_ID, [createGridItem()]);

      jest.advanceTimersByTime(200);

      service.ngOnDestroy();
      service.ngOnDestroy();

      expect(dataServiceMock.patchUserDashboardLayout).toHaveBeenCalledTimes(1);
    });

    it('does not flush after the debounced save already dispatched', () => {
      jest.useFakeTimers();

      service.scheduleSave(VIEWER_ID, [createGridItem()]);

      jest.advanceTimersByTime(500);

      expect(dataServiceMock.patchUserDashboardLayout).toHaveBeenCalledTimes(1);

      service.ngOnDestroy();

      expect(dataServiceMock.patchUserDashboardLayout).toHaveBeenCalledTimes(1);
    });

    it('does not flush when nothing was ever scheduled', () => {
      service.ngOnDestroy();

      expect(dataServiceMock.patchUserDashboardLayout).not.toHaveBeenCalled();
      expect(consoleErrorSpy).not.toHaveBeenCalled();
    });

    it('reports a failed flush without throwing', () => {
      dataServiceMock.patchUserDashboardLayout.mockReturnValue(
        throwError(() => new Error('flush failed'))
      );

      jest.useFakeTimers();

      service.scheduleSave(VIEWER_ID, [createGridItem()]);

      jest.advanceTimersByTime(200);

      // A failure while the page is going away has nowhere to surface, so it is
      // logged and contained: an unhandled error here would break teardown for
      // every consumer of the service.
      expect(() => service.ngOnDestroy()).not.toThrow();
      expect(dataServiceMock.patchUserDashboardLayout).toHaveBeenCalledTimes(1);
      expect(consoleErrorSpy).toHaveBeenCalled();
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
});
