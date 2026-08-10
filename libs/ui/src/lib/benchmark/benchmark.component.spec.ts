import { DashboardModuleType } from '@ghostfolio/common/dashboard';
import { AssetProfileIdentifier } from '@ghostfolio/common/interfaces';
import { NotificationService } from '@ghostfolio/ui/notifications';

import { ComponentFixture, TestBed } from '@angular/core/testing';
import { MatDialog } from '@angular/material/dialog';
import { ActivatedRoute, NavigationExtras, Router } from '@angular/router';
import { readFileSync } from 'fs';
import { join } from 'path';
import { BehaviorSubject, Subject } from 'rxjs';

import { GfBenchmarkDetailDialogComponent } from './benchmark-detail-dialog/benchmark-detail-dialog.component';
import { GfBenchmarkComponent } from './benchmark.component';

// Stood in for rather than resolved: this spec asserts *which* component the
// dialog was asked for and with what, never how that dialog renders, and the real
// one reaches a chart stack and the data facade to do it. The identity assertion
// stays exact because the symbol imported above is the stand-in.
jest.mock(
  './benchmark-detail-dialog/benchmark-detail-dialog.component',
  () => ({
    GfBenchmarkDetailDialogComponent: class {}
  })
);

/**
 * Query-parameter ownership, asserted from inside the component that owns it.
 *
 * Three modules mount this component - markets, premium markets and the watchlist
 * - and on the single-canvas shell all three can be on screen at once. All three
 * therefore observe the *same* query parameters, because the canvas is one route
 * and every dialog on it is addressed by rewriting that route's parameters. The
 * request said nothing about which of the three it was for, so a single selection
 * opened the benchmark detail dialog up to three times over, stacked one on top of
 * the next.
 *
 * What fixed it is an owner discriminator: the producer names itself in
 * `dialogModule`, and each consumer answers only when that value equals its own.
 * Nothing in the compiler enforces that equality gate, and no other suite can
 * observe it - `benchmark-comparator.component.spec.ts` covers a different
 * component entirely, and the application's own suites stand this component in for
 * a double. Removing the gate would reintroduce up to three dialogs and every
 * other test in the workspace would stay green.
 *
 * Four properties are pinned here, and each is a defect that has actually
 * happened or is one edit away:
 *
 * 1. **Exactly one owner answers.** The matching instance opens; the others do
 *    nothing at all.
 * 2. **A re-observed request is not a new one.** Every producer on the canvas
 *    merges its parameters, so these are re-emitted whenever any *other* module
 *    writes to the URL. Keying on the request rather than on the dialog's
 *    lifecycle is what stops those emissions stacking copies - while still letting
 *    a request that was withdrawn and made again open the dialog a second time.
 * 3. **The producer names its owner.** Without the discriminator in the payload
 *    there is nothing for the gate to match, so the fix is only half present.
 * 4. **Closing clears what it travelled on, and only that.** The navigation this
 *    replaced named a route segment, which dropped every query parameter on the
 *    canvas: closing this dialog also closed a sibling module's and discarded the
 *    shared-portfolio access identifier along with it.
 *
 * The harness gives all instances ONE `ActivatedRoute`, which is the whole point:
 * a per-instance stream could not reproduce the defect, because the defect is that
 * the stream is shared.
 */
