import { DashboardIntentService } from '@ghostfolio/client/core/dashboard-intent.service';
import {
  getTooltipOptions,
  getVerticalHoverLinePlugin
} from '@ghostfolio/common/chart-helper';
import { primaryColorRgb, secondaryColorRgb } from '@ghostfolio/common/config';
import { DashboardModuleType } from '@ghostfolio/common/dashboard';
import {
  getBackgroundColor,
  getDateFormatString,
  getLocale,
  getTextColor,
  parseDate
} from '@ghostfolio/common/helper';
import { LineChartItem, type User } from '@ghostfolio/common/interfaces';
import { hasPermission, permissions } from '@ghostfolio/common/permissions';
import type { ColorScheme } from '@ghostfolio/common/types';
import { registerChartConfiguration } from '@ghostfolio/ui/chart';
import { GfPremiumIndicatorComponent } from '@ghostfolio/ui/premium-indicator';

import { CommonModule } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  type ElementRef,
  EventEmitter,
  Input,
  OnChanges,
  OnDestroy,
  Output,
  ViewChild
} from '@angular/core';
import { FormsModule, ReactiveFormsModule } from '@angular/forms';
import { MatSelectModule } from '@angular/material/select';
import { IonIcon } from '@ionic/angular/standalone';
import { SymbolProfile } from '@prisma/client';
import {
  Chart,
  ChartData,
  LinearScale,
  LineController,
  LineElement,
  PointElement,
  TimeScale,
  type TooltipOptions
} from 'chart.js';
import { addIcons } from 'ionicons';
import { arrowForwardOutline } from 'ionicons/icons';
import { NgxSkeletonLoaderModule } from 'ngx-skeleton-loader';

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    CommonModule,
    FormsModule,
    GfPremiumIndicatorComponent,
    IonIcon,
    MatSelectModule,
    NgxSkeletonLoaderModule,
    ReactiveFormsModule
  ],
  selector: 'gf-benchmark-comparator',
  styleUrls: ['./benchmark-comparator.component.scss'],
  templateUrl: './benchmark-comparator.component.html'
})
export class GfBenchmarkComparatorComponent implements OnChanges, OnDestroy {
  @Input() benchmark: Partial<SymbolProfile>;
  @Input() benchmarkDataItems: LineChartItem[] = [];
  @Input() benchmarks: Partial<SymbolProfile>[];
  @Input() colorScheme: ColorScheme;
  @Input() isLoading: boolean;
  @Input() locale = getLocale();
  @Input() performanceDataItems: LineChartItem[];
  @Input() user: User;

  @Output() benchmarkChanged = new EventEmitter<string>();

  @ViewChild('chartCanvas') chartCanvas: ElementRef<HTMLCanvasElement>;

  public chart: Chart<'line'>;
  public hasPermissionToAccessAdminControl: boolean;

  public constructor(private dashboardIntentService: DashboardIntentService) {
    // Controllers, elements and scales only - they hold no per-chart state, so
    // registering them here keeps this component's bundle to the chart type it
    // actually draws. Plugins and the date adapter belong to the shared chart
    // registry, which installs them at module-evaluation time; see
    // `registerChartConfiguration` for why that ordering is load-bearing.
    Chart.register(
      LinearScale,
      LineController,
      LineElement,
      PointElement,
      TimeScale
    );

    registerChartConfiguration();

    addIcons({ arrowForwardOutline });
  }

  public ngOnChanges() {
    this.hasPermissionToAccessAdminControl = hasPermission(
      this.user?.permissions,
      permissions.accessAdminControl
    );

    if (this.performanceDataItems) {
      this.initialize();
    }
  }

  public onChangeBenchmark(symbolProfileId: string) {
    this.benchmarkChanged.next(symbolProfileId);
  }

  /**
   * Surfaces the market data module, which is where benchmarks are managed. The
   * option used to carry a route link to the admin market data screen. That
   * screen no longer owns a URL of its own, so the intent is published on the
   * neutral bus and the canvas decides how to reveal the module. Nothing about
   * authorization changes: the template still gates the option behind
   * `hasPermissionToAccessAdminControl` and the API keeps enforcing the
   * permission independently.
   */
  public onOpenAdminMarketData() {
    this.dashboardIntentService
      .getRevealModuleSubject()
      .next(DashboardModuleType.ADMIN_MARKET_DATA);
  }

