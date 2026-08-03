import { UNKNOWN_KEY } from '@ghostfolio/common/config';
import { prettifySymbol } from '@ghostfolio/common/helper';
import {
  InfoItem,
  PortfolioPosition,
  PublicPortfolioResponse
} from '@ghostfolio/common/interfaces';
import { hasPermission, permissions } from '@ghostfolio/common/permissions';
import { Market } from '@ghostfolio/common/types';
import { GfActivitiesTableComponent } from '@ghostfolio/ui/activities-table/activities-table.component';
import { GfHoldingsTableComponent } from '@ghostfolio/ui/holdings-table/holdings-table.component';
import { GfPortfolioProportionChartComponent } from '@ghostfolio/ui/portfolio-proportion-chart/portfolio-proportion-chart.component';
import { DataService } from '@ghostfolio/ui/services';
import { GfValueComponent } from '@ghostfolio/ui/value';
import { GfWorldMapChartComponent } from '@ghostfolio/ui/world-map-chart';

import { CommonModule } from '@angular/common';
import { HttpErrorResponse } from '@angular/common/http';
import {
  ChangeDetectorRef,
  Component,
  computed,
  CUSTOM_ELEMENTS_SCHEMA,
  DestroyRef,
  inject,
  OnInit
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatTableDataSource } from '@angular/material/table';
import { ActivatedRoute } from '@angular/router';
import { AssetClass } from '@prisma/client';
import { StatusCodes } from 'http-status-codes';
import { isNumber } from 'lodash';
import { DeviceDetectorService } from 'ngx-device-detector';
import { EMPTY } from 'rxjs';
import { catchError, distinctUntilChanged, filter, map } from 'rxjs/operators';

/**
 * Read-only presentation of a portfolio that has been shared through a public
 * access link.
 *
 * This is the relocated leaf of the former public page. It no longer owns a
 * route of its own: the shared link is resolved from the `accessId` query
 * parameter of the single root route (`/<languageCode>/?accessId=<id>`) instead
 * of the retired `/<languageCode>/p/<id>` route parameter. Everything else —
 * data fetching, permission evaluation, geographic/sector derivation and the
 * table/chart contracts consumed by the template — is carried over unchanged.
 */
@Component({
  imports: [
    CommonModule,
    GfActivitiesTableComponent,
    GfHoldingsTableComponent,
    GfPortfolioProportionChartComponent,
    GfValueComponent,
    GfWorldMapChartComponent,
    MatButtonModule,
    MatCardModule
  ],
  schemas: [CUSTOM_ELEMENTS_SCHEMA],
  selector: 'gf-public-portfolio',
  styleUrls: ['./public-portfolio.scss'],
  templateUrl: './public-portfolio.html'
})
export class GfPublicPortfolioComponent implements OnInit {
  protected continents: {
    [code: string]: { name: string; value: number };
  };
  protected countries: {
    [code: string]: { name: string; value: number };
  };
  protected readonly defaultAlias = $localize`someone`;
  protected readonly deviceType = computed(
    () => this.deviceDetectorService.deviceInfo().deviceType
  );
  protected hasPermissionForSubscription: boolean;
  protected holdings: PublicPortfolioResponse['holdings'][string][];
  protected info: InfoItem;
  protected latestActivitiesDataSource: MatTableDataSource<
    PublicPortfolioResponse['latestActivities'][0]
  >;
  protected markets: {
    [key in Market]: { id: Market; valueInPercentage: number };
  };
  protected readonly pageSize = Number.MAX_SAFE_INTEGER;
  protected positions: {
    [symbol: string]: Pick<PortfolioPosition, 'currency' | 'name'> & {
      value: number;
    };
  };
  protected publicPortfolioDetails: PublicPortfolioResponse;
  protected sectors: {
    [name: string]: { name: string; value: number };
  };
  protected symbols: {
    [name: string]: { name: string; symbol: string; value: number };
  };
  protected readonly UNKNOWN_KEY = UNKNOWN_KEY;

