import type { GfAppQueryParams } from '@ghostfolio/client/interfaces/interfaces';
import { UserService } from '@ghostfolio/client/services/user/user.service';
import {
  DEFAULT_PAGE_SIZE,
  ghostfolioScraperApiSymbolPrefix
} from '@ghostfolio/common/config';
import { DashboardModuleType } from '@ghostfolio/common/dashboard';
import { getDateFormatString } from '@ghostfolio/common/helper';
import {
  AssetProfileIdentifier,
  Filter,
  InfoItem,
  User
} from '@ghostfolio/common/interfaces';
import { AdminMarketDataItem } from '@ghostfolio/common/interfaces/admin-market-data.interface';
import { hasPermission, permissions } from '@ghostfolio/common/permissions';
import { GfSymbolPipe } from '@ghostfolio/common/pipes';
import { GfActivitiesFilterComponent } from '@ghostfolio/ui/activities-filter';
import { translate } from '@ghostfolio/ui/i18n';
import { GfPremiumIndicatorComponent } from '@ghostfolio/ui/premium-indicator';
import { AdminService, DataService } from '@ghostfolio/ui/services';
import { GfValueComponent } from '@ghostfolio/ui/value';

import { SelectionModel } from '@angular/cdk/collections';
import { CommonModule } from '@angular/common';
import {
  AfterViewInit,
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  DestroyRef,
  OnInit,
  ViewChild
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { MatButtonModule } from '@angular/material/button';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatDialog } from '@angular/material/dialog';
import { MatMenuModule } from '@angular/material/menu';
import {
  MatPaginator,
  MatPaginatorModule,
  PageEvent
} from '@angular/material/paginator';
import {
  MatSort,
  MatSortModule,
  Sort,
  SortDirection
} from '@angular/material/sort';
import { MatTableDataSource, MatTableModule } from '@angular/material/table';
import { ActivatedRoute, Router, RouterModule } from '@angular/router';
import { IonIcon } from '@ionic/angular/standalone';
import { AssetSubClass, DataSource, SymbolProfile } from '@prisma/client';
import { isUUID } from 'class-validator';
import { addIcons } from 'ionicons';
import {
  addOutline,
  banOutline,
  createOutline,
  documentTextOutline,
  ellipsisHorizontal,
  ellipsisVertical,
  trashOutline
} from 'ionicons/icons';
import { DeviceDetectorService } from 'ngx-device-detector';
import { NgxSkeletonLoaderModule } from 'ngx-skeleton-loader';
import { Subject } from 'rxjs';
import { distinctUntilChanged } from 'rxjs/operators';

import { AdminMarketDataService } from './admin-market-data.service';
import { GfAssetProfileDialogComponent } from './asset-profile-dialog/asset-profile-dialog.component';
import { AssetProfileDialogParams } from './asset-profile-dialog/interfaces/interfaces';
import { GfCreateAssetProfileDialogComponent } from './create-asset-profile-dialog/create-asset-profile-dialog.component';
import { CreateAssetProfileDialogParams } from './create-asset-profile-dialog/interfaces/interfaces';

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'has-fab' },
  imports: [
    CommonModule,
    GfActivitiesFilterComponent,
    GfPremiumIndicatorComponent,
    GfSymbolPipe,
    GfValueComponent,
    IonIcon,
    MatButtonModule,
    MatCheckboxModule,
    MatMenuModule,
    MatPaginatorModule,
    MatSortModule,
    MatTableModule,
    NgxSkeletonLoaderModule,
    RouterModule
  ],
  providers: [AdminMarketDataService],
  selector: 'gf-admin-market-data',
  styleUrls: ['./admin-market-data.scss'],
  templateUrl: './admin-market-data.html'
})
export class GfAdminMarketDataComponent implements AfterViewInit, OnInit {
  @ViewChild(MatPaginator) paginator: MatPaginator;
  @ViewChild(MatSort) sort: MatSort;

