import { DashboardIntentService } from '@ghostfolio/client/core/dashboard-intent.service';
import { UserService } from '@ghostfolio/client/services/user/user.service';
import {
  NUMERICAL_PRECISION_THRESHOLD_3_FIGURES,
  NUMERICAL_PRECISION_THRESHOLD_5_FIGURES,
  NUMERICAL_PRECISION_THRESHOLD_6_FIGURES
} from '@ghostfolio/common/config';
import { DashboardModuleType } from '@ghostfolio/common/dashboard';
import { CreateOrderDto } from '@ghostfolio/common/dtos';
import {
  DATE_FORMAT,
  downloadAsFile,
  isKnownDataSource
} from '@ghostfolio/common/helper';
import { reportSanitizedError } from '@ghostfolio/common/helper';
import {
  Activity,
  DataProviderInfo,
  EnhancedSymbolProfile,
  Filter,
  LineChartItem,
  User
} from '@ghostfolio/common/interfaces';
import { hasPermission, permissions } from '@ghostfolio/common/permissions';
import { GfAccountsTableComponent } from '@ghostfolio/ui/accounts-table';
import { GfActivitiesTableComponent } from '@ghostfolio/ui/activities-table';
import { GfDataProviderCreditsComponent } from '@ghostfolio/ui/data-provider-credits';
import { GfDialogFooterComponent } from '@ghostfolio/ui/dialog-footer';
import { GfDialogHeaderComponent } from '@ghostfolio/ui/dialog-header';
import { GfHistoricalMarketDataEditorComponent } from '@ghostfolio/ui/historical-market-data-editor';
import { translate } from '@ghostfolio/ui/i18n';
import { GfLineChartComponent } from '@ghostfolio/ui/line-chart';
import { GfPortfolioProportionChartComponent } from '@ghostfolio/ui/portfolio-proportion-chart';
import { DataService } from '@ghostfolio/ui/services';
import { GfTagsSelectorComponent } from '@ghostfolio/ui/tags-selector';
import { GfValueComponent } from '@ghostfolio/ui/value';

import { CommonModule } from '@angular/common';
import {
  CUSTOM_ELEMENTS_SCHEMA,
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  DestroyRef,
  Inject,
  OnInit
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormBuilder, FormGroup, ReactiveFormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatChipsModule } from '@angular/material/chips';
import {
  MAT_DIALOG_DATA,
  MatDialogModule,
  MatDialogRef
} from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { SortDirection } from '@angular/material/sort';
import { MatTableDataSource } from '@angular/material/table';
import { MatTabsModule } from '@angular/material/tabs';
import { Router } from '@angular/router';
import { IonIcon } from '@ionic/angular/standalone';
import { Account, MarketData, Tag } from '@prisma/client';
import { isUUID } from 'class-validator';
import { format, isSameMonth, isToday, parseISO } from 'date-fns';
import { StatusCodes } from 'http-status-codes';
import { addIcons } from 'ionicons';
import {
  arrowDownCircleOutline,
  createOutline,
  flagOutline,
  readerOutline,
  serverOutline,
  swapVerticalOutline,
  walletOutline
} from 'ionicons/icons';
import { NgxSkeletonLoaderModule } from 'ngx-skeleton-loader';
import { switchMap } from 'rxjs/operators';

import {
  HoldingDetailDialogParams,
  HoldingDetailDialogResult
} from './interfaces/interfaces';

/**
 * The stable event identifier a failed holding read is reported under.
 *
 * Fixed so it stays searchable in a log that outlives the dialog, and used only for
 * a genuine fault: a holding that simply has no details to return is an ordinary
 * outcome rather than something to report.
 */
