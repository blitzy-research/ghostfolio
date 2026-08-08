import { DashboardModuleType } from '@ghostfolio/common/dashboard';
import { ConfirmationDialogType } from '@ghostfolio/common/enums';
import {
  getLocale,
  getLowercase,
  resolveMarketCondition
} from '@ghostfolio/common/helper';
import {
  AssetProfileIdentifier,
  Benchmark,
  User
} from '@ghostfolio/common/interfaces';
import { NotificationService } from '@ghostfolio/ui/notifications';

import { CommonModule } from '@angular/common';
import {
  CUSTOM_ELEMENTS_SCHEMA,
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  input,
  output,
  viewChild
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { MatButtonModule } from '@angular/material/button';
import { MatDialog } from '@angular/material/dialog';
import { MatMenuModule } from '@angular/material/menu';
import { MatSort, MatSortModule } from '@angular/material/sort';
import { MatTableDataSource, MatTableModule } from '@angular/material/table';
import { ActivatedRoute, Router, RouterModule } from '@angular/router';
import { IonIcon } from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import { ellipsisHorizontal, trashOutline } from 'ionicons/icons';
import { isNumber } from 'lodash';
import { NgxSkeletonLoaderModule } from 'ngx-skeleton-loader';

import { translate } from '../i18n';
import { GfTrendIndicatorComponent } from '../trend-indicator/trend-indicator.component';
import { GfValueComponent } from '../value/value.component';
import { GfBenchmarkDetailDialogComponent } from './benchmark-detail-dialog/benchmark-detail-dialog.component';
import { BenchmarkDetailDialogParams } from './benchmark-detail-dialog/interfaces/interfaces';

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    CommonModule,
    GfTrendIndicatorComponent,
    GfValueComponent,
    IonIcon,
    MatButtonModule,
    MatMenuModule,
    MatSortModule,
    MatTableModule,
    NgxSkeletonLoaderModule,
    RouterModule
  ],
  schemas: [CUSTOM_ELEMENTS_SCHEMA],
  selector: 'gf-benchmark',
  styleUrls: ['./benchmark.component.scss'],
  templateUrl: './benchmark.component.html'
})
export class GfBenchmarkComponent {
  public readonly benchmarks = input.required<Benchmark[]>();
  public readonly deviceType = input.required<string>();

  /**
   * The module this instance stands for, as the discriminator its dialog request
   * is addressed with.
   *
   * Required rather than optional, and that is deliberate. Three modules mount
   * this component - markets, premium markets and the watchlist - and on the
   * single-canvas shell all three can be on screen at once, all three observe the
   * same query parameters, and `benchmarkDetailDialog` said nothing about which of
   * them a request was for. One click therefore opened the dialog up to three
   * times over. An optional input would have left that outcome reachable simply by
   * forgetting to pass it, in a template that would still compile; requiring it
   * makes a new host declare its identity or fail to build.
   */
  public readonly dialogModule = input.required<DashboardModuleType>();

  public readonly hasPermissionToDeleteItem = input<boolean>();
  public readonly locale = input(getLocale());
  public readonly showSymbol = input(true);
  public readonly user = input<User>();

  public readonly itemDeleted = output<AssetProfileIdentifier>();

  protected readonly sort = viewChild(MatSort);

  protected readonly dataSource = new MatTableDataSource<Benchmark>([]);
  protected readonly displayedColumns = computed(() => {
    return [
      'name',
      ...(this.user()?.settings?.isExperimentalFeatures
        ? ['trend50d', 'trend200d']
        : []),
      'date',
      'change',
      'marketCondition',
      'actions'
    ];
  });
  protected isLoading = true;
  protected readonly isNumber = isNumber;
  protected readonly resolveMarketCondition = resolveMarketCondition;
  protected readonly translate = translate;

  private readonly destroyRef = inject(DestroyRef);
  private readonly dialog = inject(MatDialog);
  private readonly notificationService = inject(NotificationService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);

