import { GfRulesComponent } from '@ghostfolio/client/components/rules/rules.component';
import { ImpersonationStorageService } from '@ghostfolio/client/services/impersonation-storage.service';
import { UserService } from '@ghostfolio/client/services/user/user.service';
import { UpdateUserSettingDto } from '@ghostfolio/common/dtos';
import { SubscriptionType } from '@ghostfolio/common/enums';
import { reportSanitizedError } from '@ghostfolio/common/helper';
import {
  PortfolioReportResponse,
  PortfolioReportRule
} from '@ghostfolio/common/interfaces';
import { User } from '@ghostfolio/common/interfaces/user.interface';
import { hasPermission, permissions } from '@ghostfolio/common/permissions';
import { GfPremiumIndicatorComponent } from '@ghostfolio/ui/premium-indicator';
import { DataService } from '@ghostfolio/ui/services';

import { NgClass } from '@angular/common';
import { ChangeDetectorRef, Component, DestroyRef } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { MatButtonModule } from '@angular/material/button';
import { IonIcon } from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import {
  checkmarkCircleOutline,
  removeCircleOutline,
  warningOutline
} from 'ionicons/icons';
import { NgxSkeletonLoaderModule } from 'ngx-skeleton-loader';

/**
 * The stable event identifier a failed report read is reported under.
 *
 * Fixed so it stays searchable in a log that outlives the module, and carrying the
 * reason only - never the response - because the report describes the viewer's own
 * portfolio.
 */
const PORTFOLIO_REPORT_FETCH_FAILED_EVENT = 'GF-PORTFOLIO-REPORT-FETCH-FAILED';

@Component({
  imports: [
    GfPremiumIndicatorComponent,
    GfRulesComponent,
    IonIcon,
    MatButtonModule,
    NgClass,
    NgxSkeletonLoaderModule
  ],
  selector: 'gf-x-ray',
  styleUrl: './x-ray.scss',
  templateUrl: './x-ray.html'
})
export class GfXRayComponent {
  public categories: {
    key: string;
    name: string;
    rules: PortfolioReportRule[];
  }[];
  /**
   * Whether the report could not be read.
   *
   * The request had no failure handler, so a rejection left `isLoading` raised for
   * ever: the module showed its skeletons indefinitely, said nothing about why, and
   * offered no way to ask again. Recovering the endpoint did not help either -
   * nothing was watching it - so the only way out was to remove the module and add
   * it back.
   */
  public hasError = false;

  public hasImpersonationId: boolean;
  public hasPermissionToUpdateUserSettings: boolean;
  public inactiveRules: PortfolioReportRule[];
  public isLoading = false;
  public statistics: PortfolioReportResponse['xRay']['statistics'];
  public user: User;

  public constructor(
    private changeDetectorRef: ChangeDetectorRef,
    private dataService: DataService,
    private destroyRef: DestroyRef,
    private impersonationStorageService: ImpersonationStorageService,
    private userService: UserService
  ) {
    addIcons({ checkmarkCircleOutline, removeCircleOutline, warningOutline });
  }

  public ngOnInit() {
    this.impersonationStorageService
      .onChangeHasImpersonation()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((impersonationId) => {
        this.hasImpersonationId = !!impersonationId;
      });

    this.userService.stateChanged
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((state) => {
        if (state?.user) {
          this.user = state.user;

          this.hasPermissionToUpdateUserSettings =
            this.user.subscription?.type === SubscriptionType.Basic
              ? false
              : hasPermission(
                  this.user.permissions,
                  permissions.updateUserSettings
                );

          this.changeDetectorRef.markForCheck();
        }
      });

    this.initializePortfolioReport();
  }

  /**
   * Reads the report again.
   *
   * The read is already re-entrant - it is what a change of viewer triggers - so the
   * retry is the same call rather than a second implementation of it, and a viewer
   * whose report failed once can recover without removing the module.
   */
  public onRetry() {
    this.initializePortfolioReport();
  }

  public onRulesUpdated(event: UpdateUserSettingDto) {
    this.dataService
      .putUserSetting(event)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => {
        this.userService
          .get(true)
          .pipe(takeUntilDestroyed(this.destroyRef))
          .subscribe();

        this.initializePortfolioReport();
      });
  }

  private initializePortfolioReport() {
    this.hasError = false;
    this.isLoading = true;

    this.dataService
      .fetchPortfolioReport()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        error: (error: unknown) => {
          // Lowered on the failure path too, which is the whole of the fix: this
          // flag is what the skeletons are drawn from, so leaving it raised turned a
          // failed read into a module that appeared to still be working.
          this.hasError = true;
          this.isLoading = false;

          reportSanitizedError(PORTFOLIO_REPORT_FETCH_FAILED_EVENT, error);

          this.changeDetectorRef.markForCheck();
        },
        next: ({ xRay: { categories, statistics } }) => {
          this.categories = this.withoutInactiveRules(categories);
          this.inactiveRules = this.mergeInactiveRules(categories);
          this.statistics = statistics;

          this.isLoading = false;

          this.changeDetectorRef.markForCheck();
        }
      });
  }

  /**
   * The categories with their switched-off rules taken out.
   *
   * Every inactive rule is also collected into the Inactive group below, and the
   * categories were being handed over untouched - so a switched-off rule was drawn
   * twice, once under the category it belongs to and once under Inactive, and a
   * viewer counting their rules counted it twice. The report is the source of both
   * lists, so exactly one of them has to give the rule up, and it is this one: the
   * Inactive group exists precisely to be where a switched-off rule lives.
   *
   * A new array per category rather than a splice, because the response object is
   * shared with `mergeInactiveRules` below and mutating it would empty the very
   * list that one reads.
   */
  private withoutInactiveRules(
    categories: PortfolioReportResponse['xRay']['categories']
  ): PortfolioReportResponse['xRay']['categories'] {
    return categories.map((category) => {
      return {
        ...category,
        rules:
          category.rules?.filter(({ isActive }) => {
            return isActive;
          }) ?? []
      };
    });
  }

  private mergeInactiveRules(
    categories: PortfolioReportResponse['xRay']['categories']
  ): PortfolioReportRule[] {
    return categories.flatMap(({ rules }) => {
      return (
        rules?.filter(({ isActive }) => {
          return !isActive;
        }) ?? []
      );
    });
  }
}