const HOLDING_DETAIL_FETCH_FAILED_EVENT = 'GF-HOLDING-DETAIL-FETCH-FAILED';

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'd-flex flex-column h-100' },
  imports: [
    CommonModule,
    GfAccountsTableComponent,
    GfActivitiesTableComponent,
    GfDataProviderCreditsComponent,
    GfDialogFooterComponent,
    GfDialogHeaderComponent,
    GfHistoricalMarketDataEditorComponent,
    GfLineChartComponent,
    GfPortfolioProportionChartComponent,
    GfTagsSelectorComponent,
    GfValueComponent,
    IonIcon,
    MatButtonModule,
    MatChipsModule,
    MatDialogModule,
    MatFormFieldModule,
    MatTabsModule,
    NgxSkeletonLoaderModule,
    ReactiveFormsModule
  ],
  schemas: [CUSTOM_ELEMENTS_SCHEMA],
  selector: 'gf-holding-detail-dialog',
  styleUrls: ['./holding-detail-dialog.component.scss'],
  templateUrl: 'holding-detail-dialog.html'
})
export class GfHoldingDetailDialogComponent implements OnInit {
  public activitiesCount: number;
  public accounts: Account[];
  public assetClass: string;
  public assetSubClass: string;
  public averagePrice: number;
  public averagePricePrecision = 2;
  public benchmarkDataItems: LineChartItem[];
  public benchmarkLabel = $localize`Average Unit Price`;
  public countries: {
    [code: string]: { name: string; value: number };
  };
  public dataProviderInfo: DataProviderInfo;
  public dataSource: MatTableDataSource<Activity>;
  public dateOfFirstActivity: string;
  public dividendInBaseCurrency: number;
  public dividendInBaseCurrencyPrecision = 2;
  public dividendYieldPercentWithCurrencyEffect: number;
  public feeInBaseCurrency: number;
  /**
   * Whether the holding's own details could not be read.
   *
   * The request had no failure handler at all, so a rejection left every field
   * undefined and the dialog sat on its loading state for as long as it stayed
   * open - with no message, no retry and, because the header takes its title from
   * the profile that never arrived, not even a name. A cash position reaches
   * exactly this path: it has no asset profile to read, so the server answers 404
   * and the dialog hung on the one holding almost every portfolio contains.
   */
  public hasError = false;

  /**
   * Whether the failure was the holding simply having no details to show.
   *
   * Separated from any other failure because it is not really an error from the
   * viewer's side and must not be dressed up as one: a cash line is a balance, it
   * has no market price, no chart and no asset profile, so "not found" is the
   * correct answer to the question and the dialog should say so plainly rather
   * than offering to retry something that will never succeed.
   */
  public hasNoDetails = false;

  public hasPermissionToCreateOwnTag: boolean;
  public hasPermissionToReadMarketDataOfOwnAssetProfile: boolean;

  /**
   * Whether the holding's own details are still on their way.
   *
   * Held explicitly rather than inferred from a field being undefined, because
   * every one of those fields is legitimately undefined while the request is in
   * flight AND after it fails - which is precisely why the two states were
   * indistinguishable before.
   */
  public isLoading = true;
  public historicalDataItems: LineChartItem[];
  public holdingForm: FormGroup;
  public investmentInBaseCurrencyWithCurrencyEffect: number;
  public investmentInBaseCurrencyWithCurrencyEffectPrecision = 2;
  public isUUID = isUUID;
  public marketDataItems: MarketData[] = [];
  public marketPrice: number;
  public marketPriceMax: number;
  public marketPriceMaxPrecision = 2;
  public marketPriceMin: number;
  public marketPriceMinPrecision = 2;
  public marketPricePrecision = 2;
  public netPerformance: number;
  public netPerformancePrecision = 2;
  public netPerformancePercent: number;
  public netPerformancePercentWithCurrencyEffect: number;
  public netPerformancePercentWithCurrencyEffectPrecision = 2;
  public netPerformanceWithCurrencyEffect: number;
  public netPerformanceWithCurrencyEffectPrecision = 2;
  public quantity: number;
  public quantityPrecision = 2;
  public reportDataGlitchMail: string;
  public sectors: {
    [name: string]: { name: string; value: number };
  };
  public sortColumn = 'date';
  public sortDirection: SortDirection = 'desc';
  public SymbolProfile: EnhancedSymbolProfile;
  public tags: Tag[];
  public tagsAvailable: Tag[];
  public user: User;
  public value: number;

  public constructor(
    private changeDetectorRef: ChangeDetectorRef,
    private dataService: DataService,
    private dashboardIntentService: DashboardIntentService,
    private destroyRef: DestroyRef,
    // Typed with its close result as well as its own component type. The asset
    // profile hand-off below resolves with `{ hasHandedOverAssetProfile: true }`
    // and every other close resolves with nothing, and the shell relies on that
    // difference to decide whether clearing this dialog's parameters would take the
    // hand-off's with them - so the union belongs on the reference rather than in an
    // assertion made by the shell.
    public dialogRef: MatDialogRef<
      GfHoldingDetailDialogComponent,
      HoldingDetailDialogResult | undefined
    >,
    @Inject(MAT_DIALOG_DATA) public data: HoldingDetailDialogParams,
    private formBuilder: FormBuilder,
    private router: Router,
    private userService: UserService
  ) {
    addIcons({
      arrowDownCircleOutline,
      createOutline,
      flagOutline,
      readerOutline,
      serverOutline,
      swapVerticalOutline,
      walletOutline
    });
  }