  public activeFilters: Filter[] = [];
  public allFilters: Filter[] = [
    ...Object.keys(AssetSubClass)
      .filter((assetSubClass) => {
        return assetSubClass !== 'CASH';
      })
      .map((assetSubClass) => {
        return {
          id: assetSubClass.toString(),
          label: translate(assetSubClass),
          type: 'ASSET_SUB_CLASS' as Filter['type']
        };
      }),
    ...Object.keys(DataSource).map((dataSource) => {
      return {
        id: dataSource.toString(),
        label: dataSource,
        type: 'DATA_SOURCE' as Filter['type']
      };
    }),
    {
      id: 'BENCHMARKS',
      label: $localize`Benchmarks`,
      type: 'PRESET_ID' as Filter['type']
    },
    {
      id: 'CURRENCIES',
      label: $localize`Currencies`,
      type: 'PRESET_ID' as Filter['type']
    },
    {
      id: 'ETF_WITHOUT_COUNTRIES',
      label: $localize`ETFs without Countries`,
      type: 'PRESET_ID' as Filter['type']
    },
    {
      id: 'ETF_WITHOUT_SECTORS',
      label: $localize`ETFs without Sectors`,
      type: 'PRESET_ID' as Filter['type']
    },
    {
      id: 'NO_ACTIVITIES',
      label: $localize`No Activities`,
      type: 'PRESET_ID' as Filter['type']
    }
  ];
  public benchmarks: Partial<SymbolProfile>[];
  public currentDataSource: DataSource;
  public currentSymbol: string;
  public dataSource = new MatTableDataSource<AdminMarketDataItem>();
  public defaultDateFormat: string;
  public deviceType: string;
  public displayedColumns: string[] = [];
  public filters$ = new Subject<Filter[]>();
  public ghostfolioScraperApiSymbolPrefix = ghostfolioScraperApiSymbolPrefix;
  public hasPermissionForSubscription: boolean;
  public info: InfoItem;
  public isLoading = false;
  public isUUID = isUUID;
  public placeholder = '';
  public pageSize = DEFAULT_PAGE_SIZE;
  public selection: SelectionModel<Partial<SymbolProfile>>;
  public totalItems = 0;
  public user: User;

  /**
   * The query parameters that ask this module for a blank asset profile form.
   *
   * Bound by the floating action button in this component's template.
   * `assetProfileDialog` and the identifier pair it reads are nulled because
   * `assetProfileDialog` is tested *ahead* of `createAssetProfileDialog`, so a stale
   * request would re-open an existing profile instead of the blank form.
   */
  public readonly createDialogQueryParams = {
    assetProfileDialog: null as boolean,
    createAssetProfileDialog: true,
    dataSource: null as string,
    dialogModule: DashboardModuleType.ADMIN_MARKET_DATA,
    symbol: null as string
  };

  /**
   * The dialog request this module has already served, or `null` for none.
   *
   * Every producer on the canvas merges its query parameters rather than replacing
   * them - it has to, or it would drop a sibling module's and the shared-portfolio
   * identifier - so `route.queryParams` emits again whenever any *other* module
   * writes to the URL. Without this each of those emissions would open a second copy
   * of a dialog that is already up. Keyed on the asset rather than held as a flag,
   * so a request for a different asset profile is still honoured. Reset by the
   * parameters ceasing to ask for anything rather than by a dialog closing - see
   * {@link serveDialogRequest}.
   */
  private openedDialogAddress: string = null;

  /**
   * The query parameters as they stand, held rather than consumed on arrival.
   *
   * The dialogs this module opens are sized from `deviceType`, which is resolved in
   * `ngOnInit` - after the constructor. That ordering only matters on one canvas,
   * where a module is materialised lazily *in response to* a request that is already
   * on the URL, so the parameters arrive before the module can honour them properly:
   * the dialog was laid out for the wrong device every time it was reached this way.
   */
  private queryParams: GfAppQueryParams;

