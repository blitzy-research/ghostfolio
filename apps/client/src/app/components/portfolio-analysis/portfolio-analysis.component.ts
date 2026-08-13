import { GfBenchmarkComparatorComponent } from '@ghostfolio/client/components/benchmark-comparator/benchmark-comparator.component';
import { GfInvestmentChartComponent } from '@ghostfolio/client/components/investment-chart/investment-chart.component';
import { ImpersonationStorageService } from '@ghostfolio/client/services/impersonation-storage.service';
import { UserService } from '@ghostfolio/client/services/user/user.service';
import { NUMERICAL_PRECISION_THRESHOLD_6_FIGURES } from '@ghostfolio/common/config';
import {
  openExternalWindow,
  reportSanitizedError
} from '@ghostfolio/common/helper';
import {
  AssetProfileIdentifier,
  HistoricalDataItem,
  InvestmentItem,
  PortfolioInvestmentsResponse,
  PortfolioPerformance,
  PortfolioPosition,
  ToggleOption,
  User
} from '@ghostfolio/common/interfaces';
import { hasPermission, permissions } from '@ghostfolio/common/permissions';
import type { AiPromptMode, GroupBy } from '@ghostfolio/common/types';
import { translate } from '@ghostfolio/ui/i18n';
import { GfPremiumIndicatorComponent } from '@ghostfolio/ui/premium-indicator';
import { DataService } from '@ghostfolio/ui/services';
import { GfToggleComponent } from '@ghostfolio/ui/toggle';
import { GfValueComponent } from '@ghostfolio/ui/value';

import { Clipboard } from '@angular/cdk/clipboard';
import {
  ChangeDetectorRef,
  Component,
  DestroyRef,
  OnInit,
  ViewChild
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatMenuModule, MatMenuTrigger } from '@angular/material/menu';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatSnackBar } from '@angular/material/snack-bar';
import { RouterModule } from '@angular/router';
import { IonIcon } from '@ionic/angular/standalone';
import { SymbolProfile } from '@prisma/client';
import { addIcons } from 'ionicons';
import { copyOutline, ellipsisVertical } from 'ionicons/icons';
import { isNumber, sortBy } from 'lodash';
import ms from 'ms';
import { DeviceDetectorService } from 'ngx-device-detector';
import { NgxSkeletonLoaderModule } from 'ngx-skeleton-loader';

/**
 * The stable event identifier a failed analysis read is reported under.
 *
 * One identifier for all six of this module's reads, on purpose: which of them failed
 * is a matter for the network log, whereas what a report must never carry is the
 * filter, range or holding that was in the request.
 */
const PORTFOLIO_ANALYSIS_FETCH_FAILED_EVENT =
  'GF-PORTFOLIO-ANALYSIS-FETCH-FAILED';

@Component({
  imports: [
    GfBenchmarkComparatorComponent,
    GfInvestmentChartComponent,
    GfPremiumIndicatorComponent,
    GfToggleComponent,
    GfValueComponent,
    IonIcon,
    MatButtonModule,
    MatCardModule,
    MatMenuModule,
    MatProgressSpinnerModule,
    NgxSkeletonLoaderModule,
    RouterModule
  ],
  selector: 'gf-portfolio-analysis',
  styleUrls: ['./portfolio-analysis.scss'],
  templateUrl: './portfolio-analysis.html'
})
export class GfPortfolioAnalysisComponent implements OnInit {
  @ViewChild(MatMenuTrigger) actionsMenuButton!: MatMenuTrigger;

  public benchmark: Partial<SymbolProfile>;
  public benchmarkDataItems: HistoricalDataItem[] = [];
  public benchmarks: Partial<SymbolProfile>[];
  public bottom3: PortfolioPosition[];
  public deviceType: string;
  public dividendsByGroup: InvestmentItem[];
  public dividendTimelineDataLabel = $localize`Dividend`;
  public firstOrderDate: Date;
  /**
   * Whether any of this module's reads failed.
   *
   * One flag for six reads, because the six of them draw a single screen and a notice
   * per read would stack six copies of the same sentence. What it does NOT do is hide
   * the screen: a failed benchmark read leaves the charts beside it perfectly valid,
   * so the notice sits above them and explains the gaps rather than replacing
   * everything that still works.
   *
   * Every read used to subscribe with a `next` callback alone, so a rejection left its
   * loading flag raised and its skeleton animating - six independent ways for this
   * module to look permanently busy.
   */
  public hasError = false;

