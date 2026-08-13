import { ImpersonationStorageService } from '@ghostfolio/client/services/impersonation-storage.service';
import { UserService } from '@ghostfolio/client/services/user/user.service';
import type { User } from '@ghostfolio/common/interfaces';
import { permissions } from '@ghostfolio/common/permissions';
import { DataService } from '@ghostfolio/ui/services';

import { ComponentFixture, TestBed } from '@angular/core/testing';
import { MatSnackBar } from '@angular/material/snack-bar';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { Observable, of, Subject, throwError } from 'rxjs';

import { GfPortfolioAnalysisComponent } from './portfolio-analysis.component';

/**
 * The analysis module.
 *
 * Six independent reads draw this one screen, and every one of them subscribed with a
 * `next` callback alone. Each raises its own loading flag, and each of those flags
 * draws its own skeleton - so a rejection left that skeleton animating for the life of
 * the module: six separate ways for the screen to look permanently busy, none of them
 * saying anything and none of them offering a way to ask again.
 *
 * A seventh read is not a read at all. Copying an AI prompt is something the viewer
 * PRESSES, and it raises a spinner inside a menu; a refusal used to leave that spinner
 * turning too.
 *
 * The notice is deliberately not all-or-nothing. A failed benchmark read leaves every
 * chart beside it perfectly valid, so the notice explains the gaps rather than
 * discarding the parts that worked.
 */