  public ngOnInit() {
    // Every request this dialog issues is keyed by the identifier it was opened
    // with, and one of its openers is the root route's own query parameters. A
    // dialog opened for an asset this application cannot name would send that
    // unvetted value onwards under the viewer's credentials, so it is closed
    // instead of asking. The vetting is repeated here rather than trusted from
    // the opener because the type of `data` is a claim, not a guarantee, and
    // this component is reachable from a dozen call sites.
    if (!isKnownDataSource(this.data.dataSource) || !this.data.symbol) {
      this.dialogRef.close();

      return;
    }

    const filters: Filter[] = [
      { id: this.data.dataSource, type: 'DATA_SOURCE' },
      { id: this.data.symbol, type: 'SYMBOL' }
    ];

    this.holdingForm = this.formBuilder.group({
      tags: [] as string[]
    });

    this.holdingForm
      .get('tags')
      .valueChanges.pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((tags: Tag[]) => {
        const newTag = tags.find(({ id }) => {
          return id === undefined;
        });

        if (newTag && this.hasPermissionToCreateOwnTag) {
          this.dataService
            .postTag({ ...newTag, userId: this.user.id })
            .pipe(
              switchMap((createdTag) => {
                return this.dataService.putHoldingTags({
                  dataSource: this.data.dataSource,
                  symbol: this.data.symbol,
                  tags: [
                    ...tags.filter(({ id }) => {
                      return id !== undefined;
                    }),
                    createdTag
                  ]
                });
              }),
              switchMap(() => {
                return this.userService.get(true);
              }),
              takeUntilDestroyed(this.destroyRef)
            )
            .subscribe();
        } else {
          this.dataService
            .putHoldingTags({
              tags,
              dataSource: this.data.dataSource,
              symbol: this.data.symbol
            })
            .pipe(takeUntilDestroyed(this.destroyRef))
            .subscribe();
        }
      });

    this.dataService
      .fetchAccounts({
        filters
      })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(({ accounts }) => {
        this.accounts = accounts;

        this.changeDetectorRef.markForCheck();
      });

    this.dataService
      .fetchActivities({
        filters,
        sortColumn: this.sortColumn,
        sortDirection: this.sortDirection
      })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(({ activities }) => {
        this.dataSource = new MatTableDataSource(activities);

        this.changeDetectorRef.markForCheck();
      });

    this.loadHoldingDetail();

    this.userService.stateChanged
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((state) => {
        if (state?.user) {
          this.user = state.user;

          this.hasPermissionToCreateOwnTag =
            hasPermission(this.user.permissions, permissions.createOwnTag) &&
            this.user?.settings?.isExperimentalFeatures;

          this.tagsAvailable =
            this.user?.tags?.map((tag) => {
              return {
                ...tag,
                name: translate(tag.name)
              };
            }) ?? [];

          this.changeDetectorRef.markForCheck();
        }
      });
  }

  public onCloneActivity(aActivity: Activity) {
    this.dashboardIntentService
      .getRevealModuleSubject()
      .next(DashboardModuleType.ACTIVITIES);

    // The flag is addressed to the activities module by name, so no other
    // co-mounted module consumes it, and the three keys that identify *this*
    // dialog are cleared in the same navigation - without that the shell would
    // see its own flag still standing and reopen this dialog on top of the one
    // being asked for.
    void this.router.navigate([], {
      queryParams: {
        activityId: aActivity.id,
        createDialog: true,
        dataSource: null,
        dialogModule: DashboardModuleType.ACTIVITIES,
        holdingDetailDialog: null,
        symbol: null
      },
      queryParamsHandling: 'merge'
    });

    this.dialogRef.close();
  }