  private readonly activatedRoute = inject(ActivatedRoute);
  private readonly changeDetectorRef = inject(ChangeDetectorRef);
  private readonly dataService = inject(DataService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly deviceDetectorService = inject(DeviceDetectorService);

  private accessId: string;

  public constructor() {
    // The public access identifier arrives as a query parameter of the root
    // route. Since that route is shared with every other co-mounted feature,
    // its query parameters change for reasons that have nothing to do with a
    // shared portfolio: the stream is therefore narrowed to a defined value
    // (so an unrelated mutation can never clobber the captured identifier) and
    // deduplicated (so it is only reassigned when the identifier itself
    // actually changes).
    this.activatedRoute.queryParams
      .pipe(
        map((queryParams) => queryParams['accessId'] as string | undefined),
        filter((accessId): accessId is string => Boolean(accessId)),
        distinctUntilChanged(),
        takeUntilDestroyed(this.destroyRef)
      )
      .subscribe((accessId) => {
        this.accessId = accessId;
      });

    this.info = this.dataService.fetchInfo();

    this.hasPermissionForSubscription = hasPermission(
      this.info?.globalPermissions,
      permissions.enableSubscription
    );
  }

  public ngOnInit() {
    this.dataService
      .fetchPublicPortfolio(this.accessId)
      .pipe(
        takeUntilDestroyed(this.destroyRef),
        catchError((error: HttpErrorResponse) => {
          if (error.status === StatusCodes.NOT_FOUND) {
            // An unknown or revoked access identifier is reported and then
            // swallowed. No navigation is issued: this component is hosted by
            // the root route itself, so redirecting there would be a no-op at
            // best and re-entrant at worst.
            console.error(error);
          }

          return EMPTY;
        })
      )
      .subscribe((portfolioPublicDetails) => {
        this.publicPortfolioDetails = portfolioPublicDetails;

        this.initializeAnalysisData();

        this.latestActivitiesDataSource = new MatTableDataSource(
          this.publicPortfolioDetails.latestActivities
        );

        this.changeDetectorRef.markForCheck();
      });
  }

  private initializeAnalysisData() {
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
    this.holdings = [];
    this.markets = this.publicPortfolioDetails.markets;
    this.positions = {};
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

    for (const [symbol, position] of Object.entries(
      this.publicPortfolioDetails.holdings
    )) {
      this.holdings.push(position);

      this.positions[symbol] = {
        currency: position.currency,
        name: position.name,
        value: position.allocationInPercentage
      };

      if (position.assetClass !== AssetClass.LIQUIDITY) {
        // Prepare analysis data by continents, countries, holdings and sectors except for liquidity

        if (position.countries.length > 0) {
          for (const country of position.countries) {
            const { code, continent, name, weight } = country;

            if (this.continents[continent]?.value) {
              this.continents[continent].value +=
                weight * (position.valueInBaseCurrency ?? 0);
            } else {
              this.continents[continent] = {
                name: continent,
                value:
                  weight *
                  (this.publicPortfolioDetails.holdings[symbol]
                    .valueInBaseCurrency ?? 0)
              };
            }

            if (this.countries[code]?.value) {
              this.countries[code].value +=
                weight * (position.valueInBaseCurrency ?? 0);
            } else {
              this.countries[code] = {
                name,
                value:
                  weight *
                  (this.publicPortfolioDetails.holdings[symbol]
                    .valueInBaseCurrency ?? 0)
              };
            }
          }
        } else {
          this.continents[UNKNOWN_KEY].value +=
            this.publicPortfolioDetails.holdings[symbol].valueInBaseCurrency ??
            0;

          this.countries[UNKNOWN_KEY].value +=
            this.publicPortfolioDetails.holdings[symbol].valueInBaseCurrency ??
            0;
        }

        if (position.sectors.length > 0) {
          for (const sector of position.sectors) {
            const { name, weight } = sector;

            if (this.sectors[name]?.value) {
              this.sectors[name].value +=
                weight * (position.valueInBaseCurrency ?? 0);
            } else {
              this.sectors[name] = {
                name,
                value:
                  weight *
                  (this.publicPortfolioDetails.holdings[symbol]
                    .valueInBaseCurrency ?? 0)
              };
            }
          }
        } else {
          this.sectors[UNKNOWN_KEY].value +=
            this.publicPortfolioDetails.holdings[symbol].valueInBaseCurrency ??
            0;
        }
      }

      this.symbols[prettifySymbol(symbol)] = {
        name: position.name,
        symbol: prettifySymbol(symbol),
        value: isNumber(position.valueInBaseCurrency)
          ? position.valueInBaseCurrency
          : (position.valueInPercentage ?? 0)
      };
    }
  }
}