  public constructor(
    public adminMarketDataService: AdminMarketDataService,
    private adminService: AdminService,
    private changeDetectorRef: ChangeDetectorRef,
    private dataService: DataService,
    private destroyRef: DestroyRef,
    private deviceService: DeviceDetectorService,
    private dialog: MatDialog,
    private route: ActivatedRoute,
    private router: Router,
    private userService: UserService
  ) {
    this.info = this.dataService.fetchInfo();

    this.hasPermissionForSubscription = hasPermission(
      this.info?.globalPermissions,
      permissions.enableSubscription
    );

    this.displayedColumns = [
      'status',
      'select',
      'nameWithSymbol',
      'dataSource',
      'assetClass',
      'assetSubClass',
      'lastMarketPrice',
      'date',
      'activitiesCount',
      'marketDataItemCount',
      'sectorsCount',
      'countriesCount'
    ];

    if (this.hasPermissionForSubscription) {
      this.displayedColumns.push('isUsedByUsersWithSubscription');
    }

    this.displayedColumns.push('comment');
    this.displayedColumns.push('actions');

    this.route.queryParams
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((queryParams: GfAppQueryParams) => {
        this.queryParams = queryParams;

        this.applyQueryParams();
      });

    this.userService.stateChanged
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((state) => {
        if (state?.user) {
          this.user = state.user;

          this.defaultDateFormat = getDateFormatString(
            this.user.settings.locale
          );
        }
      });

    this.filters$
      .pipe(distinctUntilChanged(), takeUntilDestroyed(this.destroyRef))
      .subscribe((filters) => {
        this.activeFilters = filters;

        this.loadData();
      });

    addIcons({
      addOutline,
      banOutline,
      createOutline,
      documentTextOutline,
      ellipsisHorizontal,
      ellipsisVertical,
      trashOutline
    });
  }

  public ngAfterViewInit() {
    this.sort.sortChange.subscribe(
      ({ active: sortColumn, direction }: Sort) => {
        this.paginator.pageIndex = 0;

        this.loadData({
          sortColumn,
          sortDirection: direction,
          pageIndex: this.paginator.pageIndex
        });
      }
    );
  }

  public ngOnInit() {
    const { benchmarks } = this.dataService.fetchInfo();

    this.benchmarks = benchmarks;
    this.deviceType = this.deviceService.getDeviceInfo().deviceType;

    this.selection = new SelectionModel(true);

    // Re-evaluated now that the device is known, so a request that was already on
    // the URL when this module was created is honoured at the right size.
    this.applyQueryParams();
  }

  public onChangePage(page: PageEvent) {
    this.loadData({
      pageIndex: page.pageIndex,
      sortColumn: this.sort.active,
      sortDirection: this.sort.direction
    });
  }

  public onDeleteAssetProfile({ dataSource, symbol }: AssetProfileIdentifier) {
    this.adminMarketDataService.deleteAssetProfile({ dataSource, symbol });
  }

  public onDeleteAssetProfiles() {
    this.adminMarketDataService.deleteAssetProfiles(
      this.selection.selected.map(({ dataSource, symbol }) => {
        return { dataSource, symbol };
      })
    );
  }

