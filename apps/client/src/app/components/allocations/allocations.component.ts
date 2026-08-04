import { GfAccountDetailDialogComponent } from '@ghostfolio/client/components/account-detail-dialog/account-detail-dialog.component';
import {
  AccountDetailDialogParams,
  AccountDetailDialogResult
} from '@ghostfolio/client/components/account-detail-dialog/interfaces/interfaces';
import type { GfAppQueryParams } from '@ghostfolio/client/interfaces/interfaces';
import { ImpersonationStorageService } from '@ghostfolio/client/services/impersonation-storage.service';
import { UserService } from '@ghostfolio/client/services/user/user.service';
import { MAX_TOP_HOLDINGS, UNKNOWN_KEY } from '@ghostfolio/common/config';
import { DashboardModuleType } from '@ghostfolio/common/dashboard';
import { prettifySymbol } from '@ghostfolio/common/helper';
import {
  AssetProfileIdentifier,
  HoldingWithParents,
  PortfolioDetails,
  PortfolioPosition,
  User
} from '@ghostfolio/common/interfaces';
import { hasPermission, permissions } from '@ghostfolio/common/permissions';
import { Market, MarketAdvanced } from '@ghostfolio/common/types';
import { translate } from '@ghostfolio/ui/i18n';
import { GfPortfolioProportionChartComponent } from '@ghostfolio/ui/portfolio-proportion-chart';
import { GfPremiumIndicatorComponent } from '@ghostfolio/ui/premium-indicator';
import { DataService } from '@ghostfolio/ui/services';
import { GfTopHoldingsComponent } from '@ghostfolio/ui/top-holdings';
import { GfValueComponent } from '@ghostfolio/ui/value';
import { GfWorldMapChartComponent } from '@ghostfolio/ui/world-map-chart';