  public hasImpersonationId: boolean;
  public hasPermissionToReadAiPrompt: boolean;
  public investments: InvestmentItem[];
  public investmentTimelineDataLabel = $localize`Investment`;
  public investmentsByGroup: InvestmentItem[];
  public isLoadingAnalysisPrompt: boolean;
  public isLoadingBenchmarkComparator: boolean;
  public isLoadingDividendTimelineChart: boolean;
  public isLoadingInvestmentChart: boolean;
  public isLoadingInvestmentTimelineChart: boolean;
  public isLoadingPortfolioPrompt: boolean;
  public mode: GroupBy = 'month';
  public modeOptions: ToggleOption[] = [
    { label: $localize`Monthly`, value: 'month' },
    { label: $localize`Yearly`, value: 'year' }
  ];
  public performance: PortfolioPerformance;
  public performanceDataItems: HistoricalDataItem[];
  public performanceDataItemsInPercentage: HistoricalDataItem[];
  public portfolioEvolutionDataLabel = $localize`Investment`;
  public precision = 2;
  public streaks: PortfolioInvestmentsResponse['streaks'];
  public top3: PortfolioPosition[];
  public unitCurrentStreak: string;
  public unitLongestStreak: string;
  public user: User;

  public constructor(
    private changeDetectorRef: ChangeDetectorRef,
    private clipboard: Clipboard,
    private dataService: DataService,
    private destroyRef: DestroyRef,
    private deviceService: DeviceDetectorService,
    private impersonationStorageService: ImpersonationStorageService,
    private snackBar: MatSnackBar,
    private userService: UserService
  ) {
    const { benchmarks } = this.dataService.fetchInfo();
    this.benchmarks = benchmarks;

    addIcons({ copyOutline, ellipsisVertical });
  }

  get savingsRate() {
    const savingsRatePerMonth =
      this.hasImpersonationId || this.user.settings.isRestrictedView
        ? undefined
        : this.user?.settings?.savingsRate;

    return this.mode === 'year'
      ? savingsRatePerMonth * 12
      : savingsRatePerMonth;
  }

  /**
   * The query parameters that ask the application shell to open a holding's detail
   * dialog.
   *
   * Built here rather than inline in the template because the template renders this
   * link twice - once for the best performers and once for the worst - and the
   * payload has to be identical in both. It carries two explicit nulls:
   * `dataSource` and `symbol` are shared identifiers read by three different flags,
   * the other two belonging to the market data administration module and to the
   * benchmark table, and because these parameters are merged rather than replacing
   * the whole map, leaving either up would re-point *their* dialog at this holding
   * rather than merely leaving it alone.
   */
  public getHoldingDetailQueryParams({
    dataSource,
    symbol
  }: AssetProfileIdentifier) {
    return {
      dataSource,
      symbol,
      assetProfileDialog: null,
      benchmarkDetailDialog: null,
      holdingDetailDialog: true
    };
  }

  public ngOnInit() {
    this.deviceType = this.deviceService.getDeviceInfo().deviceType;

    this.impersonationStorageService
      .onChangeHasImpersonation()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((impersonationId) => {
        this.hasImpersonationId = !!impersonationId;
      });

    this.userService.stateChanged
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((state) => {
        if (state?.user) {
          this.user = state.user;

          this.benchmark = this.benchmarks.find(({ id }) => {
            return id === this.user.settings?.benchmark;
          });

          this.hasPermissionToReadAiPrompt = hasPermission(
            this.user.permissions,
            permissions.readAiPrompt
          );

          this.update();
        }
      });
  }

