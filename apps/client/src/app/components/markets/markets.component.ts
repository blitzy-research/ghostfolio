import { GfFearAndGreedIndexComponent } from '@ghostfolio/client/components/fear-and-greed-index/fear-and-greed-index.component';
import { UserService } from '@ghostfolio/client/services/user/user.service';
import { DashboardModuleType } from '@ghostfolio/common/dashboard';
import { reportSanitizedError, resetHours } from '@ghostfolio/common/helper';
import {
  Benchmark,
  HistoricalDataItem,
  MarketDataOfMarketsResponse,
  ToggleOption,
  User
} from '@ghostfolio/common/interfaces';
import { FearAndGreedIndexMode } from '@ghostfolio/common/types';
import { GfBenchmarkComponent } from '@ghostfolio/ui/benchmark';
import { GfLineChartComponent } from '@ghostfolio/ui/line-chart';
import { DataService } from '@ghostfolio/ui/services';
import { GfToggleComponent } from '@ghostfolio/ui/toggle';

import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  CUSTOM_ELEMENTS_SCHEMA,
  DestroyRef,
  OnInit
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { DeviceDetectorService } from 'ngx-device-detector';
import { NgxSkeletonLoaderModule } from 'ngx-skeleton-loader';

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    GfBenchmarkComponent,
    GfFearAndGreedIndexComponent,
    GfLineChartComponent,
    GfToggleComponent,
    NgxSkeletonLoaderModule
  ],
  schemas: [CUSTOM_ELEMENTS_SCHEMA],
  selector: 'gf-markets',
  styleUrls: ['./markets.scss'],
  templateUrl: './markets.html'
})
export class GfMarketsComponent implements OnInit {
  /**
   * The module this component stands for, passed to the benchmark table so that its
   * detail dialog request names an owner.
   *
   * The benchmark table is mounted by three modules and all three can be on the
   * canvas at once, all three observe the same query parameters, and
   * `benchmarkDetailDialog` said nothing about which of them a request was for - so
   * one click opened the dialog up to three times over.
   */
  public readonly benchmarkDialogModule = DashboardModuleType.MARKETS_PREMIUM;

  public benchmarks: Benchmark[];
  public deviceType: string;
  public fearAndGreedIndex: number;

  /**
   * Whether the selected mode of the Fear & Greed index has a value to plot, and
   * whether its request has settled yet.
   *
   * Both are needed because the absence of a value means two different things at two
   * different moments: before the request settles it means "not known yet", and after
   * it means "not available". Collapsing them would either flash an empty state over a
   * request which is about to succeed, or leave an empty chart frame standing in for a
   * measurement which was never taken.
   *
   * The loading half is also handed to the Fear & Greed tile, which cannot tell an
   * unanswered request from an answer that carried no index - a provider with none
   * returns `{"STOCKS":{},"CRYPTOCURRENCIES":{}}`, so the value never arrives and,
   * without this, the tile pulsed a skeleton over a response it already had.
   */
  public hasFearAndGreedIndex = false;
  public isLoadingFearAndGreedIndex = true;
  public fearAndGreedIndexData: MarketDataOfMarketsResponse['fearAndGreedIndex'];
  public fearLabel = $localize`Fear`;
  public greedLabel = $localize`Greed`;
  public historicalDataItems: HistoricalDataItem[];

  public fearAndGreedIndexMode: FearAndGreedIndexMode = 'STOCKS';
  public fearAndGreedIndexModeOptions: ToggleOption[] = [
    { label: $localize`Stocks`, value: 'STOCKS' },
    { label: $localize`Cryptocurrencies`, value: 'CRYPTOCURRENCIES' }
  ];
  public readonly numberOfDays = 365;
  public user: User;

  public constructor(
    private changeDetectorRef: ChangeDetectorRef,
    private dataService: DataService,
    private destroyRef: DestroyRef,
    private deviceService: DeviceDetectorService,
    private userService: UserService
  ) {
    this.deviceType = this.deviceService.getDeviceInfo().deviceType;

    this.userService.stateChanged
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((state) => {
        if (state?.user) {
          this.user = state.user;

          this.changeDetectorRef.markForCheck();
        }
      });
  }

  public ngOnInit() {
    this.dataService
      .fetchMarketDataOfMarkets({ includeHistoricalData: this.numberOfDays })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        // Cleared on failure as well as on success, because the loading state
        // answers "is a request outstanding", and a request that failed is not.
        // Left set, a failed read would pulse the same indefinite skeleton this
        // flag exists to stop. The failure is reported as a fixed event identifier
        // and a status and nothing else - the shared sanitized channel - so it is
        // not swallowed either.
        error: (error: unknown) => {
          this.isLoadingFearAndGreedIndex = false;

          reportSanitizedError('GF-MARKET-DATA-OF-MARKETS-FETCH-FAILED', error);

          this.changeDetectorRef.markForCheck();
        },
        next: ({ fearAndGreedIndex }) => {
          this.fearAndGreedIndexData = fearAndGreedIndex;
          this.isLoadingFearAndGreedIndex = false;

          this.initialize();

          this.changeDetectorRef.markForCheck();
        }
      });

    this.dataService
      .fetchBenchmarks()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(({ benchmarks }) => {
        this.benchmarks = benchmarks;

        this.changeDetectorRef.markForCheck();
      });
  }

  public initialize() {
    this.fearAndGreedIndex =
      this.fearAndGreedIndexData?.[this.fearAndGreedIndexMode]?.marketPrice;

    this.hasFearAndGreedIndex = Number.isFinite(this.fearAndGreedIndex);

    if (!this.hasFearAndGreedIndex) {
      // Left empty rather than carrying a single point with no value in it. That
      // point is what let the chart draw a full frame around nothing.
      this.historicalDataItems = [];

      return;
    }

    this.historicalDataItems = [
      ...(this.fearAndGreedIndexData[this.fearAndGreedIndexMode]
        ?.historicalData ?? []),
      {
        date: resetHours(new Date()).toISOString(),
        value: this.fearAndGreedIndex
      }
    ];
  }

  public onChangeFearAndGreedIndexMode(
    aFearAndGreedIndexMode: FearAndGreedIndexMode
  ) {
    this.fearAndGreedIndexMode = aFearAndGreedIndexMode;

    this.initialize();
  }
}
