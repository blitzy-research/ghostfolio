import { UpdateUserDashboardLayoutDto } from '@ghostfolio/common/dtos';
import { UserDashboardLayout } from '@ghostfolio/common/interfaces';
import { DataService } from '@ghostfolio/ui/services';

import { TestBed } from '@angular/core/testing';
import { Observable, of, throwError } from 'rxjs';

import { DashboardModuleType } from '../enums/dashboard-module-type';
import { DashboardLayoutItem } from '../interfaces/interfaces';
import { DashboardLayoutStoreActions } from './dashboard-layout-store.actions';
import { GfDashboardLayoutService } from './dashboard-layout.service';

/**
 * `GfDashboardLayoutService` is the single origin of every dashboard layout
 * write, so this spec is where the persistence contract is pinned down. Four
 * properties of the service carry consequences that no compiler can catch and
 * that only assertions here can protect:
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
 * 3. Operator placement. `catchError` sits *inside* the switched request. Were
 *    it on the outer pipe, the first network hiccup would terminate the save
 *    stream permanently; only a successful save *after* a failed one proves the
 *    placement.
 * 4. Trigger exclusivity. Every one of the four grid callbacks feeds one
 *    subject, and a burst inside the debounce window must collapse to a single
 *    request carrying the newest complete snapshot.
 *
 * Two library facts shape the harness and are asserted through the public
 * surface rather than assumed:
 *
 * - `ObservableStore.getState()` is `protected`, so store contents are read
 *   here through the public, fully typed `stateHistory` getter (the service
 *   enables `trackStateHistory`) and through the service's own `get()`
 *   contract. That is strictly stronger than reading state, because it also
 *   pins the dispatched action name.
 * - `ObservableStore` keeps one shared store for the whole module registry, and
 *   its deep clone drops `undefined` values, so a freshly constructed service
 *   cannot reset `layout` to the not-yet-fetched sentinel. Every test that
 *   needs a network read therefore forces it with `get(true)`, and the
 *   unforced `get()` is used only to prove a cache hit after a known write.
 *   That keeps every test independent of execution order without resetting
 *   state that other services share.
 */
