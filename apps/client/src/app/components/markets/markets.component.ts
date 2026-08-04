import { GfFearAndGreedIndexComponent } from '@ghostfolio/client/components/fear-and-greed-index/fear-and-greed-index.component';
import { UserService } from '@ghostfolio/client/services/user/user.service';
import { DashboardModuleType } from '@ghostfolio/common/dashboard';
import { resetHours } from '@ghostfolio/common/helper';
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

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    GfBenchmarkComponent,
    GfFearAndGreedIndexComponent,
    GfLineChartComponent,
    GfToggleComponent
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
      .subscribe(({ fearAndGreedIndex }) => {
        this.fearAndGreedIndexData = fearAndGreedIndex;

        this.initialize();

        this.changeDetectorRef.markForCheck();
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
      this.fearAndGreedIndexData[this.fearAndGreedIndexMode]?.marketPrice;

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