import { NgClass } from '@angular/common';
import {
  ChangeDetectorRef,
  Component,
  DestroyRef,
  OnInit
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { MatCardModule } from '@angular/material/card';
import { MatDialog } from '@angular/material/dialog';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { ActivatedRoute, Router } from '@angular/router';
import {
  Account,
  AssetClass,
  AssetSubClass,
  DataSource,
  Platform
} from '@prisma/client';
import { isNumber } from 'lodash';
import { DeviceDetectorService } from 'ngx-device-detector';

@Component({
  imports: [
    GfPortfolioProportionChartComponent,
    GfPremiumIndicatorComponent,
    GfTopHoldingsComponent,
    GfValueComponent,
    GfWorldMapChartComponent,
    MatCardModule,
    MatProgressBarModule,
    NgClass
  ],
  selector: 'gf-allocations',
  styleUrls: ['./allocations.scss'],
  templateUrl: './allocations.html'
})
export class GfAllocationsComponent implements OnInit {
  public accounts: {
    [id: string]: Pick<Account, 'name'> & {
      id: string;
      value: number;
    };
  };
  public continents: {
    [code: string]: { name: string; value: number };
  };
  public countries: {
    [code: string]: { name: string; value: number };
  };
  public deviceType: string;
  public hasImpersonationId: boolean;
  public holdings: {
    [symbol: string]: Pick<
      PortfolioPosition,
      | 'assetClass'
      | 'assetClassLabel'
      | 'assetSubClass'
      | 'assetSubClassLabel'
      | 'currency'
      | 'exchange'
      | 'name'
    > & { etfProvider: string; value: number };
  };
  public isLoading = false;
  public markets: {
    [key in Market]: { id: Market; valueInPercentage: number };
  };
  public marketsAdvanced: {
    [key in MarketAdvanced]: {
      id: MarketAdvanced;
      name: string;
      value: number;
    };
  };
  public platforms: {
    [id: string]: Pick<Platform, 'name'> & {
      id: string;
      value: number;
    };
  };
  public portfolioDetails: PortfolioDetails;
  public sectors: {
    [name: string]: { name: string; value: number };
  };
  public symbols: {
    [name: string]: {
      dataSource?: DataSource;
      name: string;
      symbol: string;
      value: number;
    };
  };
  public topHoldings: HoldingWithParents[];
  public topHoldingsMap: {
    [name: string]: { name: string; value: number };
  };
  public totalValueInEtf = 0;
  public UNKNOWN_KEY = UNKNOWN_KEY;
  public user: User;
  public worldMapChartFormat: string;

  /**
   * The account whose detail dialog this module has already been asked for, or
   * `null` for none.
   *
   * Held because every producer merges rather than replaces its query parameters -
   * it has to, or it would drop a sibling module's and the shared-portfolio
   * identifier - so `route.queryParams` emits again whenever any *other* module
   * writes to the URL. Without this, each of those emissions would open a second
   * copy of a dialog that is already up. Reset by the parameters ceasing to ask for
   * it rather than by the dialog closing - see {@link serveDialogRequest}.
   */
  private openedAccountId: string = null;

  /**
   * The query parameters as they stand, held rather than consumed on arrival.
   *
   * The dialog this module opens is sized from `deviceType` and permitted from
   * `user`, and both resolve in `ngOnInit` - after the constructor. That ordering
   * only matters on one canvas, where a module is materialised lazily *in response
   * to* a request already on the URL, so the parameters arrive before the module
   * can honour them properly.
   */
  private queryParams: GfAppQueryParams;

  public constructor(
    private changeDetectorRef: ChangeDetectorRef,
    private dataService: DataService,
    private destroyRef: DestroyRef,
    private deviceService: DeviceDetectorService,
    private dialog: MatDialog,
    private impersonationStorageService: ImpersonationStorageService,
    private route: ActivatedRoute,
    private router: Router,
    private userService: UserService
  ) {
    this.route.queryParams
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((queryParams: GfAppQueryParams) => {
        this.queryParams = queryParams;

        this.applyQueryParams();
      });
  }

  public ngOnInit() {
    this.deviceType = this.deviceService.getDeviceInfo().deviceType;

    this.impersonationStorageService
      .onChangeHasImpersonation()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((impersonationId) => {
        this.hasImpersonationId = !!impersonationId;

        this.applyQueryParams();
      });

    this.userService.stateChanged
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((state) => {
        if (state?.user) {
          this.user = state.user;

          this.worldMapChartFormat = this.showValuesInPercentage()
            ? `{0}%`
            : `{0} ${this.user?.settings?.baseCurrency}`;

          this.isLoading = true;

          this.initialize();

          this.fetchPortfolioDetails()
            .pipe(takeUntilDestroyed(this.destroyRef))
            .subscribe((portfolioDetails) => {
              this.initialize();

              this.portfolioDetails = portfolioDetails;

              this.initializeAllocationsData();

              this.isLoading = false;

              this.changeDetectorRef.markForCheck();
            });

          this.changeDetectorRef.markForCheck();

          this.applyQueryParams();
        }
      });

    this.initialize();

    this.applyQueryParams();
  }

  public onAccountChartClicked({ symbol }: AssetProfileIdentifier) {
    if (symbol && symbol !== UNKNOWN_KEY) {
      // Names this module, so the dialog opens here and not also in the accounts
      // module, which hosts the same dialog and would otherwise answer too.
      void this.router.navigate([], {
        queryParams: {
          accountDetailDialog: true,
          accountId: symbol,
          dialogModule: DashboardModuleType.ALLOCATIONS
        },
        queryParamsHandling: 'merge',
        relativeTo: this.route
      });
    }
  }

  public onSymbolChartClicked({ dataSource, symbol }: AssetProfileIdentifier) {
    if (dataSource && symbol) {
      // Deliberately unqualified: the holding detail dialog is owned by the
      // application shell rather than by any module, so its parameters name
      // themselves and there is only ever one consumer.
      //
      // Two nulls are still required, because merging obliges a producer to null
      // what it takes over. `dataSource` and `symbol` are shared identifiers read by
      // three different flags, the other two belonging to the market data
      // administration module and to the benchmark table, so leaving either up would
      // re-point *their* dialog at this holding rather than merely leaving it alone.
      void this.router.navigate([], {
        queryParams: {
          dataSource,
          symbol,
          assetProfileDialog: null,
          benchmarkDetailDialog: null,
          holdingDetailDialog: true
        },
        queryParamsHandling: 'merge',
        relativeTo: this.route
      });
    }
  }

  private extractEtfProvider({
    assetSubClass,
    name
  }: {
    assetSubClass: PortfolioPosition['assetSubClass'];
    name: string;
  }) {
    if (assetSubClass === 'ETF') {
      const [firstWord] = name.split(' ');
      return firstWord;
    }

    return UNKNOWN_KEY;
  }

  private fetchPortfolioDetails() {
    return this.dataService.fetchPortfolioDetails({
      filters: this.userService.getFilters(),
      withMarkets: true
    });
  }

  private initialize() {
    this.accounts = {};
    this.continents = {
      [UNKNOWN_KEY]: {
        name: UNKNOWN_KEY,
        value: 0
      }
    };
    this.countries = {
      [UNKNOWN_KEY]: {
        name: UNKNOWN_KEY,
        value: 0
      }
    };
    this.holdings = {};
    this.marketsAdvanced = {
      [UNKNOWN_KEY]: {
        id: UNKNOWN_KEY,
        name: UNKNOWN_KEY,
        value: 0
      },
      asiaPacific: {
        id: 'asiaPacific',
        name: translate('Asia-Pacific'),
        value: 0
      },
      emergingMarkets: {
        id: 'emergingMarkets',
        name: translate('Emerging Markets'),
        value: 0
      },
      europe: {
        id: 'europe',
        name: translate('Europe'),
        value: 0
      },
      japan: {
        id: 'japan',
        name: translate('Japan'),
        value: 0
      },
      northAmerica: {
        id: 'northAmerica',
        name: translate('North America'),
        value: 0
      },
      otherMarkets: {
        id: 'otherMarkets',
        name: translate('Other Markets'),
        value: 0
      }
    };
    this.platforms = {};
    this.portfolioDetails = {
      accounts: {},
      createdAt: undefined,
      holdings: {},
      platforms: {},
      summary: undefined
    };
    this.sectors = {
      [UNKNOWN_KEY]: {
        name: UNKNOWN_KEY,
        value: 0
      }
    };
    this.symbols = {
      [UNKNOWN_KEY]: {
        name: UNKNOWN_KEY,
        symbol: UNKNOWN_KEY,
        value: 0
      }
    };
    this.topHoldingsMap = {};
  }

  private initializeAllocationsData() {
    for (const [
      id,
      { name, valueInBaseCurrency, valueInPercentage }
    ] of Object.entries(this.portfolioDetails.accounts)) {
      let value = 0;

      if (this.showValuesInPercentage()) {
        value = valueInPercentage;
      } else {
        value = valueInBaseCurrency;
      }

      this.accounts[id] = {
        id,
        name,
        value
      };
    }

    for (const [symbol, position] of Object.entries(
      this.portfolioDetails.holdings
    )) {
      let value = 0;

      if (this.showValuesInPercentage()) {
        value = position.allocationInPercentage;
      } else {
        value = position.valueInBaseCurrency;
      }

      this.holdings[symbol] = {
        value,
        assetClass: position.assetClass || (UNKNOWN_KEY as AssetClass),
        assetClassLabel: position.assetClassLabel || UNKNOWN_KEY,
        assetSubClass: position.assetSubClass || (UNKNOWN_KEY as AssetSubClass),
        assetSubClassLabel: position.assetSubClassLabel || UNKNOWN_KEY,
        currency: position.currency,
        etfProvider: this.extractEtfProvider({
          assetSubClass: position.assetSubClass,
          name: position.name
        }),
        exchange: position.exchange,
        name: position.name
      };

      if (position.assetClass !== AssetClass.LIQUIDITY) {
        if (position.countries.length > 0) {
          for (const country of position.countries) {
            const { code, continent, name, weight } = country;

            if (this.continents[continent]?.value) {
              this.continents[continent].value +=
                weight *
                (isNumber(position.valueInBaseCurrency)
                  ? position.valueInBaseCurrency
                  : position.valueInPercentage);
            } else {
              this.continents[continent] = {
                name: continent,
                value:
                  weight *
                  (isNumber(position.valueInBaseCurrency)
                    ? this.portfolioDetails.holdings[symbol].valueInBaseCurrency
                    : this.portfolioDetails.holdings[symbol].valueInPercentage)
              };
            }

            if (this.countries[code]?.value) {
              this.countries[code].value +=
                weight *
                (isNumber(position.valueInBaseCurrency)
                  ? position.valueInBaseCurrency
                  : position.valueInPercentage);
            } else {
              this.countries[code] = {
                name,
                value:
                  weight *
                  (isNumber(position.valueInBaseCurrency)
                    ? this.portfolioDetails.holdings[symbol].valueInBaseCurrency
                    : this.portfolioDetails.holdings[symbol].valueInPercentage)
              };
            }
          }
        } else {
          this.continents[UNKNOWN_KEY].value += isNumber(
            position.valueInBaseCurrency
          )
            ? this.portfolioDetails.holdings[symbol].valueInBaseCurrency
            : this.portfolioDetails.holdings[symbol].valueInPercentage;

          this.countries[UNKNOWN_KEY].value += isNumber(
            position.valueInBaseCurrency
          )
            ? this.portfolioDetails.holdings[symbol].valueInBaseCurrency
            : this.portfolioDetails.holdings[symbol].valueInPercentage;
        }

        if (position.holdings.length > 0) {
          for (const {
            allocationInPercentage,
            name,
            valueInBaseCurrency
          } of position.holdings) {
            const normalizedAssetName = this.normalizeAssetName(name);

            if (this.topHoldingsMap[normalizedAssetName]?.value) {
              this.topHoldingsMap[normalizedAssetName].value += isNumber(
                valueInBaseCurrency
              )
                ? valueInBaseCurrency
                : allocationInPercentage *
                  this.portfolioDetails.holdings[symbol].valueInPercentage;
            } else {
              this.topHoldingsMap[normalizedAssetName] = {
                name,
                value: isNumber(valueInBaseCurrency)
                  ? valueInBaseCurrency
                  : allocationInPercentage *
                    this.portfolioDetails.holdings[symbol].valueInPercentage
              };
            }
          }
        }

        if (position.sectors.length > 0) {
          for (const sector of position.sectors) {
            const { name, weight } = sector;

            if (this.sectors[name]?.value) {
              this.sectors[name].value +=
                weight *
                (isNumber(position.valueInBaseCurrency)
                  ? position.valueInBaseCurrency
                  : position.valueInPercentage);
            } else {
              this.sectors[name] = {
                name,
                value:
                  weight *
                  (isNumber(position.valueInBaseCurrency)
                    ? this.portfolioDetails.holdings[symbol].valueInBaseCurrency
                    : this.portfolioDetails.holdings[symbol].valueInPercentage)
              };
            }
          }
        } else {
          this.sectors[UNKNOWN_KEY].value += isNumber(
            position.valueInBaseCurrency
          )
            ? this.portfolioDetails.holdings[symbol].valueInBaseCurrency
            : this.portfolioDetails.holdings[symbol].valueInPercentage;
        }
      }

      if (this.holdings[symbol].assetSubClass === 'ETF') {
        this.totalValueInEtf += this.holdings[symbol].value;
      }

      this.symbols[prettifySymbol(symbol)] = {
        dataSource: position.dataSource,
        name: position.name,
        symbol: prettifySymbol(symbol),
        value: isNumber(position.valueInBaseCurrency)
          ? position.valueInBaseCurrency
          : position.valueInPercentage
      };
    }

    this.markets = this.portfolioDetails.markets;

    Object.values(this.portfolioDetails.marketsAdvanced).forEach(
      ({ id, valueInBaseCurrency, valueInPercentage }) => {
        this.marketsAdvanced[id].value = isNumber(valueInBaseCurrency)
          ? valueInBaseCurrency
          : valueInPercentage;
      }
    );

    for (const [
      id,
      { name, valueInBaseCurrency, valueInPercentage }
    ] of Object.entries(this.portfolioDetails.platforms)) {
      let value = 0;

      if (this.showValuesInPercentage()) {
        value = valueInPercentage;
      } else {
        value = valueInBaseCurrency;
      }

      this.platforms[id] = {
        id,
        name,
        value
      };
    }

    this.topHoldings = Object.values(this.topHoldingsMap)
      .map(({ name, value }) => {
        if (this.showValuesInPercentage()) {
          return {
            name,
            allocationInPercentage: value,
            valueInBaseCurrency: null
          };
        }

        return {
          name,
          allocationInPercentage:
            this.totalValueInEtf > 0 ? value / this.totalValueInEtf : 0,
          parents: Object.entries(this.portfolioDetails.holdings)
            .map(([symbol, holding]) => {
              if (holding.holdings.length > 0) {
                const currentParentHolding = holding.holdings.find(
                  (parentHolding) => {
                    return (
                      this.normalizeAssetName(parentHolding.name) ===
                      this.normalizeAssetName(name)
                    );
                  }
                );

                return currentParentHolding
                  ? {
                      allocationInPercentage:
                        currentParentHolding.valueInBaseCurrency / value,
                      name: holding.name,
                      position: holding,
                      symbol: prettifySymbol(symbol),
                      valueInBaseCurrency:
                        currentParentHolding.valueInBaseCurrency
                    }
                  : null;
              }

              return null;
            })
            .filter((item) => {
              return item !== null;
            })
            .sort((a, b) => {
              return b.allocationInPercentage - a.allocationInPercentage;
            }),
          valueInBaseCurrency: value
        };
      })
      .sort((a, b) => {
        return b.allocationInPercentage - a.allocationInPercentage;
      });

    if (this.topHoldings.length > MAX_TOP_HOLDINGS) {
      this.topHoldings = this.topHoldings.slice(0, MAX_TOP_HOLDINGS);
    }
  }

  private normalizeAssetName(name: string) {
    if (!name) {
      return '';
    }

    return name.trim().toLowerCase();
  }

  private openAccountDetailDialog(aAccountId: string) {
    const dialogRef = this.dialog.open<
      GfAccountDetailDialogComponent,
      AccountDetailDialogParams,
      AccountDetailDialogResult | undefined
    >(GfAccountDetailDialogComponent, {
      autoFocus: false,
      data: {
        accountId: aAccountId,
        deviceType: this.deviceType,
        hasImpersonationId: this.hasImpersonationId,
        hasPermissionToCreateActivity:
          !this.hasImpersonationId &&
          hasPermission(this.user?.permissions, permissions.createActivity) &&
          !this.user?.settings?.isRestrictedView
      },
      height: this.deviceType === 'mobile' ? '98vh' : '80vh',
      width: this.deviceType === 'mobile' ? '100vw' : '50rem'
    });

    dialogRef
      .afterClosed()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((result) => {
        // A dialog that closed itself in order to open another module's has already
        // written that request onto the URL, and it wrote it onto parameters this
        // clear would remove - `dialogModule` among them. Clearing anyway would
        // strip the request back off again, and a lazily loaded activities module,
        // which subscribes after this runs, would find nothing addressed to it. The
        // hand-off already cleared the keys that identify this dialog.
        if (result?.hasHandedOver) {
          return;
        }

        this.clearDialogQueryParams();
      });
  }

  /**
   * Opens this module's account detail dialog if the current parameters ask for it,
   * once it is in a position to open it properly.
   *
   * Reached from four places - a parameter change, the device becoming known, the
   * viewer resolving and the impersonation state settling - because any of them can
   * be the last to arrive, which makes idempotence a requirement rather than a
   * nicety.
   */
  private applyQueryParams() {
    if (!this.deviceType || !this.user) {
      return;
    }

    const { accountDetailDialog, accountId, dialogModule } =
      this.queryParams ?? {};

    // This module hosts its own copy of the account detail dialog, and so
    // does the accounts module. On the single-canvas shell both observe the
    // same query parameters, so honouring a bare `accountDetailDialog`
    // opened the dialog twice over whenever both modules were placed.
    //
    // The accounts module is the default owner - the accounts table and the
    // assistant both produce this flag unqualified, and both belong to it -
    // so this module answers only when the request names it. Its own
    // producer, `onAccountChartClicked`, is what names it.
    const isRequested =
      accountId &&
      accountDetailDialog &&
      dialogModule === DashboardModuleType.ALLOCATIONS;

    // Keyed on the request the URL is making rather than on the dialog's own
    // lifecycle, so that a request already served is not served again and a request
    // withdrawn is forgotten. Resetting the record when the dialog closed instead
    // was not equivalent: the close handler removes the parameters through a
    // navigation, and until that navigation is applied the parameters still ask for
    // the dialog that has just been dismissed.
    this.serveDialogRequest(isRequested ? accountId : null, () => {
      this.openAccountDetailDialog(accountId);
    });
  }

  /**
   * Opens the account detail dialog unless the same request has already been served.
   *
   * The account is what the request is keyed on rather than a plain flag, so that
   * being asked for a *different* account while one is open is honoured as the
   * genuine second request it is.
   */
  private serveDialogRequest(aAccountId: string, aOpen: () => void) {
    if (this.openedAccountId === aAccountId) {
      return;
    }

    this.openedAccountId = aAccountId;

    if (aAccountId) {
      aOpen();
    }
  }

  /**
   * Removes the query parameters this module's dialog travels on, and only
   * those.
   *
   * The empty command array keeps the request on the current URL - the
   * workspace's route-agnostic convention - and merging is what makes the clear
   * safe on a single canvas. The reset this replaced named a route segment
   * instead, which dropped every query parameter on the canvas: closing this
   * module's dialog also closed a sibling module's, and discarded the
   * shared-portfolio access identifier along with it.
   */
  private clearDialogQueryParams() {
    void this.router.navigate([], {
      queryParams: {
        accountDetailDialog: null,
        accountId: null,
        dialogModule: null
      },
      queryParamsHandling: 'merge',
      relativeTo: this.route
    });
  }

  public showValuesInPercentage() {
    return this.hasImpersonationId || this.user?.settings?.isRestrictedView;
  }
}
