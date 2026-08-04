import { GfAccountDetailDialogComponent } from '@ghostfolio/client/components/account-detail-dialog/account-detail-dialog.component';
import { AccountDetailDialogParams } from '@ghostfolio/client/components/account-detail-dialog/interfaces/interfaces';
import type { GfAppQueryParams } from '@ghostfolio/client/interfaces/interfaces';
import { ImpersonationStorageService } from '@ghostfolio/client/services/impersonation-storage.service';
import { UserService } from '@ghostfolio/client/services/user/user.service';
import { DashboardModuleType } from '@ghostfolio/common/dashboard';
import {
  CreateAccountDto,
  TransferBalanceDto,
  UpdateAccountDto
} from '@ghostfolio/common/dtos';
import { User } from '@ghostfolio/common/interfaces';
import { hasPermission, permissions } from '@ghostfolio/common/permissions';
import { GfAccountsTableComponent } from '@ghostfolio/ui/accounts-table';
import { NotificationService } from '@ghostfolio/ui/notifications';
import { DataService } from '@ghostfolio/ui/services';

import {
  ChangeDetectorRef,
  Component,
  DestroyRef,
  OnInit
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { MatButtonModule } from '@angular/material/button';
import { MatDialog } from '@angular/material/dialog';
import { ActivatedRoute, Router, RouterModule } from '@angular/router';
import { Account as AccountModel } from '@prisma/client';
import { addIcons } from 'ionicons';
import { addOutline } from 'ionicons/icons';
import { DeviceDetectorService } from 'ngx-device-detector';
import { EMPTY, Subscription } from 'rxjs';
import { catchError } from 'rxjs/operators';

import { GfCreateOrUpdateAccountDialogComponent } from './create-or-update-account-dialog/create-or-update-account-dialog.component';
import { CreateOrUpdateAccountDialogParams } from './create-or-update-account-dialog/interfaces/interfaces';
import { TransferBalanceDialogParams } from './transfer-balance/interfaces/interfaces';
import { GfTransferBalanceDialogComponent } from './transfer-balance/transfer-balance-dialog.component';

@Component({
  host: { class: 'has-fab' },
  imports: [GfAccountsTableComponent, MatButtonModule, RouterModule],
  selector: 'gf-accounts',
  styleUrls: ['./accounts.scss'],
  templateUrl: './accounts.html'
})
export class GfAccountsComponent implements OnInit {
  public accounts: AccountModel[];
  public activitiesCount = 0;
  public deviceType: string;
  /**
   * The discriminator this module's dialog flags are addressed with.
   *
   * Exposed so the template can bind it instead of repeating the literal. The
   * discriminator has to match what this component's own query-parameter handler
   * compares against, and a repeated literal is a match that no compiler
   * checks - renaming the enum member would leave the control silently opening
   * nothing.
   */
  public readonly dialogModule = DashboardModuleType.ACCOUNTS;

  public hasImpersonationId: boolean;
  public hasPermissionToCreateAccount: boolean;
  public hasPermissionToUpdateAccount: boolean;
  public routeQueryParams: Subscription;
  public totalBalanceInBaseCurrency = 0;
  public totalValueInBaseCurrency = 0;
  public user: User;

  public constructor(
    private changeDetectorRef: ChangeDetectorRef,
    private dataService: DataService,
    private destroyRef: DestroyRef,
    private deviceService: DeviceDetectorService,
    private dialog: MatDialog,
    private impersonationStorageService: ImpersonationStorageService,
    private notificationService: NotificationService,
    private route: ActivatedRoute,
    private router: Router,
    private userService: UserService
  ) {
    this.route.queryParams
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(
        ({
          accountDetailDialog,
          accountId,
          createDialog,
          dialogModule,
          editDialog,
          transferBalanceDialog
        }: GfAppQueryParams) => {
          // On the single-canvas shell every module observes the same query
          // parameters at once, so a flag that does not say who it is for is
          // seen by all of them. `dialogModule` is what says it, and the two
          // kinds of flag need it differently.
          //
          // `createDialog` and `editDialog` name no dialog of their own, so they
          // are honoured here ONLY when addressed to this module. That gate is
          // fail-safe by construction - an unqualified or foreign-qualified flag
          // opens nothing - and it is what stops one module's floating action
          // button from opening another's dialog. Same gate as in
          // `components/user-account-access/user-account-access.component.ts`.
          //
          // `accountDetailDialog` and `transferBalanceDialog` do name a dialog,
          // but naming a dialog is not the same as naming an owner: the account
          // detail dialog is opened from three unqualified producers - the
          // accounts table rendered inside this module, the assistant, and the
          // allocations module - and the allocations module hosts a second copy
          // of the very same dialog. Honouring these flags unconditionally
          // therefore opened TWO identical dialogs whenever both modules were on
          // the canvas. This module stays the default owner, because the two
          // unqualified producers belong to it, but it now stands down when the
          // request names someone else.
          const isAddressed = dialogModule === DashboardModuleType.ACCOUNTS;
          const isAddressedElsewhere = !!dialogModule && !isAddressed;

          if (accountId && accountDetailDialog && !isAddressedElsewhere) {
            this.openAccountDetailDialog(accountId);
          } else if (
            isAddressed &&
            createDialog &&
            this.hasPermissionToCreateAccount
          ) {
            this.openCreateAccountDialog();
          } else if (isAddressed && editDialog) {
            const account = this.accounts?.find(({ id }) => {
              return id === accountId;
            });

            // An account that cannot be found is the only outcome besides
            // opening the dialog. Passing it on regardless would destructure
            // `undefined` and throw, which is exactly what an `editDialog`
            // addressed to this module before its accounts had loaded - or
            // naming an account that has since been deleted - used to do.
            if (account) {
              this.openUpdateAccountDialog(account);
            } else {
              this.clearDialogQueryParams();
            }
          } else if (transferBalanceDialog && !isAddressedElsewhere) {
            this.openTransferBalanceDialog();
          }
        }
      );

    addIcons({ addOutline });
  }

  public ngOnInit() {
    this.deviceType = this.deviceService.getDeviceInfo().deviceType;

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

          this.hasPermissionToCreateAccount = hasPermission(
            this.user.permissions,
            permissions.createAccount
          );
          this.hasPermissionToUpdateAccount = hasPermission(
            this.user.permissions,
            permissions.updateAccount
          );

          this.changeDetectorRef.markForCheck();
        }
      });

    this.fetchAccounts();
  }

  public fetchAccounts() {
    this.dataService
      .fetchAccounts()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(
        ({
          accounts,
          activitiesCount,
          totalBalanceInBaseCurrency,
          totalValueInBaseCurrency
        }) => {
          this.accounts = accounts;
          this.activitiesCount = activitiesCount;
          this.totalBalanceInBaseCurrency = totalBalanceInBaseCurrency;
          this.totalValueInBaseCurrency = totalValueInBaseCurrency;

          if (this.accounts?.length <= 0) {
            void this.router.navigate([], {
              queryParams: {
                createDialog: true,
                dialogModule: DashboardModuleType.ACCOUNTS
              },
              queryParamsHandling: 'merge',
              relativeTo: this.route
            });
          }

          this.changeDetectorRef.markForCheck();
        }
      );
  }

  public onDeleteAccount(aId: string) {
    this.reset();

    this.dataService
      .deleteAccount(aId)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => {
        this.userService
          .get(true)
          .pipe(takeUntilDestroyed(this.destroyRef))
          .subscribe();

        this.fetchAccounts();
      });
  }

  /**
   * Asks for the transfer-balance dialog, naming this module.
   *
   * The discriminator is required even though this flag has a single consumer,
   * because the request is *merged*: a `dialogModule` left on the URL by any
   * earlier interaction - the asset profile hand-off names
   * `admin-market-data`, for instance - would survive the merge and make the
   * handler stand down as "addressed elsewhere", leaving this control silently
   * inert. Naming the owner overwrites that residue, which is also what makes
   * the payload identical in meaning to every other producer here.
   */
  public onTransferBalance() {
    void this.router.navigate([], {
      queryParams: {
        dialogModule: DashboardModuleType.ACCOUNTS,
        transferBalanceDialog: true
      },
      queryParamsHandling: 'merge',
      relativeTo: this.route
    });
  }

  public onUpdateAccount(aAccount: AccountModel) {
    void this.router.navigate([], {
      queryParams: {
        accountId: aAccount.id,
        dialogModule: DashboardModuleType.ACCOUNTS,
        editDialog: true
      },
      queryParamsHandling: 'merge',
      relativeTo: this.route
    });
  }

  public openUpdateAccountDialog({
    balance,
    comment,
    currency,
    id,
    isExcluded,
    name,
    platformId
  }: AccountModel) {
    const dialogRef = this.dialog.open<
      GfCreateOrUpdateAccountDialogComponent,
      CreateOrUpdateAccountDialogParams
    >(GfCreateOrUpdateAccountDialogComponent, {
      data: {
        account: {
          balance,
          comment,
          currency,
          id,
          isExcluded,
          name,
          platformId
        }
      },
      height: this.deviceType === 'mobile' ? '98vh' : '80vh',
      width: this.deviceType === 'mobile' ? '100vw' : '50rem'
    });

    dialogRef
      .afterClosed()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((account: UpdateAccountDto | null) => {
        if (account) {
          this.reset();

          this.dataService
            .putAccount(account)
            .pipe(takeUntilDestroyed(this.destroyRef))
            .subscribe(() => {
              this.userService
                .get(true)
                .pipe(takeUntilDestroyed(this.destroyRef))
                .subscribe();

              this.fetchAccounts();
            });

          this.changeDetectorRef.markForCheck();
        }

        this.clearDialogQueryParams();
      });
  }

  /**
   * Removes the query parameters this module's dialogs travel on, and only
   * those.
   *
   * The empty command array keeps the request on the current URL - the
   * workspace's route-agnostic convention - and merging is what makes the clear
   * safe on a single canvas: every module observes the same query parameters, so
   * dropping them all would close a sibling module's dialog and discard the
   * shared-portfolio access identifier as a side effect of closing this one's.
   * `dialogModule` is cleared with them because this module only ever opens a
   * dialog while that discriminator names it.
   */
  private clearDialogQueryParams() {
    void this.router.navigate([], {
      queryParams: {
        accountDetailDialog: null,
        accountId: null,
        createDialog: null,
        dialogModule: null,
        editDialog: null,
        transferBalanceDialog: null
      },
      queryParamsHandling: 'merge',
      relativeTo: this.route
    });
  }

  private openAccountDetailDialog(aAccountId: string) {
    const dialogRef = this.dialog.open<
      GfAccountDetailDialogComponent,
      AccountDetailDialogParams
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
      .subscribe(() => {
        this.fetchAccounts();

        this.clearDialogQueryParams();
      });
  }

  private openCreateAccountDialog() {
    const dialogRef = this.dialog.open<
      GfCreateOrUpdateAccountDialogComponent,
      CreateOrUpdateAccountDialogParams
    >(GfCreateOrUpdateAccountDialogComponent, {
      data: {
        account: {
          balance: 0,
          comment: null,
          currency: this.user?.settings?.baseCurrency,
          id: null,
          isExcluded: false,
          name: null,
          platformId: null
        }
      },
      height: this.deviceType === 'mobile' ? '98vh' : '80vh',
      width: this.deviceType === 'mobile' ? '100vw' : '50rem'
    });

    dialogRef
      .afterClosed()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((account: CreateAccountDto | null) => {
        if (account) {
          this.reset();

          this.dataService
            .postAccount(account)
            .pipe(takeUntilDestroyed(this.destroyRef))
            .subscribe(() => {
              this.userService
                .get(true)
                .pipe(takeUntilDestroyed(this.destroyRef))
                .subscribe();

              this.fetchAccounts();
            });

          this.changeDetectorRef.markForCheck();
        }

        this.clearDialogQueryParams();
      });
  }

  private openTransferBalanceDialog() {
    const dialogRef = this.dialog.open<
      GfTransferBalanceDialogComponent,
      TransferBalanceDialogParams
    >(GfTransferBalanceDialogComponent, {
      data: {
        accounts: this.accounts
      },
      width: this.deviceType === 'mobile' ? '100vw' : '50rem'
    });

    dialogRef
      .afterClosed()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((data: any) => {
        if (data) {
          this.reset();

          const { accountIdFrom, accountIdTo, balance }: TransferBalanceDto =
            data?.account;

          this.dataService
            .transferAccountBalance({
              accountIdFrom,
              accountIdTo,
              balance
            })
            .pipe(
              catchError(() => {
                this.notificationService.alert({
                  title: $localize`Oops, cash balance transfer has failed.`
                });

                return EMPTY;
              }),
              takeUntilDestroyed(this.destroyRef)
            )
            .subscribe(() => {
              this.fetchAccounts();
            });

          this.changeDetectorRef.markForCheck();
        }

        this.clearDialogQueryParams();
      });
  }

  private reset() {
    this.accounts = undefined;
    this.activitiesCount = 0;
    this.totalBalanceInBaseCurrency = 0;
    this.totalValueInBaseCurrency = 0;
  }
}