describe('GfBenchmarkComponent', () => {
  const dataSource = 'YAHOO';
  const symbol = 'VOO';

  /** The request the URL makes when a benchmark's detail dialog is wanted. */
  const requestFor = ({
    asset = { dataSource, symbol },
    owner
  }: {
    asset?: AssetProfileIdentifier;
    owner: DashboardModuleType | undefined;
  }) => ({
    benchmarkDetailDialog: true,
    dataSource: asset.dataSource,
    dialogModule: owner,
    symbol: asset.symbol
  });

  let activatedRouteMock: {
    queryParams: BehaviorSubject<Record<string, unknown>>;
  };

  /** Every dialog request made, with the subject that closes it. */
  let dialogRequests: {
    afterClosed: Subject<void>;
    component: unknown;
    config: { data?: Record<string, unknown>; height?: string; width?: string };
  }[];

  let dialogOpen: jest.Mock;
  let fixtures: ComponentFixture<GfBenchmarkComponent>[];
  let queryParams: BehaviorSubject<Record<string, unknown>>;
  let routerMock: {
    navigate: jest.Mock<
      ReturnType<Router['navigate']>,
      Parameters<Router['navigate']>
    >;
  };

  /**
   * Mounts one instance standing for one module.
   *
   * The inputs are set before the first change detection because two of them are
   * required: `benchmarks` is read inside an effect, which runs on that first
   * pass, and `dialogModule` is read by the query-parameter handler, which the
   * constructor subscribes synchronously. The stream therefore starts empty - an
   * initial emission carrying no request short-circuits before the discriminator
   * is read, which is what makes constructing the instance safe at all.
   */
  const mount = (owner: DashboardModuleType) => {
    const fixture = TestBed.createComponent(GfBenchmarkComponent);

    fixture.componentRef.setInput('benchmarks', []);
    fixture.componentRef.setInput('deviceType', 'desktop');
    fixture.componentRef.setInput('dialogModule', owner);

    fixture.detectChanges();

    fixtures.push(fixture);

    return fixture;
  };

  /** The three modules that really do mount this component side by side. */
  const mountEveryHost = () => {
    return {
      markets: mount(DashboardModuleType.MARKETS),
      marketsPremium: mount(DashboardModuleType.MARKETS_PREMIUM),
      watchlist: mount(DashboardModuleType.WATCHLIST)
    };
  };

  /**
   * Asks an instance to open the dialog, as its own overflow menu does.
   *
   * Reached through a narrowly typed view of the instance because the handler is
   * `protected`: it is part of the template's contract rather than the public API,
   * and the alternative - rendering a row, opening a `MatMenu` and clicking
   * through its overlay - would assert Material's own behaviour in place of the
   * payload this test is about.
   */
  const askToOpen = (
    fixture: ComponentFixture<GfBenchmarkComponent>,
    asset: AssetProfileIdentifier = { dataSource, symbol }
  ) => {
    (
      fixture.componentInstance as unknown as {
        onOpenBenchmarkDialog: (aAsset: AssetProfileIdentifier) => void;
      }
    ).onOpenBenchmarkDialog(asset);
  };

  /**
   * The extras of the n-th navigation, which is where the payload lives.
   *
   * The extras are optional on `Router.navigate` and this library type-checks its
   * specs with `strictNullChecks`, so their presence is asserted rather than
   * assumed - a navigation issued without them is itself a defect, and it is
   * better reported as a failed expectation than as a type error. The narrowed
   * return type is what lets every assertion below read the payload directly.
   */
  const navigationExtras = (index: number) => {
    const [, extras] = routerMock.navigate.mock.calls[index];

    expect(extras).toBeDefined();

    return extras as NavigationExtras & {
      queryParams: Record<string, unknown>;
    };
  };

  beforeEach(async () => {
    dialogRequests = [];
    fixtures = [];
    queryParams = new BehaviorSubject<Record<string, unknown>>({});

    dialogOpen = jest.fn(
      (
        component: unknown,
        config: {
          data?: Record<string, unknown>;
          height?: string;
          width?: string;
        }
      ) => {
        const afterClosed = new Subject<void>();

        dialogRequests.push({ afterClosed, component, config });

        return { afterClosed: () => afterClosed.asObservable() };
      }
    );

    routerMock = {
      navigate: jest.fn<
        ReturnType<Router['navigate']>,
        Parameters<Router['navigate']>
      >(() => Promise.resolve(true))
    };

    // One route object for every instance, and it is handed back as
    // `relativeTo` as well, so a navigation that resolved against something else
    // would be visible rather than merely wrong.
    activatedRouteMock = { queryParams };

    await TestBed.configureTestingModule({
      imports: [GfBenchmarkComponent],
      providers: [
        { provide: ActivatedRoute, useValue: activatedRouteMock },
        { provide: MatDialog, useValue: { open: dialogOpen } },
        { provide: NotificationService, useValue: { confirm: jest.fn() } },
        { provide: Router, useValue: routerMock }
      ]
    }).compileComponents();
  });

  afterEach(() => {
    for (const fixture of fixtures) {
      fixture.destroy();
    }
  });

  /**
   * The name of a row's actions trigger.
   *
   * The trigger opens a menu whose only item deletes, and the label it carried was
   * a fixed sentence naming a KIND - "Actions for this benchmark". That was wrong
   * twice over. It named the wrong kind in the watchlist, whose rows are watchlist
   * items rather than benchmarks; and being fixed, it was identical on every row,
   * so a reader moving through the table heard the same name for each of them with
   * nothing to say which holding they were about to remove. On the single canvas the
   * duplication ran across tables as well, because all three hosting modules can be
   * on screen at once.
   *
   * Asserted through the label-composing method rather than by rendering rows and
   * reading the DOM, because a rendered row would put Material's table and menu
   * between the assertion and the string under test. The template's use of it is
   * asserted from the template source below, which is the other half.
   */
  describe("naming a row's actions", () => {
    const labelFor = (
      fixture: ComponentFixture<GfBenchmarkComponent>,
      benchmark: unknown
    ) => {
      return (
        fixture.componentInstance as unknown as {
          getItemActionsLabel: (aBenchmark: unknown) => string;
        }
      ).getItemActionsLabel(benchmark);
    };

    it('names the row rather than a kind of row', () => {
      const fixture = mount(DashboardModuleType.WATCHLIST);

      const label = labelFor(fixture, { name: 'Apple Inc.', symbol: 'AAPL' });

      expect(label).toContain('Apple Inc.');

      // The word that made the label wrong in one of its three hosts. Its absence
      // is what makes the same label correct in all three.
      expect(label.toLowerCase()).not.toContain('benchmark');
    });

    it('gives two rows two different names', () => {
      const fixture = mount(DashboardModuleType.MARKETS);

      expect(
        labelFor(fixture, { name: 'Apple Inc.', symbol: 'AAPL' })
      ).not.toBe(
        labelFor(fixture, { name: 'Microsoft Corp.', symbol: 'MSFT' })
      );
    });

    it('falls back to the symbol when a profile carries no name', () => {
      const fixture = mount(DashboardModuleType.MARKETS);

      expect(labelFor(fixture, { name: null, symbol: 'AAPL' })).toContain(
        'AAPL'
      );

      // Both forms are text the row itself shows - the name first, the symbol
      // beneath it - so the spoken name is never something the viewer cannot see.
      expect(labelFor(fixture, { name: '', symbol: 'AAPL' })).toContain('AAPL');
    });

    it('survives a row with neither', () => {
      const fixture = mount(DashboardModuleType.MARKETS);

      // A table is rendered before its data arrives, so the label must not throw on
      // a partial row - a thrown expression in a template binding abandons the whole
      // render pass.
      expect(() => labelFor(fixture, undefined)).not.toThrow();
      expect(() => labelFor(fixture, {})).not.toThrow();
    });

    it('is what the trigger is actually named by', () => {
      const template = readFileSync(
        join(__dirname, 'benchmark.component.html'),
        'utf8'
      );

      expect(template).toContain(
        '[attr.aria-label]="getItemActionsLabel(element)"'
      );

      // The label this replaced. Left behind anywhere it would still be announced,
      // because an `aria-label` attribute beside the binding would win or conflict
      // depending on order.
      expect(template).not.toContain('Actions for this benchmark');
    });
  });

  describe('answering a request on the shared query stream', () => {
    it('opens on the instance the request names, and on no other', () => {
      mountEveryHost();

      queryParams.next(requestFor({ owner: DashboardModuleType.MARKETS }));

      // One dialog for one selection. Three instances observed the request and
      // two of them recognised it was not theirs.
      expect(dialogOpen).toHaveBeenCalledTimes(1);

      const [request] = dialogRequests;

      expect(request.component).toBe(GfBenchmarkDetailDialogComponent);
      expect(request.config.data).toEqual(
        expect.objectContaining({ dataSource, symbol })
      );
    });

    it.each([
      {
        description: 'a module none of the mounted instances stands for',
        owner: DashboardModuleType.X_RAY
      },
      {
        description: 'no module at all',
        owner: undefined
      }
    ])('opens nothing when the request names $description', ({ owner }) => {
      mountEveryHost();

      queryParams.next(requestFor({ owner }));

      // The unnamed case is the defect itself: before the discriminator existed
      // every instance treated an unaddressed request as its own, and this one
      // selection opened three dialogs.
      expect(dialogOpen).not.toHaveBeenCalled();
    });

    it.each([
      { description: 'the dialog flag', omitted: 'benchmarkDetailDialog' },
      { description: 'the data source', omitted: 'dataSource' },
      { description: 'the symbol', omitted: 'symbol' }
    ])('opens nothing when $description is missing', ({ omitted }) => {
      mountEveryHost();

      const request = requestFor({ owner: DashboardModuleType.MARKETS });

      delete request[omitted as keyof typeof request];

      // All three identify the asset, so a partial request is not a request. The
      // canvas produces plenty of them: every other module's navigation merges,
      // so these parameters are observed in every intermediate combination.
      queryParams.next(request);

      expect(dialogOpen).not.toHaveBeenCalled();
    });

    it('opens once however many times the same request is re-observed', () => {
      const { markets } = mountEveryHost();

      const request = requestFor({ owner: DashboardModuleType.MARKETS });

      for (let emission = 0; emission < 4; emission += 1) {
        // Merging is what re-notifies these consumers: a sibling module writing an
        // unrelated parameter re-emits this request unchanged. Each of those must
        // not stack another copy of a dialog that is already open.
        queryParams.next({ ...request, unrelated: emission });
      }

      expect(dialogOpen).toHaveBeenCalledTimes(1);
      expect(markets).toBeTruthy();
    });

    it('reopens after the request is withdrawn and made again', () => {
      mountEveryHost();

      const request = requestFor({ owner: DashboardModuleType.MARKETS });

      queryParams.next(request);

      expect(dialogOpen).toHaveBeenCalledTimes(1);

      // Withdrawn, which is what closing the dialog does to the URL.
      queryParams.next({});

      expect(dialogOpen).toHaveBeenCalledTimes(1);

      // Asked for again. Keying on the request rather than on the dialog is what
      // makes the same benchmark openable a second time.
      queryParams.next(request);

      expect(dialogOpen).toHaveBeenCalledTimes(2);
    });

    it('opens again when the request moves to a different asset', () => {
      mountEveryHost();

      queryParams.next(requestFor({ owner: DashboardModuleType.MARKETS }));
      queryParams.next(
        requestFor({
          asset: { dataSource, symbol: 'AAPL' },
          owner: DashboardModuleType.MARKETS
        })
      );

      expect(dialogOpen).toHaveBeenCalledTimes(2);
      expect(dialogRequests[1].config.data).toEqual(
        expect.objectContaining({ symbol: 'AAPL' })
      );
    });

    it('hands ownership over when the request moves to a sibling module', () => {
      mountEveryHost();

      queryParams.next(requestFor({ owner: DashboardModuleType.MARKETS }));
      queryParams.next(requestFor({ owner: DashboardModuleType.WATCHLIST }));

      // The same asset, addressed to a different owner. The second instance opens
      // it because the request is new *to it*, and the first does not reopen.
      expect(dialogOpen).toHaveBeenCalledTimes(2);
    });

    it('issues no navigation of its own while merely observing', () => {
      mountEveryHost();

      queryParams.next(requestFor({ owner: DashboardModuleType.MARKETS }));

      // Opening in response to the URL must not rewrite the URL: that would put
      // the consumer and the producer in a loop.
      expect(routerMock.navigate).not.toHaveBeenCalled();
    });
  });

  describe('producing a request', () => {
    it('addresses the dialog to itself and stands down the flags it takes over', () => {
      const { markets } = mountEveryHost();

      askToOpen(markets);

      expect(routerMock.navigate).toHaveBeenCalledTimes(1);

      const [commands] = routerMock.navigate.mock.calls[0];
      const extras = navigationExtras(0);

      // An empty command list addresses the current route, which is the canvas -
      // naming a segment is what would discard every other parameter on it.
      expect(commands).toEqual([]);
      expect(extras.queryParamsHandling).toBe('merge');
      expect(extras.relativeTo).toBe(activatedRouteMock);

      // Exact, not partial. `dataSource` and `symbol` are shared identifiers that
      // three flags read, so merging obliges this producer to stand down the two
      // it is taking them from - the asset profile dialog in the market data
      // module and the holding detail dialog in the application shell - or their
      // dialogs would re-point at this benchmark.
      expect(extras.queryParams).toEqual({
        dataSource,
        symbol,
        assetProfileDialog: null,
        benchmarkDetailDialog: true,
        dialogModule: DashboardModuleType.MARKETS,
        holdingDetailDialog: null
      });
    });

    it('names its own module, so two co-mounted instances address different owners', () => {
      const { markets, watchlist } = mountEveryHost();

      askToOpen(markets);
      askToOpen(watchlist);

      expect(navigationExtras(0).queryParams.dialogModule).toBe(
        DashboardModuleType.MARKETS
      );
      expect(navigationExtras(1).queryParams.dialogModule).toBe(
        DashboardModuleType.WATCHLIST
      );
    });

    it('produces a request its own gate accepts', () => {
      const { markets } = mountEveryHost();

      askToOpen(markets);

      // The producer and the consumer are two halves of one contract and nothing
      // in the compiler relates them: a rename on either side would leave a
      // request nobody answers. Feeding the produced payload back through the
      // stream is what keeps them honest.
      queryParams.next(navigationExtras(0).queryParams);

      expect(dialogOpen).toHaveBeenCalledTimes(1);
    });
  });

  describe('closing the dialog it opened', () => {
    it('clears exactly the parameters the request travelled on', () => {
      mountEveryHost();

      queryParams.next(requestFor({ owner: DashboardModuleType.MARKETS }));

      dialogRequests[0].afterClosed.next();

      expect(routerMock.navigate).toHaveBeenCalledTimes(1);

      const [commands] = routerMock.navigate.mock.calls[0];
      const extras = navigationExtras(0);

      expect(commands).toEqual([]);
      expect(extras.queryParamsHandling).toBe('merge');
      expect(extras.relativeTo).toBe(activatedRouteMock);

      // Exactly these four keys and no others. Anything wider closes a sibling
      // module's dialog; anything narrower leaves a stale flag that reopens this
      // one on the next merge.
      expect(extras.queryParams).toEqual({
        benchmarkDetailDialog: null,
        dataSource: null,
        dialogModule: null,
        symbol: null
      });
      expect(Object.keys(extras.queryParams).sort()).toEqual([
        'benchmarkDetailDialog',
        'dataSource',
        'dialogModule',
        'symbol'
      ]);
    });

    it('leaves every parameter it does not own untouched', () => {
      mountEveryHost();

      queryParams.next({
        ...requestFor({ owner: DashboardModuleType.MARKETS }),
        accessId: 'a-share-id',
        assetProfileDialog: true,
        utm_source: 'newsletter'
      });

      dialogRequests[0].afterClosed.next();

      const cleared = navigationExtras(0).queryParams;

      // Merging plus a null-only payload is what preserves them. The three named
      // here are the ones that were actually lost when this navigation named a
      // route segment instead: a sibling module's open dialog, the
      // shared-portfolio access identifier, and the campaign attribution.
      expect(cleared).not.toHaveProperty('accessId');
      expect(cleared).not.toHaveProperty('assetProfileDialog');
      expect(cleared).not.toHaveProperty('utm_source');
    });

    it('is cleared by the owner alone, so one close is one navigation', () => {
      mountEveryHost();

      queryParams.next(requestFor({ owner: DashboardModuleType.MARKETS }));

      dialogRequests[0].afterClosed.next();

      // Three instances are mounted and one dialog was opened, so exactly one of
      // them may clean up after it. Two navigations here would mean a
      // non-owner had subscribed to a dialog it never opened.
      expect(dialogOpen).toHaveBeenCalledTimes(1);
      expect(routerMock.navigate).toHaveBeenCalledTimes(1);
    });

    it('lets the same benchmark be opened again after it has been closed', () => {
      mountEveryHost();

      const request = requestFor({ owner: DashboardModuleType.MARKETS });

      queryParams.next(request);

      dialogRequests[0].afterClosed.next();

      // The clean-up nulls the parameters, which the real router would report
      // back as a withdrawal - reproduced here, because that withdrawal is what
      // lets the request be made again.
      queryParams.next({});
      queryParams.next(request);

      expect(dialogOpen).toHaveBeenCalledTimes(2);
    });
  });
});
