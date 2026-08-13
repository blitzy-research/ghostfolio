import { NUMERICAL_PRECISION_THRESHOLD_6_FIGURES } from '@ghostfolio/common/config';
import { getDateFnsLocale, getLocale } from '@ghostfolio/common/helper';
import type { PortfolioSummary, User } from '@ghostfolio/common/interfaces';
import { translate } from '@ghostfolio/ui/i18n';
import { NotificationService } from '@ghostfolio/ui/notifications';
import { GfValueComponent } from '@ghostfolio/ui/value';

import { CommonModule } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  EventEmitter,
  Input,
  OnChanges,
  Output
} from '@angular/core';
import { MatTooltipModule } from '@angular/material/tooltip';
import { IonIcon } from '@ionic/angular/standalone';
import { formatDistanceToNow } from 'date-fns';
import { addIcons } from 'ionicons';
import {
  ellipsisHorizontalCircleOutline,
  informationCircleOutline
} from 'ionicons/icons';
import { isNumber } from 'lodash';

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, GfValueComponent, IonIcon, MatTooltipModule],
  selector: 'gf-portfolio-summary',
  styleUrls: ['./portfolio-summary.component.scss'],
  templateUrl: './portfolio-summary.component.html'
})
export class GfPortfolioSummaryComponent implements OnChanges {
  @Input() baseCurrency: string;
  @Input() deviceType: string;
  @Input() hasImpersonationId: boolean;
  @Input() hasPermissionToUpdateUserSettings: boolean;
  @Input() isLoading: boolean;
  @Input() language: string;
  @Input() locale = getLocale();
  @Input() summary: PortfolioSummary;
  @Input() user: User;

  @Output() emergencyFundChanged = new EventEmitter<number>();

  public buyAndSellActivitiesTooltip = translate(
    'BUY_AND_SELL_ACTIVITIES_TOOLTIP'
  );

  /** The activity count as text, grouped for {@link locale}. */
  public formattedActivityCount = '';

  public precision = 2;
  public timeInMarket: string;

  public get buyingPowerPercentage() {
    return this.summary?.totalValueInBaseCurrency
      ? this.summary.cash / this.summary.totalValueInBaseCurrency
      : 0;
  }

  public get emergencyFundPercentage() {
    return this.summary?.totalValueInBaseCurrency
      ? (this.summary.emergencyFund?.total || 0) /
          this.summary.totalValueInBaseCurrency
      : 0;
  }

  public get excludedFromAnalysisPercentage() {
    return this.summary?.totalValueInBaseCurrency
      ? this.summary.excludedAccountsAndActivities /
          this.summary.totalValueInBaseCurrency
      : 0;
  }

  public constructor(private notificationService: NotificationService) {
    addIcons({ ellipsisHorizontalCircleOutline, informationCircleOutline });
  }

  public ngOnChanges() {
    if (this.summary) {
      // Derived on every change rather than lowered once. The condition is a property
      // of the figures currently on screen, and those change without this component
      // being rebuilt: on a single canvas the module outlives every filter, date range
      // and impersonation switch that re-feeds it. Assigning only in the narrowing
      // direction latched the reduced precision for the rest of the session, so a total
      // that had briefly crossed the threshold left every currency row on this screen
      // without its decimal places - permanently, and for figures nowhere near the
      // threshold that had caused it.
      this.precision =
        this.deviceType === 'mobile' &&
        this.summary.totalValueInBaseCurrency >=
          NUMERICAL_PRECISION_THRESHOLD_6_FIGURES
          ? 0
          : 2;

      // Grouped for the viewer's locale, as every other figure on this screen is. It
      // was the one number here rendered straight from the model, so a five-figure
      // count appeared as an unbroken run of digits beside neighbours that were
      // separated - and in a locale that groups differently, wrongly.
      this.formattedActivityCount = isNumber(this.summary.activityCount)
        ? this.summary.activityCount.toLocaleString(this.locale)
        : '';

      if (this.summary.dateOfFirstActivity) {
        this.timeInMarket = formatDistanceToNow(
          this.summary.dateOfFirstActivity,
          {
            locale: getDateFnsLocale(this.language)
          }
        );
      } else {
        this.timeInMarket = '-';
      }
    } else {
      this.formattedActivityCount = '';
      this.precision = 2;
      this.timeInMarket = undefined;
    }
  }

  public onEditEmergencyFund() {
    this.notificationService.prompt({
      confirmFn: (value) => {
        const emergencyFund = parseFloat(value.trim()) || 0;

        this.emergencyFundChanged.emit(emergencyFund);
      },
      confirmLabel: $localize`Save`,
      defaultValue: this.summary.emergencyFund?.total?.toString() ?? '0',
      title: $localize`Please set the amount of your emergency fund.`,
      valueLabel: $localize`Emergency fund`
    });
  }
}