describe('GfDashboardLayoutService', () => {
  let consoleErrorSpy: jest.SpyInstance;
  let dataServiceMock: {
    fetchUserDashboardLayout: jest.Mock<Observable<UserDashboardLayout>, []>;
    patchUserDashboardLayout: jest.Mock<
      Observable<UserDashboardLayout>,
      [UpdateUserDashboardLayoutDto]
    >;
  };
  let service: GfDashboardLayoutService;

  /**
   * The complete wire contract for one persisted grid item, in sorted order.
   * Nothing else may reach the endpoint, and nothing here may be missing.
   */
  const wireFields = ['cols', 'moduleType', 'rows', 'x', 'y'];

  /**
   * Every member of the grid engine's item configuration that the canvas may
   * hand over and the endpoint would reject, plus two arbitrary keys the index
   * signature allows.
   */
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
   * Builds a grid item the way the canvas hands one over: the five persisted
   * coordinates surrounded by the engine's own bookkeeping. Every extra member
   * below is a real property of the grid engine's item configuration, so the
   * projection has
   * something to strip in every test rather than only in the one that checks
   * for stripping.
   *
   * The spread is deliberate and belongs to a fixture builder. It is precisely
   * what the service must never do when building the request body.
   */
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

  /** The request body of the n-th PATCH the service issued. */
  const readPatchedDto = (index: number): UpdateUserDashboardLayoutDto =>
    dataServiceMock.patchUserDashboardLayout.mock.calls[index][0];

  /**
   * The store action most recently dispatched. `trackStateHistory` appends one
   * entry per `setState`, so the last entry always describes the current store.
   */
  const readStoreAction = (): string => {
    const history = service.stateHistory;

    return history[history.length - 1].action;
  };

  /** The layout currently held by the store, read through the same entry. */
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
      // An absent row is the default because it is what every brand-new user
      // has: the layout column is nullable and nothing seeds it.
      fetchUserDashboardLayout: jest.fn(() => of(null)),
      // The endpoint answers a write with the layout it stored, so the default
      // mock echoes the request back. Declaring the parameter also keeps the
      // mock's call signature identical to the facade's, which is what makes
      // `mock.calls[n][0]` typed and every assertion below cast-free.
      patchUserDashboardLayout: jest.fn((aData: UpdateUserDashboardLayoutDto) =>
        of({ modules: aData.modules, version: 1 })
      )
    };

    service = createService();
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
      // The first entry in the shared history belongs to the first service ever
      // constructed in this module registry, so it is the only place where the
      // pristine store is observable regardless of test order. Its begin state
      // is the uninitialised store and its end state carries no layout at all —
      // `undefined`, not `null`. That distinction is what lets `get()` tell a
      // never-read store from one that read an absent row.
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
      // A missing row must not be dressed up as an empty layout: the canvas owns
      // that interpretation and needs the two states to stay distinguishable.
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

      // A returning user's canvas hydrates from exactly what was stored, so the
      // read path must be a pass-through in both directions.
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
      // Every brand-new user has no persisted row, so `null` is the single most
      // common cached value. A truthiness-based cache check would treat it as a
      // miss and re-read the endpoint on every access for precisely the users
      // this feature exists to onboard.
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
      service.scheduleSave([
        createGridItem(),
        createGridItem({
          moduleType: DashboardModuleType.HOLDINGS,
          x: 6
        })
      ]);

      // itemChangeCallback: the second module was dragged one row down.
      service.scheduleSave([
        createGridItem(),
        createGridItem({
          moduleType: DashboardModuleType.HOLDINGS,
          x: 6,
          y: 4
        })
      ]);

      // itemResizeCallback: the second module was widened to the full grid.
      service.scheduleSave([
        createGridItem(),
        createGridItem({
          cols: 12,
          moduleType: DashboardModuleType.HOLDINGS,
          x: 0,
          y: 4
        })
      ]);

      // itemRemovedCallback: the first module was removed, leaving one behind.
      service.scheduleSave([
        createGridItem({
          cols: 12,
          moduleType: DashboardModuleType.HOLDINGS,
          x: 0,
          y: 4
        })
      ]);

      // The 499/1 split pins the boundary at exactly 500 ms rather than merely
      // "eventually": a burst of four callbacks costs one request, not four.
      jest.advanceTimersByTime(499);

      expect(dataServiceMock.patchUserDashboardLayout).not.toHaveBeenCalled();

      jest.advanceTimersByTime(1);

      expect(dataServiceMock.patchUserDashboardLayout).toHaveBeenCalledTimes(1);
      // Only the newest snapshot survives, and it is complete rather than a
      // delta — the removed module is absent because the canvas no longer holds
      // it, not because a difference was computed.
      expect(readPatchedDto(0)).toEqual({
        modules: [{ cols: 12, moduleType: 'holdings', rows: 4, x: 0, y: 4 }],
        version: 1
      });
    });

    it('projects each item to exactly the five wire fields', () => {
      jest.useFakeTimers();

      service.scheduleSave([
        createGridItem({
          callbackSpy: () => undefined,
          id: 'should-not-be-sent',
          initCallback: () => undefined,
          name: 'should-not-be-sent'
        })
      ]);

      jest.advanceTimersByTime(500);

      const dto = readPatchedDto(0);

      // The API validates with `forbidNonWhitelisted: true`, so one surplus
      // property is an HTTP 400 rather than a cosmetic problem. The grid item's
      // index signature means the compiler cannot see the leak, which is why the
      // key set is asserted outright.
      expect(Object.keys(dto.modules[0]).sort()).toEqual(wireFields);
      expect(Object.keys(dto).sort()).toEqual(['modules', 'version']);
      expect(dto.version).toBe(1);

      for (const strippedField of strippedFields) {
        expect(dto.modules[0]).not.toHaveProperty(strippedField);
      }

      // A surviving callback would additionally make the body unserialisable,
      // so both properties are checked: no functions, and a lossless round trip
      // through JSON.
      expect(
        Object.values(dto.modules[0]).every(
          (value) => typeof value !== 'function'
        )
      ).toBe(true);
      expect(JSON.parse(JSON.stringify(dto))).toEqual(dto);
    });

    it('projects an empty snapshot to an empty modules array', () => {
      jest.useFakeTimers();

      service.scheduleSave([]);

      jest.advanceTimersByTime(500);

      // Removing the last module is a legitimate save, not a no-op: the empty
      // canvas has to survive a reload.
      expect(dataServiceMock.patchUserDashboardLayout).toHaveBeenCalledTimes(1);
      expect(readPatchedDto(0).modules).toEqual([]);
      expect(readPatchedDto(0).version).toBe(1);
    });

    it('does not clamp or coerce geometry values', () => {
      jest.useFakeTimers();

      service.scheduleSave([
        createGridItem({ cols: 1, rows: 1, x: 99, y: -3 })
      ]);

      jest.advanceTimersByTime(500);

      // Minimum and maximum dimensions are enforced by the grid engine's
      // validation callback on the client and by the DTO's bounds on the server.
      // Silently repairing them here would hide a canvas defect behind a
      // plausible-looking payload and make the server-side bounds untestable.
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

      service.scheduleSave([
        createGridItem({ moduleType: DashboardModuleType.AI_CHAT }),
        createGridItem({ moduleType: DashboardModuleType.X_RAY, x: 6 })
      ]);

      jest.advanceTimersByTime(500);

      // The persisted discriminator has to stay a plain string, unmapped and
      // unrenamed, so that the registry can resolve known types and drop
      // retired ones per item instead of failing the whole layout.
      const persistedTypes = readPatchedDto(0).modules.map(
        (module) => module.moduleType
      );

      expect(persistedTypes).toEqual(['ai-chat', 'x-ray']);
    });

    it('persists each subsequent debounced snapshot', () => {
      jest.useFakeTimers();

      service.scheduleSave([createGridItem()]);

      jest.advanceTimersByTime(500);

      expect(dataServiceMock.patchUserDashboardLayout).toHaveBeenCalledTimes(1);

      service.scheduleSave([createGridItem({ cols: 8, x: 2 })]);

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

    it('cancels an in-flight PATCH when a newer snapshot arrives', () => {
      const firstTeardown = jest.fn();
      const first$ = new Observable<UserDashboardLayout>(() => firstTeardown);

      dataServiceMock.patchUserDashboardLayout
        .mockReturnValueOnce(first$)
        .mockReturnValueOnce(of({ modules: [], version: 1 }));

      jest.useFakeTimers();

      service.scheduleSave([createGridItem()]);

      jest.advanceTimersByTime(500);

      expect(dataServiceMock.patchUserDashboardLayout).toHaveBeenCalledTimes(1);
      expect(firstTeardown).not.toHaveBeenCalled();

      service.scheduleSave([createGridItem({ cols: 8 })]);

      jest.advanceTimersByTime(500);

      // Unsubscribing the older request is exactly `switchMap` semantics, and it
      // is safe here only because every body is a complete, idempotent snapshot:
      // replacing an in-flight write with a newer full snapshot always converges
      // on the latest state. A delta payload would corrupt the stored layout on
      // cancellation and would make `concatMap` mandatory instead.
      expect(dataServiceMock.patchUserDashboardLayout).toHaveBeenCalledTimes(2);
      expect(firstTeardown).toHaveBeenCalled();
      expect(readPatchedDto(1).modules[0].cols).toBe(8);
    });

    it('updates store state from a successful PATCH response', () => {
      const persisted: UserDashboardLayout = {
        modules: [{ cols: 6, moduleType: 'holdings', rows: 4, x: 0, y: 0 }],
        version: 1
      };

      dataServiceMock.patchUserDashboardLayout.mockReturnValue(of(persisted));

      jest.useFakeTimers();

      service.scheduleSave([
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
      service.scheduleSave(null);

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

      service.scheduleSave([createGridItem()]);

      expect(() => jest.advanceTimersByTime(500)).not.toThrow();
      expect(dataServiceMock.patchUserDashboardLayout).toHaveBeenCalledTimes(1);
      expect(consoleErrorSpy).toHaveBeenCalled();

      service.scheduleSave([createGridItem({ cols: 8 })]);

      jest.advanceTimersByTime(500);

      // A second save only happens if the recovery sits *inside* the switched
      // request. On the outer pipe it would have terminated the whole stream and
      // persistence would be dead for the rest of the session — a failure mode
      // nothing else in the suite can detect.
      expect(dataServiceMock.patchUserDashboardLayout).toHaveBeenCalledTimes(2);
      expect(readPatchedDto(1).modules[0].cols).toBe(8);
    });

    it('does not update store state when a PATCH fails', () => {
      dataServiceMock.patchUserDashboardLayout.mockReturnValue(
        throwError(() => new Error('PATCH failed'))
      );

      jest.useFakeTimers();

      service.scheduleSave([createGridItem()]);

      jest.advanceTimersByTime(500);

      // The recovery emits nothing usable, so the store must be left exactly as
      // the initialize action left it rather than being overwritten with a
      // failure value.
      expect(readStoreAction()).toBe(DashboardLayoutStoreActions.Initialize);
      expect(readStoreAction()).not.toBe(
        DashboardLayoutStoreActions.UpdateDashboardLayout
      );
      expect(consoleErrorSpy).toHaveBeenCalled();
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
      // Swallowing a failed read into an empty layout would impersonate a
      // brand-new user and wrongly open the module catalog over a canvas whose
      // modules are merely unreachable.
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

      service.scheduleSave([createGridItem({ cols: 8 })]);

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

      service.scheduleSave([createGridItem()]);

      jest.advanceTimersByTime(200);

      service.ngOnDestroy();
      service.ngOnDestroy();

      // The environment injector destroys the service again after this test
      // body, so the pending flag has to be cleared on the first flush rather
      // than merely on the first timer tick.
      expect(dataServiceMock.patchUserDashboardLayout).toHaveBeenCalledTimes(1);
    });

    it('does not flush after the debounced save already dispatched', () => {
      jest.useFakeTimers();

      service.scheduleSave([createGridItem()]);

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

      service.scheduleSave([createGridItem()]);

      jest.advanceTimersByTime(200);

      // A failure while the page is going away has nowhere to surface, so it is
      // logged and contained: an unhandled error here would break teardown for
      // every consumer of the service.
      expect(() => service.ngOnDestroy()).not.toThrow();
      expect(dataServiceMock.patchUserDashboardLayout).toHaveBeenCalledTimes(1);
      expect(consoleErrorSpy).toHaveBeenCalled();
    });
  });
});