  /**
   * Closes the loading state after a failed read and classifies what failed.
   *
   * The classification is the whole of the cash fix. A holding with no asset
   * profile - a cash balance is the everyday example - genuinely has no detail to
   * return, and the server says so with 404. Treating that as an error would offer
   * a retry that can only fail again, so it is reported as the absence it is, and
   * anything else is reported as a fault that is worth trying again.
   *
   * The status is read defensively rather than by asserting an `HttpErrorResponse`:
   * this handler must finish the loading state for ANY rejection, including one that
   * never reached the network and therefore carries no status at all.
   */
  private finalizeHoldingDetail(aError: unknown) {
    const status = (aError as { status?: number })?.status;

    this.hasNoDetails = status === StatusCodes.NOT_FOUND;
    this.hasError = !this.hasNoDetails;
    this.isLoading = false;

    // Reported only for a genuine fault. A holding without details is an ordinary
    // outcome, and logging it would put a line in the console of every portfolio
    // that holds cash.
    if (this.hasError) {
      reportSanitizedError(HOLDING_DETAIL_FETCH_FAILED_EVENT, aError);
    }

    this.changeDetectorRef.markForCheck();
  }

  /**
   * Reads the holding's own details.
   *
   * Extracted so it can be asked for a SECOND time. The request used to be issued
   * inline with no failure handler, which made a rejection unrecoverable in two
   * separate ways: nothing reported it, and there was no way to ask again without
   * closing and reopening the dialog - which, since the dialog is addressed by a
   * query parameter that was still set, reopened it into the same dead state.
   */
  private loadHoldingDetail() {
    this.dataService
      .fetchHoldingDetail({
        dataSource: this.data.dataSource,
        symbol: this.data.symbol
      })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        error: (error: unknown) => {
          this.finalizeHoldingDetail(error);
        },
        next: ({
          activitiesCount,
          averagePrice,
          dataProviderInfo,
          dateOfFirstActivity,
          dividendInBaseCurrency,
          dividendYieldPercentWithCurrencyEffect,
          feeInBaseCurrency,
          historicalData,
          investmentInBaseCurrencyWithCurrencyEffect,
          marketPrice,
          marketPriceMax,
          marketPriceMin,
          netPerformance,
          netPerformancePercent,
          netPerformancePercentWithCurrencyEffect,
          netPerformanceWithCurrencyEffect,
          quantity,
          SymbolProfile,
          tags,
          value
        }) => {
          this.activitiesCount = activitiesCount;
          this.averagePrice = averagePrice;

          if (
            this.averagePrice >= NUMERICAL_PRECISION_THRESHOLD_6_FIGURES &&
            this.data.deviceType === 'mobile'
          ) {
            this.averagePricePrecision = 0;
          }

          this.benchmarkDataItems = [];
          this.countries = {};
          this.dataProviderInfo = dataProviderInfo;
          this.dateOfFirstActivity = dateOfFirstActivity;
          this.dividendInBaseCurrency = dividendInBaseCurrency;

          if (
            this.data.deviceType === 'mobile' &&
            this.dividendInBaseCurrency >=
              NUMERICAL_PRECISION_THRESHOLD_6_FIGURES
          ) {
            this.dividendInBaseCurrencyPrecision = 0;
          }

          this.dividendYieldPercentWithCurrencyEffect =
            dividendYieldPercentWithCurrencyEffect;

          this.feeInBaseCurrency = feeInBaseCurrency;

          this.hasPermissionToReadMarketDataOfOwnAssetProfile =
            hasPermission(
              this.user?.permissions,
              permissions.readMarketDataOfOwnAssetProfile
            ) &&
            SymbolProfile?.dataSource === 'MANUAL' &&
            SymbolProfile?.userId === this.user?.id;

          this.historicalDataItems = historicalData.map(
            ({ averagePrice, date, marketPrice }) => {
              this.benchmarkDataItems.push({
                date,
                value: averagePrice
              });

              return {
                date,
                value: marketPrice
              };
            }
          );

          this.investmentInBaseCurrencyWithCurrencyEffect =
            investmentInBaseCurrencyWithCurrencyEffect;

          if (
            this.data.deviceType === 'mobile' &&
            this.investmentInBaseCurrencyWithCurrencyEffect >=
              NUMERICAL_PRECISION_THRESHOLD_6_FIGURES
          ) {
            this.investmentInBaseCurrencyWithCurrencyEffectPrecision = 0;
          }

          this.marketPrice = marketPrice;
          this.marketPriceMax = marketPriceMax;

          if (
            this.data.deviceType === 'mobile' &&
            this.marketPriceMax >= NUMERICAL_PRECISION_THRESHOLD_6_FIGURES
          ) {
            this.marketPriceMaxPrecision = 0;
          }

          this.marketPriceMin = marketPriceMin;

          if (
            this.data.deviceType === 'mobile' &&
            this.marketPriceMin >= NUMERICAL_PRECISION_THRESHOLD_6_FIGURES
          ) {
            this.marketPriceMinPrecision = 0;
          }

          if (
            this.data.deviceType === 'mobile' &&
            this.marketPrice >= NUMERICAL_PRECISION_THRESHOLD_6_FIGURES
          ) {
            this.marketPricePrecision = 0;
          }

          this.netPerformance = netPerformance;

          if (
            this.data.deviceType === 'mobile' &&
            this.netPerformance >= NUMERICAL_PRECISION_THRESHOLD_6_FIGURES
          ) {
            this.netPerformancePrecision = 0;
          }

          this.netPerformancePercent = netPerformancePercent;

          this.netPerformancePercentWithCurrencyEffect =
            netPerformancePercentWithCurrencyEffect;

          if (
            this.data.deviceType === 'mobile' &&
            this.netPerformancePercentWithCurrencyEffect >=
              NUMERICAL_PRECISION_THRESHOLD_3_FIGURES
          ) {
            this.netPerformancePercentWithCurrencyEffectPrecision = 0;
          }

          this.netPerformanceWithCurrencyEffect =
            netPerformanceWithCurrencyEffect;

          if (
            this.data.deviceType === 'mobile' &&
            this.netPerformanceWithCurrencyEffect >=
              NUMERICAL_PRECISION_THRESHOLD_5_FIGURES
          ) {
            this.netPerformanceWithCurrencyEffectPrecision = 0;
          }

          this.quantity = quantity;

          if (Number.isInteger(this.quantity)) {
            this.quantityPrecision = 0;
          } else if (SymbolProfile?.assetSubClass === 'CRYPTOCURRENCY') {
            if (this.quantity < 10) {
              this.quantityPrecision = 8;
            } else if (this.quantity < 1000) {
              this.quantityPrecision = 6;
            } else if (this.quantity >= 10000000) {
              this.quantityPrecision = 0;
            }
          }

          this.reportDataGlitchMail = `mailto:hi@ghostfol.io?Subject=Ghostfolio Data Glitch Report&body=Hello%0D%0DI would like to report a data glitch for%0D%0DSymbol: ${SymbolProfile?.symbol}%0DData Source: ${SymbolProfile?.dataSource}%0D%0DAdditional notes:%0D%0DCan you please take a look?%0D%0DKind regards`;
          this.sectors = {};
          this.SymbolProfile = SymbolProfile;

          this.tags = tags.map((tag) => {
            return {
              ...tag,
              name: translate(tag.name)
            };
          });

          this.holdingForm.setValue({ tags: this.tags }, { emitEvent: false });

          this.value = value;

          if (SymbolProfile?.assetClass) {
            this.assetClass = translate(SymbolProfile?.assetClass);
          }

          if (SymbolProfile?.assetSubClass) {
            this.assetSubClass = translate(SymbolProfile?.assetSubClass);
          }

          if (SymbolProfile?.countries?.length > 0) {
            for (const country of SymbolProfile.countries) {
              this.countries[country.code] = {
                name: country.name,
                value: country.weight
              };
            }
          }

          if (SymbolProfile?.sectors?.length > 0) {
            for (const sector of SymbolProfile.sectors) {
              this.sectors[sector.name] = {
                name: sector.name,
                value: sector.weight
              };
            }
          }

          if (isToday(parseISO(this.dateOfFirstActivity))) {
            this.historicalDataItems.push({
              date: this.dateOfFirstActivity,
              value: this.averagePrice
            });

            this.benchmarkDataItems.push({
              date: this.dateOfFirstActivity,
              value: averagePrice
            });

            this.historicalDataItems.push({
              date: new Date().toISOString(),
              value: this.marketPrice
            });

            this.benchmarkDataItems.push({
              date: new Date().toISOString(),
              value: averagePrice
            });
          } else {
            this.historicalDataItems.push({
              date: format(new Date(), DATE_FORMAT),
              value: this.marketPrice
            });

            this.benchmarkDataItems.push({
              date: format(new Date(), DATE_FORMAT),
              value: averagePrice
            });
          }

          if (
            this.benchmarkDataItems[0]?.value === undefined &&
            isSameMonth(parseISO(this.dateOfFirstActivity), new Date())
          ) {
            this.benchmarkDataItems[0].value = this.averagePrice;
          }

          this.benchmarkDataItems = this.benchmarkDataItems.map(
            ({ date, value }) => {
              return {
                date,
                value: value === 0 ? null : value
              };
            }
          );

          if (this.hasPermissionToReadMarketDataOfOwnAssetProfile) {
            this.fetchMarketData();
          }

          this.isLoading = false;

          this.changeDetectorRef.markForCheck();
        }
      });
  }

  public onClose() {
    this.dialogRef.close();
  }

  /**
   * Tries the holding's details again.
   *
   * Offered only for a failure that could plausibly have been transient, which is
   * why the no-details case does not get this control: retrying a holding that has
   * no asset profile would fail identically every time, and offering the action
   * would be an invitation to keep pressing it.
   */
  public onRetryHoldingDetail() {
    this.hasError = false;
    this.isLoading = true;

    this.changeDetectorRef.markForCheck();

    this.loadHoldingDetail();
  }

  public onCloseHolding() {
    const today = new Date();

    const activity: CreateOrderDto = {
      accountId: this.accounts.length === 1 ? this.accounts[0].id : null,
      comment: null,
      currency: this.SymbolProfile.currency,
      dataSource: this.SymbolProfile.dataSource,
      date: today.toISOString(),
      fee: 0,
      quantity: this.quantity,
      symbol: this.SymbolProfile.symbol,
      tags: this.tags.map(({ id }) => {
        return id;
      }),
      type: 'SELL',
      unitPrice: this.marketPrice
    };

    this.dataService
      .postActivity(activity)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => {
        this.dashboardIntentService
          .getRevealModuleSubject()
          .next(DashboardModuleType.ACTIVITIES);

        this.dialogRef.close();
      });
  }

  public onExport() {
    const activityIds = this.dataSource.data.map(({ id }) => {
      return id;
    });

    this.dataService
      .fetchExport({ activityIds })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((data) => {
        downloadAsFile({
          content: data,
          fileName: `ghostfolio-export-${this.SymbolProfile?.symbol}-${format(
            parseISO(data.meta.date),
            'yyyyMMddHHmm'
          )}.json`,
          format: 'json'
        });
      });
  }

  public onMarketDataChanged(withRefresh = false) {
    if (withRefresh) {
      this.fetchMarketData();
    }
  }

  public onOpenAssetProfileDialog() {
    this.dashboardIntentService
      .getRevealModuleSubject()
      .next(DashboardModuleType.ADMIN_MARKET_DATA);

    // `dataSource` and `symbol` are shared with this dialog's own parameters, so
    // only the flag that identifies it is dropped - the pair is being handed on
    // rather than cleared. `benchmarkDetailDialog` is dropped with it: it is the
    // third flag reading that same pair, so a stale one would make the benchmark
    // table open its own dialog for this asset as a side effect of the hand-off.
    void this.router.navigate([], {
      queryParams: {
        assetProfileDialog: true,
        benchmarkDetailDialog: null,
        dataSource: this.SymbolProfile?.dataSource,
        dialogModule: DashboardModuleType.ADMIN_MARKET_DATA,
        holdingDetailDialog: null,
        symbol: this.SymbolProfile?.symbol
      },
      queryParamsHandling: 'merge'
    });

    // Reported as a hand-off rather than closed silently. The shell's own cleanup
    // clears `dataSource` and `symbol` along with `holdingDetailDialog`, and those
    // two are exactly what the navigation above is handing on - so without this the
    // administration module would be asked to open an asset profile dialog for no
    // asset at all.
    this.dialogRef.close({ hasHandedOverAssetProfile: true });
  }

  public onUpdateActivity(aActivity: Activity) {
    this.dashboardIntentService
      .getRevealModuleSubject()
      .next(DashboardModuleType.ACTIVITIES);

    void this.router.navigate([], {
      queryParams: {
        activityId: aActivity.id,
        dataSource: null,
        dialogModule: DashboardModuleType.ACTIVITIES,
        editDialog: true,
        holdingDetailDialog: null,
        symbol: null
      },
      queryParamsHandling: 'merge'
    });

    this.dialogRef.close();
  }

  private fetchMarketData() {
    this.dataService
      .fetchMarketDataBySymbol({
        dataSource: this.data.dataSource,
        symbol: this.data.symbol
      })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(({ marketData }) => {
        this.marketDataItems = marketData;

        this.historicalDataItems = this.marketDataItems.map(
          ({ date, marketPrice }) => {
            return {
              date: format(date, DATE_FORMAT),
              value: marketPrice
            };
          }
        );

        this.changeDetectorRef.markForCheck();
      });
  }
}
