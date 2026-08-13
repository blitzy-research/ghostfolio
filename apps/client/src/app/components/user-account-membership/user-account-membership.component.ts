import { UserService } from '@ghostfolio/client/services/user/user.service';
import { ConfirmationDialogType } from '@ghostfolio/common/enums';
import { getDateFormatString } from '@ghostfolio/common/helper';
import { User } from '@ghostfolio/common/interfaces';
import { hasPermission, permissions } from '@ghostfolio/common/permissions';
import { publicRoutes } from '@ghostfolio/common/routes/routes';
import { GfMembershipCardComponent } from '@ghostfolio/ui/membership-card';
import { NotificationService } from '@ghostfolio/ui/notifications';
import { GfPremiumIndicatorComponent } from '@ghostfolio/ui/premium-indicator';
import { DataService } from '@ghostfolio/ui/services';

import { CommonModule } from '@angular/common';
import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  DestroyRef
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatSnackBar } from '@angular/material/snack-bar';
import ms, { StringValue } from 'ms';
import { EMPTY } from 'rxjs';
import { catchError } from 'rxjs/operators';

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    CommonModule,
    GfMembershipCardComponent,
    GfPremiumIndicatorComponent,
    MatButtonModule,
    MatCardModule
  ],
  selector: 'gf-user-account-membership',
  styleUrls: ['./user-account-membership.scss'],
  templateUrl: './user-account-membership.html'
})
export class GfUserAccountMembershipComponent {
  public baseCurrency: string;
  public coupon: number;
  public couponId: string;
  public defaultDateFormat: string;
  public durationExtension: StringValue;
  public hasPermissionForSubscription: boolean;
  public hasPermissionToCreateApiKey: boolean;
  public hasPermissionToUpdateUserSettings: boolean;
  public price: number;
  public priceId: string;
  /**
   * The plan page on the hosted deployment, as an absolute URL.
   *
   * Its predecessor was `publicRoutes.pricing.routerLink`, and that route no
   * longer exists here - the public marketing surface is gone - so a router
   * target would resolve through the wildcard to the canvas. The page itself is
   * still published, so the link is retargeted rather than dropped, exactly as
   * the sibling admin settings component already does for the same page.
   *
   * The route *constant* is still consulted deliberately:
   * `publicRoutes.pricing.path` is a `$localize`-tagged per-locale segment, so
   * writing "pricing" literally here would break twelve translations. The member
   * is not bound by this component's own template - upstream's `routerLinkPricing`
   * was not either, because the pricing affordances on this panel belong to the
   * nested membership card and premium indicator, each of which computes its own
   * link - and it is kept so that the value any future binding reads is the
   * external one.
   */
  public pricingUrl: string;
  public trySubscriptionMail =
    'mailto:hi@ghostfol.io?Subject=Ghostfolio Premium Trial&body=Hello%0D%0DI am interested in Ghostfolio Premium. Can you please send me a coupon code to try it for some time?%0D%0DKind regards';
  public user: User;

  public constructor(
    private changeDetectorRef: ChangeDetectorRef,
    private dataService: DataService,
    private destroyRef: DestroyRef,
    private notificationService: NotificationService,
    private snackBar: MatSnackBar,
    private userService: UserService
  ) {
    const { baseCurrency, globalPermissions } = this.dataService.fetchInfo();

    this.baseCurrency = baseCurrency;

    this.hasPermissionForSubscription = hasPermission(
      globalPermissions,
      permissions.enableSubscription
    );

    this.userService.stateChanged
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((state) => {
        if (state?.user) {
          this.user = state.user;

          this.defaultDateFormat = getDateFormatString(
            this.user.settings.locale
          );

          const languageCode = this.user.settings.language;

          this.pricingUrl = `https://ghostfol.io/${languageCode}/${publicRoutes.pricing.path}`;

          this.hasPermissionToCreateApiKey = hasPermission(
            this.user.permissions,
            permissions.createApiKey
          );

          this.hasPermissionToUpdateUserSettings = hasPermission(
            this.user.permissions,
            permissions.updateUserSettings
          );

          this.coupon = this.user?.subscription?.offer?.coupon;
          this.couponId = this.user?.subscription?.offer?.couponId;
          this.durationExtension =
            this.user?.subscription?.offer?.durationExtension;
          this.price = this.user?.subscription?.offer?.price;
          this.priceId = this.user?.subscription?.offer?.priceId;

          this.changeDetectorRef.markForCheck();
        }
      });
  }

  public onCheckout() {
    this.dataService
      .createStripeCheckoutSession({
        couponId: this.couponId,
        priceId: this.priceId
      })
      .pipe(
        catchError((error: Error) => {
          this.notificationService.alert({
            title: error.message
          });

          return EMPTY;
        }),
        takeUntilDestroyed(this.destroyRef)
      )
      .subscribe(({ sessionUrl }) => {
        window.location.href = sessionUrl;
      });
  }

  public onGenerateApiKey() {
    this.notificationService.confirm({
      confirmFn: () => {
        this.dataService
          .postApiKey()
          .pipe(
            catchError(() => {
              this.snackBar.open(
                '😞 ' + $localize`Could not generate an API key`,
                undefined,
                {
                  duration: ms('3 seconds')
                }
              );

              return EMPTY;
            }),
            takeUntilDestroyed(this.destroyRef)
          )
          .subscribe(({ apiKey }) => {
            this.notificationService.alert({
              discardLabel: $localize`Okay`,
              // See `portfolio-performance`: the dialog renders text, so the break
              // between the instruction and the key is a newline.
              message:
                $localize`Set this API key in your self-hosted environment:` +
                '\n' +
                apiKey,
              title: $localize`Ghostfolio Premium Data Provider API Key`
            });
          });
      },
      confirmType: ConfirmationDialogType.Primary,
      title: $localize`Do you really want to generate a new API key?`
    });
  }

  public onRedeemCoupon() {
    this.notificationService.prompt({
      confirmFn: (value) => {
        const couponCode = value?.trim();

        if (couponCode) {
          this.dataService
            .redeemCoupon(couponCode)
            .pipe(
              catchError(() => {
                this.snackBar.open(
                  '😞 ' + $localize`Could not redeem coupon code`,
                  undefined,
                  {
                    duration: ms('3 seconds')
                  }
                );

                return EMPTY;
              }),
              takeUntilDestroyed(this.destroyRef)
            )
            .subscribe(() => {
              const snackBarRef = this.snackBar.open(
                '✅ ' + $localize`Coupon code has been redeemed`,
                $localize`Reload`,
                {
                  duration: ms('3 seconds')
                }
              );

              snackBarRef
                .afterDismissed()
                .pipe(takeUntilDestroyed(this.destroyRef))
                .subscribe(() => {
                  window.location.reload();
                });

              snackBarRef
                .onAction()
                .pipe(takeUntilDestroyed(this.destroyRef))
                .subscribe(() => {
                  window.location.reload();
                });
            });
        }
      },
      title: $localize`Please enter your coupon code.`,
      valueLabel: $localize`Coupon code`
    });
  }
}
