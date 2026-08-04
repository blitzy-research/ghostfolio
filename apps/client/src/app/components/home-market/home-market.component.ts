import { GfFearAndGreedIndexComponent } from '@ghostfolio/client/components/fear-and-greed-index/fear-and-greed-index.component';
import { UserService } from '@ghostfolio/client/services/user/user.service';
import { ghostfolioFearAndGreedIndexSymbol } from '@ghostfolio/common/config';
import { DashboardModuleType } from '@ghostfolio/common/dashboard';
import { resetHours } from '@ghostfolio/common/helper';
import {
  Benchmark,
  HistoricalDataItem,
  InfoItem,
  User
} from '@ghostfolio/common/interfaces';
import { hasPermission, permissions } from '@ghostfolio/common/permissions';
import { GfBenchmarkComponent } from '@ghostfolio/ui/benchmark';
import { GfLineChartComponent } from '@ghostfolio/ui/line-chart';
import { DataService } from '@ghostfolio/ui/services';

import {
  ChangeDetectorRef,
  Component,
  CUSTOM_ELEMENTS_SCHEMA,
  DestroyRef,
  OnInit
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { DeviceDetectorService } from 'ngx-device-detector';

@Component({
  imports: [
    GfBenchmarkComponent,
    GfFearAndGreedIndexComponent,
    GfLineChartComponent
  ],
  schemas: [CUSTOM_ELEMENTS_SCHEMA],
  selector: 'gf-home-market',
  styleUrls: ['./home-market.scss'],
  templateUrl: './home-market.html'
})
export class GfHomeMarketComponent implements OnInit {
  /**
   * The module this component stands for, passed to the benchmark table so that its
   * detail dialog request names an owner.
   *
   * The benchmark table is mounted by three modules and all three can be on the
   * canvas at once, all three observe the same query parameters, and
   * `benchmarkDetailDialog` said nothing about which of them a request was for - so
   * one click opened the dialog up to three times over.
   */
  public readonly benchmarkDialogModule = DashboardModuleType.MARKETS;

  public benchmarks: Benchmark[];
  public deviceType: string;
  public fearAndGreedIndex: number;
  public fearLabel = $localize`Fear`;
  public greedLabel = $localize`Greed`;
  public hasPermissionToAccessFearAndGreedIndex: boolean;
  public historicalDataItems: HistoricalDataItem[];
  public info: InfoItem;
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
    this.info = this.dataService.fetchInfo();

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
    this.hasPermissionToAccessFearAndGreedIndex = hasPermission(
      this.info?.globalPermissions,
      permissions.enableFearAndGreedIndex
    );

    if (this.hasPermissionToAccessFearAndGreedIndex) {
      this.dataService
        .fetchSymbolItem({
          dataSource: this.info.fearAndGreedDataSource,
          includeHistoricalData: this.numberOfDays,
          symbol: ghostfolioFearAndGreedIndexSymbol
        })
        .pipe(takeUntilDestroyed(this.destroyRef))
        .subscribe(({ historicalData, marketPrice }) => {
          this.fearAndGreedIndex = marketPrice;
          this.historicalDataItems = [
            ...historicalData,
            {
              date: resetHours(new Date()).toISOString(),
              value: marketPrice
            }
          ];

          this.changeDetectorRef.markForCheck();
        });
    }

    this.dataService
      .fetchBenchmarks()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(({ benchmarks }) => {
        this.benchmarks = benchmarks;

        this.changeDetectorRef.markForCheck();
      });
  }
}