  public onChangeBenchmark(symbolProfileId: string) {
    this.dataService
      .putUserSetting({ benchmark: symbolProfileId })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => {
        this.userService
          .get(true)
          .pipe(takeUntilDestroyed(this.destroyRef))
          .subscribe((user) => {
            this.user = user;

            this.changeDetectorRef.markForCheck();
          });
      });
  }

  public onChangeGroupBy(aMode: GroupBy) {
    this.mode = aMode;
    this.fetchDividendsAndInvestments();
  }

  public onCopyPromptToClipboard(mode: AiPromptMode) {
    if (mode === 'analysis') {
      this.isLoadingAnalysisPrompt = true;
    } else if (mode === 'portfolio') {
      this.isLoadingPortfolioPrompt = true;
    }

    this.dataService
      .fetchPrompt({
        mode,
        filters: this.userService.getFilters()
      })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        error: (error: unknown) => {
          // Reported where the action was taken rather than through the module's own
          // notice: this is not one of the screen's reads, it is something the viewer
          // pressed, and the spinner it raised sits inside a menu that is about to
          // close. Lowering both flags is the fix - a refused prompt used to leave the
          // menu item spinning for the life of the module.
          this.isLoadingAnalysisPrompt = false;
          this.isLoadingPortfolioPrompt = false;

          this.snackBar.open(
            $localize`The AI prompt could not be generated.` +
              ' ' +
              $localize`Please try again later.`,
            undefined,
            { duration: ms('6 seconds') }
          );

          reportSanitizedError(PORTFOLIO_ANALYSIS_FETCH_FAILED_EVENT, error);

          this.changeDetectorRef.markForCheck();
        },
        next: ({ prompt }) => {
          this.clipboard.copy(prompt);

          const snackBarRef = this.snackBar.open(
            '✅ ' + $localize`AI prompt has been copied to the clipboard`,
            $localize`Open Duck.ai` + ' →',
            {
              duration: ms('7 seconds')
            }
          );

          snackBarRef
            .onAction()
            .pipe(takeUntilDestroyed(this.destroyRef))
            .subscribe(() => {
              // Opened through the shared helper so the destination is never
              // handed a `window.opener` reference back to this tab.
              openExternalWindow('https://duck.ai');
            });

          this.actionsMenuButton.closeMenu();

          if (mode === 'analysis') {
            this.isLoadingAnalysisPrompt = false;
          } else if (mode === 'portfolio') {
            this.isLoadingPortfolioPrompt = false;
          }
        }
      });
  }

  /**
   * Reads everything this module shows, again.
   *
   * The same call `update` makes when the module arrives, so a viewer whose read failed
   * recovers in place rather than removing the module and adding it back. The flag is
   * lowered first, so a second failure raises the notice again rather than leaving a
   * stale one that was never withdrawn.
   */
  public onRetry() {
    this.hasError = false;

    this.update();
  }

  private fetchDividendsAndInvestments() {
    this.isLoadingDividendTimelineChart = true;
    this.isLoadingInvestmentTimelineChart = true;

    this.dataService
      .fetchDividends({
        filters: this.userService.getFilters(),
        groupBy: this.mode,
        range: this.user?.settings?.dateRange
      })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        error: (error: unknown) => {
          this.reportFailedRead(error, () => {
            this.isLoadingDividendTimelineChart = false;
          });
        },
        next: ({ dividends }) => {
          this.dividendsByGroup = dividends;

          this.isLoadingDividendTimelineChart = false;

          this.changeDetectorRef.markForCheck();
        }
      });

    this.dataService
      .fetchInvestments({
        filters: this.userService.getFilters(),
        groupBy: this.mode,
        range: this.user?.settings?.dateRange
      })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        error: (error: unknown) => {
          this.reportFailedRead(error, () => {
            this.isLoadingInvestmentTimelineChart = false;
          });
        },
        next: ({ investments, streaks }) => {
          this.investmentsByGroup = investments;
          this.streaks = streaks;
          this.unitCurrentStreak =
            this.mode === 'year'
              ? this.streaks?.currentStreak === 1
                ? translate('YEAR')
                : translate('YEARS')
              : this.streaks?.currentStreak === 1
                ? translate('MONTH')
                : translate('MONTHS');
          this.unitLongestStreak =
            this.mode === 'year'
              ? this.streaks?.longestStreak === 1
                ? translate('YEAR')
                : translate('YEARS')
              : this.streaks?.longestStreak === 1
                ? translate('MONTH')
                : translate('MONTHS');

          this.isLoadingInvestmentTimelineChart = false;

          this.changeDetectorRef.markForCheck();
        }
      });
  }

  private update() {
    this.isLoadingInvestmentChart = true;

    this.dataService
      .fetchPortfolioPerformance({
        filters: this.userService.getFilters(),
        range: this.user?.settings?.dateRange
      })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        error: (error: unknown) => {
          this.reportFailedRead(error, () => {
            this.isLoadingInvestmentChart = false;
          });
        },
        next: ({ chart, firstOrderDate, performance }) => {
          this.firstOrderDate = firstOrderDate ?? new Date();

          this.investments = [];
          this.performance = performance;
          this.performanceDataItems = [];
          this.performanceDataItemsInPercentage = [];

          for (const [
            index,
            {
              date,
              netPerformanceInPercentageWithCurrencyEffect,
              totalInvestmentValueWithCurrencyEffect,
              valueInPercentage,
              valueWithCurrencyEffect
            }
          ] of chart.entries()) {
            if (index > 0 || this.user?.settings?.dateRange === 'max') {
              // The first chart point is the range's baseline rather than a data
              // point, so it is skipped for every range except `max`, where it is
              // the genuine start of the series.
              this.investments.push({
                date,
                investment: totalInvestmentValueWithCurrencyEffect
              });
              this.performanceDataItems.push({
                date,
                value: isNumber(valueWithCurrencyEffect)
                  ? valueWithCurrencyEffect
                  : valueInPercentage
              });
            }

            this.performanceDataItemsInPercentage.push({
              date,
              value: netPerformanceInPercentageWithCurrencyEffect
            });
          }

          if (
            this.deviceType === 'mobile' &&
            this.performance.currentValueInBaseCurrency >=
              NUMERICAL_PRECISION_THRESHOLD_6_FIGURES
          ) {
            this.precision = 0;
          }

          this.isLoadingInvestmentChart = false;

          this.updateBenchmarkDataItems();

          this.changeDetectorRef.markForCheck();
        }
      });

    // The best-and-worst lists have no loading flag of their own: the template shows a
    // placeholder for as long as each list is absent, so absence IS this read's loading
    // state. Clearing them here is what puts the placeholders back for a retry, which
    // would otherwise re-read behind two lists that still held the previous answer.
    this.bottom3 = undefined;
    this.top3 = undefined;

    this.dataService
      .fetchPortfolioHoldings({
        filters: this.userService.getFilters(),
        range: this.user?.settings?.dateRange
      })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        error: (error: unknown) => {
          this.reportFailedRead(error, () => {
            // Empty lists rather than absent ones. Absence is what the template reads
            // as "still loading", so leaving these unset kept two placeholders pulsing
            // for ever inside the Top and Bottom cards - the very thing the notice
            // exists to replace, surviving in the one section a viewer only reaches by
            // scrolling. Empty is the honest shape: the cards show nothing, and the
            // notice above them is what says the nothing is a failure rather than a
            // portfolio with no gainers and no losers.
            this.bottom3 = [];
            this.top3 = [];
          });
        },
        next: ({ holdings }) => {
          const holdingsSorted = sortBy(
            holdings.filter(({ netPerformancePercentWithCurrencyEffect }) => {
              return isNumber(netPerformancePercentWithCurrencyEffect);
            }),
            'netPerformancePercentWithCurrencyEffect'
          ).reverse();

          this.top3 = holdingsSorted
            .filter(
              ({ netPerformancePercentWithCurrencyEffect }) =>
                netPerformancePercentWithCurrencyEffect > 0
            )
            .slice(0, 3);

          this.bottom3 = holdingsSorted
            .filter(
              ({ netPerformancePercentWithCurrencyEffect }) =>
                netPerformancePercentWithCurrencyEffect < 0
            )
            .slice(-3)
            .reverse();

          this.changeDetectorRef.markForCheck();
        }
      });

    this.fetchDividendsAndInvestments();
    this.changeDetectorRef.markForCheck();
  }

  /**
   * Records that one of this module's reads failed, and stops whatever it left
   * pretending to load.
   *
   * The caller supplies the flag-lowering rather than having it inferred, because each
   * read owns a different one and lowering all six would claim five reads had finished
   * when they may still be in flight.
   *
   * @param aError the caught value, read only for its status.
   * @param aStopLoading lowers the loading flag belonging to the read that failed, or -
   * where a section shows a placeholder for as long as its data is absent rather than
   * off a flag - settles that data to its empty shape so the placeholder goes with it.
   */
  private reportFailedRead(aError: unknown, aStopLoading: () => void) {
    aStopLoading();

    this.hasError = true;

    reportSanitizedError(PORTFOLIO_ANALYSIS_FETCH_FAILED_EVENT, aError);

    this.changeDetectorRef.markForCheck();
  }

  private updateBenchmarkDataItems() {
    this.benchmarkDataItems = [];

    if (this.user.settings.benchmark) {
      const { dataSource, symbol } =
        this.benchmarks.find(({ id }) => {
          return id === this.user.settings.benchmark;
        }) ?? {};

      if (dataSource && symbol) {
        this.isLoadingBenchmarkComparator = true;

        this.dataService
          .fetchBenchmarkForUser({
            dataSource,
            symbol,
            filters: this.userService.getFilters(),
            range: this.user?.settings?.dateRange,
            startDate: this.firstOrderDate
          })
          .pipe(takeUntilDestroyed(this.destroyRef))
          .subscribe({
            error: (error: unknown) => {
              this.reportFailedRead(error, () => {
                this.isLoadingBenchmarkComparator = false;
              });
            },
            next: ({ marketData }) => {
              this.benchmarkDataItems = marketData.map(({ date, value }) => {
                return {
                  date,
                  value
                };
              });

              this.isLoadingBenchmarkComparator = false;

              this.changeDetectorRef.markForCheck();
            }
          });
      }
    }
  }
}