describe('GfPortfolioAnalysisComponent', () => {
  let component: GfPortfolioAnalysisComponent;
  let fixture: ComponentFixture<GfPortfolioAnalysisComponent>;
  let reports: unknown[][];
  let snackBarMessages: string[];

  /** Each read, answered from its own queue so exactly one can be made to fail. */
  let responses: Record<string, Observable<unknown>[]>;

  let originalMatchMedia: typeof window.matchMedia;

  const answers: Record<string, unknown> = {
    fetchBenchmarkForUser: { marketData: [{ date: '2026-01-01', value: 1 }] },
    fetchDividends: { dividends: [] },
    fetchInvestments: { investments: [], streaks: {} },
    fetchPortfolioHoldings: { holdings: [] },
    fetchPortfolioPerformance: {
      chart: [],
      firstOrderDate: new Date('2026-01-01'),
      performance: { currentValueInBaseCurrency: 1 }
    },
    fetchPrompt: { prompt: 'a prompt' }
  };

  const createUser = (): User => {
    return {
      permissions: [permissions.readAiPrompt],
      settings: {
        benchmark: 'benchmark-id',
        dateRange: '1y',
        isExperimentalFeatures: true,
        locale: 'en'
      },
      subscription: { type: 'Premium' }
    } as unknown as User;
  };

  /** Makes one named read fail, and only that one. */
  const failOnly = (aMethod: string, status = 500) => {
    responses[aMethod] = [throwError(() => ({ status }))];
  };

  const createComponent = async () => {
    reports = [];
    snackBarMessages = [];

    const dataService: Record<string, unknown> = {
      fetchInfo: () => {
        return {
          benchmarks: [
            { dataSource: 'YAHOO', id: 'benchmark-id', symbol: 'VOO' }
          ]
        };
      }
    };

    for (const method of Object.keys(answers)) {
      dataService[method] = jest.fn(() => {
        return responses[method]?.shift() ?? of(answers[method]);
      });
    }

    jest.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      reports.push(args);
    });

    TestBed.resetTestingModule();

    await TestBed.configureTestingModule({
      imports: [GfPortfolioAnalysisComponent],
      providers: [
        provideNoopAnimations(),
        { provide: DataService, useValue: dataService },
        {
          provide: ImpersonationStorageService,
          useValue: { onChangeHasImpersonation: () => of(null) }
        },
        {
          provide: MatSnackBar,
          useValue: {
            open: (message: string) => {
              snackBarMessages.push(message);

              return { onAction: () => new Subject<void>() };
            }
          }
        },
        {
          provide: UserService,
          useValue: {
            get: () => of(createUser()),
            getFilters: () => [],
            stateChanged: of({ user: createUser() })
          }
        }
      ]
    }).compileComponents();

    fixture = TestBed.createComponent(GfPortfolioAnalysisComponent);
    component = fixture.componentInstance;

    fixture.detectChanges();

    return component;
  };

  const alert = () => {
    return fixture.nativeElement.querySelector('[role="alert"]');
  };

  const retryButton = (): HTMLButtonElement => {
    return alert()?.querySelector('button');
  };

  /**
   * The placeholders this module renders itself.
   *
   * Scoped past `gf-value`, because each value tile renders a placeholder of its own
   * whenever its figure is absent - eight of them under this spec's deliberately
   * sparse performance answer - and those belong to other reads entirely. Counting
   * them would make a module-wide zero unreachable and the assertion meaningless.
   */
  const ownSkeletons = () => {
    return Array.from(
      fixture.nativeElement.querySelectorAll(
        'ngx-skeleton-loader'
      ) as NodeListOf<HTMLElement>
    ).filter((element) => !element.closest('gf-value'));
  };

  beforeEach(() => {
    responses = {};

    // jsdom implements no `matchMedia`, and the benchmark chart this module mounts
    // reads the operating system's colour-scheme preference through it to pick its
    // background - so a read succeeding is what reaches it, which is why only the
    // recovery cases needed this. The stub reports the light preference and holds no
    // listener, since nothing here observes a change of scheme.
    originalMatchMedia = window.matchMedia;
    window.matchMedia = jest.fn(() => ({
      addEventListener: () => undefined,
      matches: false,
      removeEventListener: () => undefined
    })) as unknown as typeof window.matchMedia;
  });

  afterEach(() => {
    window.matchMedia = originalMatchMedia;

    jest.restoreAllMocks();
  });

  describe('when every read answers', () => {
    it('says nothing', async () => {
      await createComponent();

      expect(component.hasError).toBe(false);
      expect(alert()).toBeNull();
    });

    it('leaves no skeleton animating', async () => {
      await createComponent();

      expect(component.isLoadingBenchmarkComparator).toBe(false);
      expect(component.isLoadingDividendTimelineChart).toBe(false);
      expect(component.isLoadingInvestmentChart).toBe(false);
      expect(component.isLoadingInvestmentTimelineChart).toBe(false);
    });
  });

  /**
   * One case per read, because each owns a different flag and the defect was that
   * every one of them stayed raised. A failure in any single read must stop that
   * read's skeleton and no other's - lowering all six would claim five reads had
   * finished when they may still be in flight.
   */
  describe('when one read fails', () => {
    it.each([
      ['fetchDividends', 'isLoadingDividendTimelineChart'],
      ['fetchInvestments', 'isLoadingInvestmentTimelineChart'],
      ['fetchPortfolioPerformance', 'isLoadingInvestmentChart'],
      ['fetchBenchmarkForUser', 'isLoadingBenchmarkComparator']
    ])('%s stops its own skeleton', async (method, flag) => {
      failOnly(method);

      await createComponent();

      expect((component as unknown as Record<string, boolean>)[flag]).toBe(
        false
      );
      expect(component.hasError).toBe(true);
    });

    /**
     * The holdings read owns no loading FLAG, which is what made it look as though it
     * owned no loading state at all - and that reading shipped: its error handler
     * lowered nothing, and two placeholders pulsed for ever inside the Top and Bottom
     * cards. The template shows a placeholder for as long as each list is ABSENT, so
     * absence is this read's loading state, and settling both lists to empty is how it
     * puts them down. Runtime found this by scrolling to the two cards; these assert on
     * the rendered placeholder, not just on the members, so it cannot come back.
     */
    it('the holdings read settles its lists rather than leaving them loading', async () => {
      failOnly('fetchPortfolioHoldings');

      await createComponent();

      expect(component.hasError).toBe(true);
      expect(component.bottom3).toEqual([]);
      expect(component.top3).toEqual([]);
    });

    it('leaves no placeholder rendered when the holdings read fails', async () => {
      failOnly('fetchPortfolioHoldings');

      await createComponent();

      // Empty is the honest shape: the two cards show nothing, and the notice above
      // them is what says the nothing is a failure rather than a portfolio with no
      // gainers and no losers.
      expect(ownSkeletons()).toHaveLength(0);
      expect(alert().textContent).toContain(
        'Some of your analysis could not be loaded.'
      );
    });

    it('puts the placeholders back for a retry', async () => {
      responses['fetchPortfolioHoldings'] = [
        throwError(() => ({ status: 500 })),
        new Observable(() => undefined)
      ];

      await createComponent();

      expect(component.top3).toEqual([]);
      expect(ownSkeletons()).toHaveLength(0);

      retryButton().click();
      fixture.detectChanges();

      // A retry that has not answered yet is loading again, so absence is correct
      // here - clearing them is what distinguishes it from still holding an answer.
      // Asserting the rendered pair as well as the members is what proves the query
      // above can see these placeholders at all, so its zero is a real zero.
      expect(component.bottom3).toBeUndefined();
      expect(component.top3).toBeUndefined();
      expect(ownSkeletons()).toHaveLength(2);
    });

    it('says so once, however many reads failed', async () => {
      failOnly('fetchDividends');
      failOnly('fetchInvestments');
      failOnly('fetchPortfolioPerformance');

      await createComponent();

      expect(
        fixture.nativeElement.querySelectorAll('[role="alert"]')
      ).toHaveLength(1);
      expect(alert().textContent).toContain(
        'Some of your analysis could not be loaded.'
      );
    });

    it('keeps the reads that worked', async () => {
      failOnly('fetchBenchmarkForUser');

      await createComponent();

      // The notice sits above the screen rather than replacing it, which is the
      // whole distinction between explaining a gap and discarding what still works.
      expect(component.performance).toBeDefined();
      expect(
        fixture.nativeElement.querySelector('gf-investment-chart')
      ).toBeTruthy();
    });

    it('offers something to press, and recovers in place', async () => {
      failOnly('fetchDividends');

      await createComponent();

      expect(retryButton().textContent.trim()).toBe('Try again');

      retryButton().click();
      fixture.detectChanges();

      expect(component.hasError).toBe(false);
      expect(alert()).toBeNull();
    });

    it('raises the notice again when the retry fails too', async () => {
      responses['fetchDividends'] = [
        throwError(() => ({ status: 500 })),
        throwError(() => ({ status: 503 }))
      ];

      await createComponent();

      retryButton().click();
      fixture.detectChanges();

      expect(component.hasError).toBe(true);
      expect(retryButton()).toBeTruthy();
    });

    it('reports the failure without disclosing the range or filters', async () => {
      failOnly('fetchDividends');

      await createComponent();

      expect(reports).toEqual([
        ['GF-PORTFOLIO-ANALYSIS-FETCH-FAILED (status 500)']
      ]);
    });
  });

  describe('when the AI prompt cannot be generated', () => {
    it('stops the spinner it raised', async () => {
      await createComponent();

      failOnly('fetchPrompt');

      component.onCopyPromptToClipboard('portfolio');

      // A refused prompt used to leave this turning inside a menu for the life of
      // the module.
      expect(component.isLoadingPortfolioPrompt).toBe(false);
      expect(component.isLoadingAnalysisPrompt).toBe(false);
    });

    it('tells the viewer where they pressed rather than through the module notice', async () => {
      await createComponent();

      failOnly('fetchPrompt');

      component.onCopyPromptToClipboard('analysis');

      // Not one of the screen's reads: it is something the viewer did, so it is
      // answered where they did it - and it does not mark the analysis itself
      // as failed.
      expect(snackBarMessages).toHaveLength(1);
      expect(snackBarMessages[0]).toContain(
        'The AI prompt could not be generated.'
      );
      expect(component.hasError).toBe(false);
      expect(alert()).toBeNull();
    });
  });
});
