import { GfAppQueryParams } from '@ghostfolio/client/interfaces/interfaces';
import { UNKNOWN_KEY } from '@ghostfolio/common/config';
import {
  prettifySymbol,
  reportSanitizedError
} from '@ghostfolio/common/helper';
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
import { ActivatedRoute, Router } from '@angular/router';
import { AssetClass } from '@prisma/client';
import { isUUID } from 'class-validator';
import { isNumber } from 'lodash';
import { DeviceDetectorService } from 'ngx-device-detector';
import { EMPTY } from 'rxjs';
import {
  catchError,
  distinctUntilChanged,
  map,
  switchMap
} from 'rxjs/operators';

/**
 * Read-only presentation of a portfolio shared through a public access link.
 *
 * This is the relocated leaf of the former public page. It no longer owns a
 * route of its own: the shared link is resolved from the `accessId` query
 * parameter of the single root route (`/<languageCode>/?accessId=<id>`) instead
 * of the retired `/<languageCode>/p/<id>` route parameter. Permission
 * evaluation, geographic/sector derivation and the table/chart contracts
 * consumed by the template are carried over unchanged.
 *
 * Two things necessarily differ, both because a query parameter is not a route
 * parameter. The read is driven by the parameter stream rather than taken once,
 * because the identifier can change while this component stays mounted; and a
 * failed read is reported in place rather than redirected away from, because the
 * route it used to redirect to is the one now hosting this component.
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
  /**
   * Whether the shared link could not be resolved, either because the
   * identifier is not a well-formed access identifier or because the server did
   * not recognise it. Rendered as an explicit notice by the template, which is
   * the whole point: the former page navigated away on a failed read, and on a
   * single-canvas shell there is nowhere to navigate to, so a visitor following
   * a stale link would otherwise be shown a portfolio-shaped surface with
   * nothing in it and no explanation.
   */
  protected hasError = false;

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
  private readonly router = inject(Router);

  public constructor() {
    this.info = this.dataService.fetchInfo();

    this.hasPermissionForSubscription = hasPermission(
      this.info?.globalPermissions,
      permissions.enableSubscription
    );
  }

  public ngOnInit() {
    // The identifier arrives as a query parameter of the root route rather than
    // as a route parameter, so the read has to be driven by the parameter stream
    // instead of taken once. That route is shared with every other co-mounted
    // feature, so its parameters change for reasons that have nothing to do with
    // a shared portfolio: `distinctUntilChanged` reduces those to the changes of
    // the identifier itself, and `switchMap` abandons an in-flight read for a
    // newer identifier so a slow response can never overwrite the portfolio the
    // URL now names.
    this.activatedRoute.queryParams
      .pipe(
        map((queryParams: GfAppQueryParams) => queryParams.accessId),
        distinctUntilChanged(),
        switchMap((accessId) => {
          // Nothing of the previous portfolio survives the switch. Whatever
          // happens next - a different portfolio, a rejection, or a malformed
          // identifier - it must not be read against data belonging to another
          // link.
          this.resetPortfolio();

          if (!accessId) {
            // Defensive only: the canvas mounts this component exclusively
            // while an identifier is present. With nothing to resolve there is
            // nothing to report either.
            this.changeDetectorRef.markForCheck();

            return EMPTY;
          }

          // Only a well-formed access identifier is worth asking about. The
          // value is visitor-supplied and ends up in a path segment, so it is
          // checked against the shape the server actually issues - `Access.id`
          // is a generated UUID - before any request is made. Anything else is
          // reported to the visitor rather than sent.
          if (!isUUID(accessId)) {
            this.hasError = true;

            this.changeDetectorRef.markForCheck();

            return EMPTY;
          }

          return this.dataService.fetchPublicPortfolio(accessId).pipe(
            catchError((error: HttpErrorResponse) => {
              // Reported to the visitor instead of navigated away from. The
              // former page redirected to the root on a failed read, which this
              // component is already hosted by, so the redirect would be a
              // no-op at best and re-entrant at worst.
              reportSanitizedError('GF-PUBLIC-PORTFOLIO-FETCH-FAILED', error);

              this.hasError = true;

              this.changeDetectorRef.markForCheck();

              return EMPTY;
            })
          );
        }),
        takeUntilDestroyed(this.destroyRef)
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

  /**
   * Drops the unusable identifier out of the URL.
   *
   * The other half of what a failed link needs. Reporting the failure explains
   * it, but the identifier is what keeps this component mounted in the first
   * place, so while it is there the visitor has nowhere to go: the shell used to
   * redirect them to the root, and the root is now here. Removing just that one
   * parameter hands them back to whichever surface the shell would normally show
   * them, without assuming a locale or naming a screen.
   */
  protected onDismissError() {
    void this.router.navigate([], {
      queryParams: { accessId: null },
      queryParamsHandling: 'merge',
      relativeTo: this.activatedRoute
    });
  }

  /**
   * Discards everything belonging to the previously resolved link.
   *
   * Called before every read, so neither a rejection nor a slower reply for a
   * superseded identifier can leave one portfolio's figures on screen under
   * another portfolio's link. Clearing the response itself is what does the
   * work: every derived collection is rebuilt from it by
   * {@link initializeAnalysisData}, and the template reads them only once a
   * response exists.
   */
  private resetPortfolio() {
    this.hasError = false;
    this.latestActivitiesDataSource = undefined;
    this.publicPortfolioDetails = undefined;
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