  public onGather7Days() {
    this.adminService
      .gather7Days()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => {
        setTimeout(() => {
          window.location.reload();
        }, 300);
      });
  }

  public onGatherMax() {
    this.adminService
      .gatherMax()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => {
        setTimeout(() => {
          window.location.reload();
        }, 300);
      });
  }

  public onGatherProfileData() {
    this.adminService
      .gatherProfileData()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe();
  }

  public onGatherProfileDataBySymbol({
    dataSource,
    symbol
  }: AssetProfileIdentifier) {
    this.adminService
      .gatherProfileDataBySymbol({ dataSource, symbol })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe();
  }

  public onGatherSymbol({ dataSource, symbol }: AssetProfileIdentifier) {
    this.adminService
      .gatherSymbol({ dataSource, symbol })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe();
  }

  /**
   * The query parameters that ask this module to open an asset profile.
   *
   * Built here rather than inline in the template so that the row menu's edit link
   * and {@link onOpenAssetProfileDialog} cannot drift apart - a duplicated payload
   * is a match no compiler checks.
   *
   * Merged rather than replacing, because this URL is shared with every other placed
   * module and restating only these keys would drop the rest - a sibling module's
   * open dialog and the shared-portfolio access identifier among them. Merging in
   * turn obliges the request to null what it takes over: `dataSource` and `symbol`
   * are shared identifiers read by three different flags, the other two belonging to
   * the application shell and to the benchmark table, so leaving either up would
   * re-point *their* dialog at this asset. `dialogModule` names this module so the
   * flag is unambiguous even though this module is currently its only consumer.
   */
  public getAssetProfileQueryParams({
    dataSource,
    symbol
  }: AssetProfileIdentifier) {
    return {
      dataSource,
      symbol,
      assetProfileDialog: true,
      benchmarkDetailDialog: null,
      createAssetProfileDialog: null,
      dialogModule: DashboardModuleType.ADMIN_MARKET_DATA,
      holdingDetailDialog: null
    };
  }

  public onOpenAssetProfileDialog(
    aAssetProfileIdentifier: AssetProfileIdentifier
  ) {
    void this.router.navigate([], {
      queryParams: this.getAssetProfileQueryParams(aAssetProfileIdentifier),
      queryParamsHandling: 'merge',
      relativeTo: this.route
    });
  }

  /**
   * Opens a dialog unless the same request has already been served.
   *
   * Keyed on the request the URL is making rather than on the dialog's own
   * lifecycle. Resetting the record when the dialog closed instead was not
   * equivalent: the close handler removes the parameters through a navigation, and
   * until that navigation is applied the parameters still ask for the dialog that
   * has just been dismissed.
   *
   * The address carries the asset profile's identity, so being asked for a
   * *different* profile while one is open is honoured as the genuine second request
   * it is.
   */
  private serveDialogRequest(aAddress: string, aOpen?: () => void) {
    if (this.openedDialogAddress === aAddress) {
      return;
    }

    this.openedDialogAddress = aAddress;

    aOpen?.();
  }

  /**
   * Opens whatever the current query parameters ask this module for, once it is in a
   * position to open it properly.
   *
   * Reached from two places - a parameter change and the device becoming known -
   * because either can be the last to arrive, which makes idempotence a requirement
   * rather than a nicety.
   */
  private applyQueryParams() {
    if (!this.deviceType) {
      return;
    }

    const { assetProfileDialog, createAssetProfileDialog, dataSource, symbol } =
      this.queryParams ?? {};

    if (assetProfileDialog && dataSource && symbol) {
      this.serveDialogRequest(
        `assetProfileDialog:${dataSource}:${symbol}`,
        () => {
          this.openAssetProfileDialog({ dataSource, symbol });
        }
      );
    } else if (createAssetProfileDialog) {
      this.serveDialogRequest('createAssetProfileDialog', () => {
        this.openCreateAssetProfileDialog();
      });
    } else {
      // Nothing is being asked of this module. Forgetting what was last served is
      // what lets the same profile be asked for a second time: the close handler
      // removes the parameters it travelled on, this branch observes their absence,
      // and the next identical request is therefore new again.
      this.serveDialogRequest(null);
    }
  }

  /**
   * Removes the query parameters this module's dialogs travel on, and only those.
   *
   * The empty command array keeps the request on the current URL - the workspace's
   * route-agnostic convention - and merging is what makes the clear safe on a single
   * canvas. The `navigate(['.'])` this replaced named a route segment instead, which
   * dropped every query parameter on the canvas: closing this module's dialog also
   * closed a sibling module's and discarded the shared-portfolio access identifier
   * along with it.
   */
  private clearDialogQueryParams() {
    void this.router.navigate([], {
      queryParams: {
        assetProfileDialog: null,
        createAssetProfileDialog: null,
        dataSource: null,
        dialogModule: null,
        symbol: null
      },
      queryParamsHandling: 'merge',
      relativeTo: this.route
    });
  }

  private loadData(
    {
      pageIndex,
      sortColumn,
      sortDirection
    }: {
      pageIndex: number;
      sortColumn?: string;
      sortDirection?: SortDirection;
    } = { pageIndex: 0 }
  ) {
    this.isLoading = true;

    this.pageSize =
      this.activeFilters.length === 1 &&
      this.activeFilters[0].type === 'PRESET_ID'
        ? Number.MAX_SAFE_INTEGER
        : DEFAULT_PAGE_SIZE;

    if (pageIndex === 0 && this.paginator) {
      this.paginator.pageIndex = 0;
    }

    this.placeholder =
      this.activeFilters.length <= 0 ? $localize`Filter by...` : '';

    this.selection.clear();

    this.adminService
      .fetchAdminMarketData({
        sortColumn,
        sortDirection,
        filters: this.activeFilters,
        skip: pageIndex * this.pageSize,
        take: this.pageSize
      })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(({ count, marketData }) => {
        this.totalItems = count;

        this.dataSource = new MatTableDataSource(
          marketData.map((marketDataItem) => {
            return {
              ...marketDataItem,
              isBenchmark: this.benchmarks.some(({ id }) => {
                return id === marketDataItem.id;
              })
            };
          })
        );
        this.dataSource.sort = this.sort;

        this.isLoading = false;

        this.changeDetectorRef.markForCheck();
      });
  }

  private openAssetProfileDialog({
    dataSource,
    symbol
  }: {
    dataSource: DataSource;
    symbol: string;
  }) {
    this.userService
      .get()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((user) => {
        this.user = user;

        const dialogRef = this.dialog.open<
          GfAssetProfileDialogComponent,
          AssetProfileDialogParams
        >(GfAssetProfileDialogComponent, {
          autoFocus: false,
          data: {
            dataSource,
            symbol,
            colorScheme: this.user?.settings.colorScheme,
            deviceType: this.deviceType,
            locale: this.user?.settings?.locale
          },
          height: this.deviceType === 'mobile' ? '98vh' : '80vh',
          width: this.deviceType === 'mobile' ? '100vw' : '50rem'
        });

        dialogRef
          .afterClosed()
          .pipe(takeUntilDestroyed(this.destroyRef))
          .subscribe(
            (newAssetProfileIdentifier: AssetProfileIdentifier | undefined) => {
              if (newAssetProfileIdentifier) {
                this.onOpenAssetProfileDialog(newAssetProfileIdentifier);
              } else {
                this.clearDialogQueryParams();
              }
            }
          );
      });
  }

  private openCreateAssetProfileDialog() {
    this.userService
      .get()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((user) => {
        this.user = user;

        const dialogRef = this.dialog.open<
          GfCreateAssetProfileDialogComponent,
          CreateAssetProfileDialogParams
        >(GfCreateAssetProfileDialogComponent, {
          autoFocus: false,
          data: {
            deviceType: this.deviceType,
            locale: this.user?.settings?.locale
          },
          width: this.deviceType === 'mobile' ? '100vw' : '50rem'
        });

        dialogRef
          .afterClosed()
          .pipe(takeUntilDestroyed(this.destroyRef))
          .subscribe((result) => {
            if (!result) {
              this.clearDialogQueryParams();

              return;
            }

            const { addAssetProfile, dataSource, symbol } = result;

            if (addAssetProfile && dataSource && symbol) {
              this.adminService
                .addAssetProfile({ dataSource, symbol })
                .pipe(takeUntilDestroyed(this.destroyRef))
                .subscribe(() => {
                  this.loadData();
                });
            } else {
              this.loadData();
            }

            this.onOpenAssetProfileDialog({ dataSource, symbol });
          });
      });
  }
}
