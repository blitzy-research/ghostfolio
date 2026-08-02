import { GfPortfolioPerformanceComponent } from '@ghostfolio/client/components/portfolio-performance/portfolio-performance.component';
import { DashboardIntentService } from '@ghostfolio/client/core/dashboard-intent.service';
import { LayoutService } from '@ghostfolio/client/core/layout.service';
import { ImpersonationStorageService } from '@ghostfolio/client/services/impersonation-storage.service';
import { UserService } from '@ghostfolio/client/services/user/user.service';
import { NUMERICAL_PRECISION_THRESHOLD_6_FIGURES } from '@ghostfolio/common/config';
import { DashboardModuleType } from '@ghostfolio/common/dashboard';
import {
  AssetProfileIdentifier,
  LineChartItem,
  PortfolioPerformance,
  User
} from '@ghostfolio/common/interfaces';
import { hasPermission, permissions } from '@ghostfolio/common/permissions';
import { GfLineChartComponent } from '@ghostfolio/ui/line-chart';
import { DataService } from '@ghostfolio/ui/services';

import { CommonModule } from '@angular/common';
import {
  ChangeDetectorRef,
  Component,
  CUSTOM_ELEMENTS_SCHEMA,
  DestroyRef,
  OnInit
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { MatButtonModule } from '@angular/material/button';
import { DeviceDetectorService } from 'ngx-device-detector';

@Component({
  imports: [
    CommonModule,
    GfLineChartComponent,
    GfPortfolioPerformanceComponent,
    MatButtonModule
  ],
  schemas: [CUSTOM_ELEMENTS_SCHEMA],
  selector: 'gf-home-overview',
  styleUrls: ['./home-overview.scss'],
  templateUrl: './home-overview.html'
})
export class GfHomeOverviewComponent implements OnInit {
  public deviceType: string;
  public errors: AssetProfileIdentifier[];
  public hasError: boolean;
  public hasImpersonationId: boolean;
  public hasPermissionToCreateActivity: boolean;
  public historicalDataItems: LineChartItem[];
  public isAllTimeHigh: boolean;
  public isAllTimeLow: boolean;
  public isLoadingPerformance = true;
  public performance: PortfolioPerformance;
  public performanceLabel = $localize`Performance`;
  public precision = 2;
  public showDetails = false;
  public unit: string;
  public user: User;

  public constructor(
    private changeDetectorRef: ChangeDetectorRef,
    private dataService: DataService,
    private dashboardIntentService: DashboardIntentService,
    private destroyRef: DestroyRef,
    private deviceService: DeviceDetectorService,
    private impersonationStorageService: ImpersonationStorageService,
    private layoutService: LayoutService,
    private userService: UserService
  ) {
    this.userService.stateChanged
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((state) => {
        if (state?.user) {
          this.user = state.user;

          this.hasPermissionToCreateActivity = hasPermission(
            this.user.permissions,
            permissions.createActivity
          );

          this.update();
        }
      });
  }

  public ngOnInit() {
    this.deviceType = this.deviceService.getDeviceInfo().deviceType;

    this.showDetails =
      !this.user.settings.isRestrictedView &&
      this.user.settings.viewMode !== 'ZEN';

    this.unit = this.showDetails ? this.user.settings.baseCurrency : '%';

    this.impersonationStorageService
      .onChangeHasImpersonation()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((impersonationId) => {
        this.hasImpersonationId = !!impersonationId;

        this.changeDetectorRef.markForCheck();
      });

    this.layoutService.shouldReloadContent$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => {
        this.update();
      });
  }

  /**
   * Publishes a reveal-module intent for the accounts module. This replaces the
   * former cross-screen navigation: on a single canvas, surfacing a module is
   * the canvas' responsibility, so this component only announces the intent and
   * never learns where the module ends up.
   */
  public onRevealAccounts() {
    this.dashboardIntentService
      .getRevealModuleSubject()
      .next(DashboardModuleType.ACCOUNTS);
  }

  /**
   * Publishes a reveal-module intent for the activities module.
   */
  public onRevealActivities() {
    this.dashboardIntentService
      .getRevealModuleSubject()
      .next(DashboardModuleType.ACTIVITIES);
  }

  /**
   * Publishes a reveal-module intent for the portfolio analysis module, which
   * is what the former portfolio link resolved to, because the portfolio route
   * loaded analysis as its default child.
   */
  public onRevealPortfolioAnalysis() {
    this.dashboardIntentService
      .getRevealModuleSubject()
      .next(DashboardModuleType.PORTFOLIO_ANALYSIS);
  }

  private update() {
    this.historicalDataItems = null;
    this.isLoadingPerformance = true;

    this.dataService
      .fetchPortfolioPerformance({
        range: this.user?.settings?.dateRange
      })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(({ chart, errors, performance }) => {
        this.errors = errors;
        this.performance = performance;

        this.historicalDataItems = chart.map(
          ({ date, netPerformanceInPercentageWithCurrencyEffect }) => {
            return {
              date,
              value: netPerformanceInPercentageWithCurrencyEffect * 100
            };
          }
        );

        if (
          this.deviceType === 'mobile' &&
          this.performance.currentValueInBaseCurrency >=
            NUMERICAL_PRECISION_THRESHOLD_6_FIGURES
        ) {
          this.precision = 0;
        }

        this.isLoadingPerformance = false;

        this.changeDetectorRef.markForCheck();
      });

    this.changeDetectorRef.markForCheck();
  }
}
