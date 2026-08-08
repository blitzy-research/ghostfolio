import { NotificationService } from '@ghostfolio/ui/notifications';

import { TestBed } from '@angular/core/testing';

import { LazyDialogService } from './lazy-dialog.service';

/**
 * Loading a dialog's own chunk on demand.
 *
 * Chunk loading happens in the components that open dialogs rather than in the
 * router, so the slowness and the failure the router would have absorbed have to be
 * handled here instead.
 *
 * Three properties are worth a test each, and none of them is visible in a type:
 *
 * 1. **Deduplication.** `import()` settles on a later tick, so a second activation
 *    while the first is still resolving would otherwise start a second open. That
 *    is not a hypothetical: it is one impatient second click.
 * 2. **A reported, visible failure.** An unhandled rejection leaves a control that
 *    appeared to do nothing.
 * 3. **Release on settlement.** A failure must cost one attempt, not the
 *    affordance: the next press has to genuinely try again.
 */
describe('LazyDialogService', () => {
  class TestDialogComponent {}

  let notificationServiceMock: { alert: jest.Mock };
  let consoleErrorSpy: jest.SpyInstance;
  let service: LazyDialogService;

  /**
   * A loader whose settlement this suite controls, standing in for the dynamic
   * `import()` a caller performs. Returned alongside its resolve and reject
   * handles, because WHEN it settles is what most of these tests are about.
   */
  const createDeferredLoader = () => {
    let reject: (reason: unknown) => void;
    let resolve: (component: TestDialogComponent) => void;

    const load = jest.fn(() => {
      return new Promise<TestDialogComponent>(
        (resolvePromise, rejectPromise) => {
          reject = rejectPromise;
          resolve = resolvePromise;
        }
      );
    });

    return {
      load,
      reject: (reason: unknown) => reject(reason),
      resolve: (component: TestDialogComponent) => resolve(component)
    };
  };

  /** The titles the viewer was shown, in order. */
  const alertedTitles = () => {
    return (
      notificationServiceMock.alert.mock.calls as [{ title: string }][]
    ).map(([params]) => {
      return params.title;
    });
  };

  /**
   * The sanitized event identifiers that were reported, in order.
   *
   * Typed as strings because that is what the sanitized channel emits: an
   * identifier, and the numeric status where the failure has one. The caught value
   * itself is deliberately never passed through, which is the property this reads
   * back.
   */
  const reportedEvents = () => {
    return (consoleErrorSpy.mock.calls as [string][]).map(([report]) => {
      return report;
    });
  };

  /** Yields until every pending microtask has run. */
  const settle = () => {
    return Promise.resolve().then(() => undefined);
  };

  beforeEach(() => {
    // The service reports every failure through `console.error`. Spying keeps the
    // expected reports out of the test output and makes them assertable.
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {
      return undefined;
    });

    notificationServiceMock = { alert: jest.fn() };

    TestBed.configureTestingModule({
      providers: [
        LazyDialogService,
        { provide: NotificationService, useValue: notificationServiceMock }
      ]
    });

    service = TestBed.inject(LazyDialogService);
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  it('resolves the component the loader produced', async () => {
    const component = new TestDialogComponent();

    await expect(
      service.load('test-dialog', () => Promise.resolve(component))
    ).resolves.toBe(component);

    expect(notificationServiceMock.alert).not.toHaveBeenCalled();
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it('loads once for concurrent requests and answers both', async () => {
    const component = new TestDialogComponent();
    const loader = createDeferredLoader();

    const first = service.load('test-dialog', loader.load);
    const second = service.load('test-dialog', loader.load);

    // One chunk request between them. Two would open two copies of the same
    // dialog, which is what an impatient second click would otherwise cause.
    expect(loader.load).toHaveBeenCalledTimes(1);

    loader.resolve(component);

    await expect(first).resolves.toBe(component);
    await expect(second).resolves.toBe(component);
  });

  it('reports that a request is outstanding, and stops once it settles', async () => {
    const loader = createDeferredLoader();

    expect(service.isLoading('test-dialog')).toBe(false);

    const attempt = service.load('test-dialog', loader.load);

    // What a caller binds its disabled state to, so that the wait is visible
    // rather than merely survivable.
    expect(service.isLoading('test-dialog')).toBe(true);

    loader.resolve(new TestDialogComponent());

    await attempt;

    expect(service.isLoading('test-dialog')).toBe(false);
  });

  it('keeps requests for different dialogs independent', async () => {
    const first = new TestDialogComponent();
    const second = new TestDialogComponent();

    const firstLoad = jest.fn(() => Promise.resolve(first));
    const secondLoad = jest.fn(() => Promise.resolve(second));

    await expect(service.load('first-dialog', firstLoad)).resolves.toBe(first);
    await expect(service.load('second-dialog', secondLoad)).resolves.toBe(
      second
    );

    expect(firstLoad).toHaveBeenCalledTimes(1);
    expect(secondLoad).toHaveBeenCalledTimes(1);
  });

  describe('a chunk that cannot be loaded', () => {
    it('tells the viewer, reports it, and answers with nothing', async () => {
      const attempt = service.load('test-dialog', () => {
        return Promise.reject(new Error('chunk load failed'));
      });

      // Nothing to open, and the caller is told so rather than left with an
      // unhandled rejection.
      await expect(attempt).resolves.toBeNull();

      expect(notificationServiceMock.alert).toHaveBeenCalledTimes(1);
      expect(alertedTitles()).toEqual(['Oops! Something went wrong.']);

      // Reported without the caught value, which is the sanitized channel's whole
      // point: the identifier says which dialog failed and nothing about the
      // viewer.
      expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
      expect(reportedEvents()).toEqual([
        'GF-LAZY-DIALOG-LOAD-FAILED-test-dialog'
      ]);
    });

    it('lets the next request try again', async () => {
      const component = new TestDialogComponent();

      await service.load('test-dialog', () => {
        return Promise.reject(new Error('chunk load failed'));
      });

      // The pending entry is released however the attempt settled, so a transient
      // failure costs one attempt rather than the control itself.
      expect(service.isLoading('test-dialog')).toBe(false);

      await expect(
        service.load('test-dialog', () => Promise.resolve(component))
      ).resolves.toBe(component);

      expect(notificationServiceMock.alert).toHaveBeenCalledTimes(1);
    });

    it('answers a concurrent request with the same failure', async () => {
      const loader = createDeferredLoader();

      const first = service.load('test-dialog', loader.load);
      const second = service.load('test-dialog', loader.load);

      loader.reject(new Error('chunk load failed'));

      await expect(first).resolves.toBeNull();
      await expect(second).resolves.toBeNull();

      // One report and one alert, not one per caller: the viewer is told about the
      // failure, not about how many things were waiting on it.
      expect(notificationServiceMock.alert).toHaveBeenCalledTimes(1);
      expect(consoleErrorSpy).toHaveBeenCalledTimes(1);

      await settle();

      expect(service.isLoading('test-dialog')).toBe(false);
    });
  });
});