  public ngOnDestroy() {
    this.chart?.destroy();
  }

  private initialize() {
    const benchmarkDataValues: Record<string, number> = {};

    for (const { date, value } of this.benchmarkDataItems) {
      benchmarkDataValues[date] = value;
    }

    const data: ChartData<'line'> = {
      datasets: [
        {
          backgroundColor: `rgb(${primaryColorRgb.r}, ${primaryColorRgb.g}, ${primaryColorRgb.b})`,
          borderColor: `rgb(${primaryColorRgb.r}, ${primaryColorRgb.g}, ${primaryColorRgb.b})`,
          borderWidth: 2,
          data: this.performanceDataItems.map(({ date, value }) => {
            return { x: parseDate(date).getTime(), y: value * 100 };
          }),
          label: $localize`Portfolio`
        },
        {
          backgroundColor: `rgb(${secondaryColorRgb.r}, ${secondaryColorRgb.g}, ${secondaryColorRgb.b})`,
          borderColor: `rgb(${secondaryColorRgb.r}, ${secondaryColorRgb.g}, ${secondaryColorRgb.b})`,
          borderWidth: 2,
          data: this.performanceDataItems.map(({ date }) => {
            return {
              x: parseDate(date).getTime(),
              y: benchmarkDataValues[date]
            };
          }),
          label: this.benchmark?.name ?? $localize`Benchmark`
        }
      ]
    };

    if (this.chartCanvas) {
      if (this.chart) {
        this.chart.data = data;
        this.chart.options.plugins ??= {};
        this.chart.options.plugins.tooltip =
          this.getTooltipPluginConfiguration();

        this.chart.update();
      } else {
        this.chart = new Chart(this.chartCanvas.nativeElement, {
          data,
          options: {
            animation: false,
            elements: {
              line: {
                tension: 0
              },
              point: {
                hoverBackgroundColor: getBackgroundColor(this.colorScheme),
                hoverRadius: 2,
                radius: 0
              }
            },
            interaction: { intersect: false, mode: 'index' },
            maintainAspectRatio: true,
            plugins: {
              annotation: {
                annotations: {
                  yAxis: {
                    borderColor: `rgba(${getTextColor(this.colorScheme)}, 0.1)`,
                    borderWidth: 1,
                    scaleID: 'y',
                    type: 'line',
                    value: 0
                  }
                }
              },
              legend: {
                display: false
              },
              tooltip: this.getTooltipPluginConfiguration(),
              verticalHoverLine: {
                color: `rgba(${getTextColor(this.colorScheme)}, 0.1)`
              }
            },
            responsive: true,
            scales: {
              x: {
                border: {
                  color: `rgba(${getTextColor(this.colorScheme)}, 0.1)`,
                  width: 1
                },
                display: true,
                grid: {
                  display: false
                },
                type: 'time',
                time: {
                  tooltipFormat: getDateFormatString(this.locale),
                  unit: 'year'
                }
              },
              y: {
                border: {
                  width: 0
                },
                display: true,
                grid: {
                  color: ({ scale, tick }) => {
                    if (
                      tick.value === 0 ||
                      tick.value === scale.max ||
                      tick.value === scale.min
                    ) {
                      return `rgba(${getTextColor(this.colorScheme)}, 0.1)`;
                    }

                    return 'transparent';
                  }
                },
                position: 'right',
                ticks: {
                  callback: (value: number) => {
                    return `${value.toFixed(2)} %`;
                  },
                  display: true,
                  mirror: true,
                  z: 1
                }
              }
            }
          },
          plugins: [
            getVerticalHoverLinePlugin(this.chartCanvas, this.colorScheme)
          ],
          type: 'line'
        });
      }
    }
  }

  private getTooltipPluginConfiguration(): Partial<TooltipOptions<'line'>> {
    return {
      ...getTooltipOptions({
        colorScheme: this.colorScheme,
        locale: this.locale,
        unit: '%'
      }),
      mode: 'index',
      position: 'top',
      xAlign: 'center',
      yAlign: 'bottom'
    };
  }
}