  /**
   * The benchmark whose detail dialog this instance has already been asked for, or
   * `null` for none.
   */
  private servedDialogAddress: string | null = null;

  public constructor() {
    effect(() => {
      const benchmarks = this.benchmarks();

      if (benchmarks) {
        this.dataSource.data = benchmarks;
        this.dataSource.sortingDataAccessor = getLowercase;

        this.dataSource.sort = this.sort() ?? null;

        this.isLoading = false;
      }
    });

    this.route.queryParams
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((params) => {
        const isRequested =
          params['benchmarkDetailDialog'] &&
          params['dataSource'] &&
          params['symbol'] &&
          // The gate that makes exactly one of the co-mounted instances answer.
          params['dialogModule'] === this.dialogModule();

        // Keyed on the request the URL is making rather than on the dialog's own
        // lifecycle, so that a request already served is not served again - every
        // producer on the canvas merges, so these parameters are re-observed
        // whenever any other module writes to the URL - and a request withdrawn is
        // forgotten, which is what lets the same benchmark be opened a second time.
        const address: string | null = isRequested
          ? `${params['dataSource']}:${params['symbol']}`
          : null;

        if (this.servedDialogAddress === address) {
          return;
        }

        this.servedDialogAddress = address;

        if (isRequested) {
          this.openBenchmarkDetailDialog({
            dataSource: params['dataSource'],
            symbol: params['symbol']
          });
        }
      });

    addIcons({ ellipsisHorizontal, trashOutline });
  }

  protected onDeleteItem({ dataSource, symbol }: AssetProfileIdentifier) {
    this.notificationService.confirm({
      confirmFn: () => {
        this.itemDeleted.emit({ dataSource, symbol });
      },
      confirmType: ConfirmationDialogType.Warn,
      title: $localize`Do you really want to delete this item?`
    });
  }

  protected onOpenBenchmarkDialog({
    dataSource,
    symbol
  }: AssetProfileIdentifier) {
    // Merging in turn obliges this producer to null what it is taking over.
    // `dataSource` and `symbol` are shared identifiers: three flags read that same
    // pair, and the other two are read by the application shell and by the market
    // data administration module. Leaving either of them up would re-point *their*
    // dialog at this benchmark rather than merely leaving it alone.
    void this.router.navigate([], {
      queryParams: {
        dataSource,
        symbol,
        assetProfileDialog: null,
        benchmarkDetailDialog: true,
        dialogModule: this.dialogModule(),
        holdingDetailDialog: null
      },
      queryParamsHandling: 'merge',
      relativeTo: this.route
    });
  }

  private openBenchmarkDetailDialog({
    dataSource,
    symbol
  }: AssetProfileIdentifier) {
    const dialogRef = this.dialog.open<
      GfBenchmarkDetailDialogComponent,
      BenchmarkDetailDialogParams
    >(GfBenchmarkDetailDialogComponent, {
      data: {
        dataSource,
        symbol,
        colorScheme: this.user()?.settings?.colorScheme,
        deviceType: this.deviceType(),
        locale: this.locale()
      },
      height: this.deviceType() === 'mobile' ? '98vh' : undefined,
      width: this.deviceType() === 'mobile' ? '100vw' : '50rem'
    });

    dialogRef
      .afterClosed()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => {
        // Removes the parameters this dialog travelled on, and only those. The
        // `navigate(['.'])` this replaced named a route segment instead, which
        // dropped every query parameter on the canvas: closing this dialog also
        // closed a sibling module's and discarded the shared-portfolio access
        // identifier along with it.
        void this.router.navigate([], {
          queryParams: {
            benchmarkDetailDialog: null,
            dataSource: null,
            dialogModule: null,
            symbol: null
          },
          queryParamsHandling: 'merge',
          relativeTo: this.route
        });
      });
  }
}
