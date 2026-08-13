import { GfAccountDetailDialogComponent } from '@ghostfolio/client/components/account-detail-dialog/account-detail-dialog.component';
import {
  AccountDetailDialogParams,
  AccountDetailDialogResult
} from '@ghostfolio/client/components/account-detail-dialog/interfaces/interfaces';
import type { GfAppQueryParams } from '@ghostfolio/client/interfaces/interfaces';
import { ImpersonationStorageService } from '@ghostfolio/client/services/impersonation-storage.service';
import { UserService } from '@ghostfolio/client/services/user/user.service';
import { DashboardModuleType } from '@ghostfolio/common/dashboard';
import { CreateAccountDto, UpdateAccountDto } from '@ghostfolio/common/dtos';
import { User } from '@ghostfolio/common/interfaces';
import { hasPermission, permissions } from '@ghostfolio/common/permissions';
import { GfAccountsTableComponent } from '@ghostfolio/ui/accounts-table';
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
import { Subscription } from 'rxjs';

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
   * The query parameters that ask this module for a blank create form.
   *
   * Bound by the floating action button in this component's template. The
   * explicit nulls are the point of it: `accountDetailDialog`, `accountId` and
   * `editDialog` may already be on the URL from an earlier interaction, and
   * because {@link applyQueryParams} tests the account detail request ahead of
   * `createDialog`, merging without clearing them re-opened that dialog instead
   * of the create form. `transferBalanceDialog` is cleared for the mirror-image
   * reason - it is tested *after* `createDialog`, so a stale one would open on
   * top of the form the moment it was dismissed.
   */
  public readonly createDialogQueryParams = {
    accountDetailDialog: null as boolean,
    accountId: null as string,
    createDialog: true,
    dialogModule: DashboardModuleType.ACCOUNTS,
    editDialog: null as boolean,
    transferBalanceDialog: null as boolean
  };

  public hasImpersonationId: boolean;
  public hasPermissionToCreateAccount: boolean;
  public hasPermissionToUpdateAccount: boolean;
  public routeQueryParams: Subscription;
  public totalBalanceInBaseCurrency = 0;
  public totalValueInBaseCurrency = 0;
  public user: User;

  /**
   * The dialog request this module has already served, or `null` for none.
   *
   * A string rather than a boolean so that a request for a *different* account's
   * detail dialog is still honoured while one is open. Reset by the query
   * parameters ceasing to ask for anything rather than by a dialog closing - see
   * {@link serveDialogRequest} for why that distinction matters.
   */
  private openedDialogAddress: string = null;

  /**
   * The query parameters as they stand, held rather than consumed on arrival.
   *
   * They can reach this module before it is able to act on them - see
   * {@link applyQueryParams} - so the most recent set is kept and re-evaluated
   * whenever a prerequisite arrives.
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
    // Recorded rather than acted on. Every dialog this module opens is sized from
    // `deviceType` and permitted from `user`, and both are resolved in `ngOnInit` -
    // which runs *after* this. On the route-per-screen shell that never mattered,
    // because a screen was constructed by a navigation that had already happened
    // and its parameters arrived afterwards. On one canvas a module is
    // materialised lazily *in response to* a request that is already on the URL,
    // so `queryParams` delivers its current value here, in the constructor, before
    // any of those prerequisites exist. Acting on it then produced a dialog laid
    // out for the wrong device and, worse, a `createDialog` that opened nothing at
    // all because the permission it is gated on had not been read yet.
    this.route.queryParams
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((queryParams: GfAppQueryParams) => {
        this.queryParams = queryParams;

        this.applyQueryParams();
      });

    addIcons({ addOutline });
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

          this.hasPermissionToCreateAccount = hasPermission(
            this.user.permissions,
            permissions.createAccount
          );
          this.hasPermissionToUpdateAccount = hasPermission(
            this.user.permissions,
            permissions.updateAccount
          );

          this.changeDetectorRef.markForCheck();

          this.applyQueryParams();
        }
      });

    this.applyQueryParams();

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

          // Nothing is opened automatically. The activities module makes the same
          // offer to the same user at the same moment, and both modules can be on
          // the canvas together, so greeting an empty portfolio with a dialog would
          // let the order the two responses arrive in decide whether one onboarding
          // dialog appears or two appear stacked. The offer is made instead by the
          // empty state this module already renders and by its floating action
          // button, both of which the viewer chooses to act on.
          this.applyQueryParams();

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
   * Opens whatever the current query parameters ask this module for, once it is in
   * a position to open it properly.
   *
   * Reached from four places - a parameter change, the device becoming known, the
   * viewer resolving, and the impersonation state settling - because any of them
   * can be the last one to arrive. That makes idempotence a requirement rather
   * than a nicety, and {@link openedDialogAddress} is what provides it: the
   * address a dialog was opened for is remembered until it closes, so being told
   * the same thing four times opens one dialog.
   *
   * Idempotence is also what makes merging safe. Every producer merges rather than
   * replaces - it has to, or it would drop a sibling module's parameters and the
   * shared-portfolio identifier - so `route.queryParams` emits again whenever any
   * *other* module writes to the URL, and a handler that opened on every emission
   * would stack a second copy of a dialog that is already up.
   *
   * Waiting on the viewer is deliberate even for the paths that do not read a
   * permission: the account detail dialog is handed `hasPermissionToCreateActivity`
   * and an impersonation flag, so opening it early would grant or deny an action
   * on the strength of state that had not been read.
   */
  private applyQueryParams() {
    if (!this.deviceType || !this.user) {
      return;
    }

    const {
      accountDetailDialog,
      accountId,
      createDialog,
      dialogModule,
      editDialog,
      transferBalanceDialog
    } = this.queryParams ?? {};

    // The two kinds of flag need `dialogModule` differently.
    //
    // `createDialog` and `editDialog` name no dialog of their own, so they are
    // honoured here ONLY when addressed to this module, which is what stops one
    // module's floating action button from opening another's dialog.
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
      this.serveDialogRequest(`accountDetailDialog:${accountId}`, () => {
        this.openAccountDetailDialog(accountId);
      });
    } else if (
      isAddressed &&
      createDialog &&
      this.hasPermissionToCreateAccount
    ) {
      this.serveDialogRequest('createDialog', () => {
        this.openCreateAccountDialog();
      });
    } else if (isAddressed && editDialog) {
      const account = this.accounts?.find(({ id }) => {
        return id === accountId;
      });

      // An account that cannot be found is the only outcome besides
      // opening the dialog. Passing it on regardless would destructure
      // `undefined` and throw - which is what an `editDialog` addressed to
      // this module before its accounts have loaded, or naming an account
      // that has since been deleted, would otherwise produce.
      if (account) {
        this.serveDialogRequest(`editDialog:${account.id}`, () => {
          this.openUpdateAccountDialog(account);
        });
      } else if (this.accounts) {
        // Only once the accounts are known. Before that an `editDialog` is a
        // request this module cannot yet resolve, and clearing it would discard
        // the request instead of waiting for the data that would satisfy it.
        // Deliberately not recorded as served either, so that the request is
        // still honoured when the accounts arrive.
        this.clearDialogQueryParams();
      }
    } else if (transferBalanceDialog && !isAddressedElsewhere) {
      // Waited for, exactly as `editDialog` above is waited for, and for a sharper
      // reason: this dialog IS its accounts. Both of its selects are built from the
      // list, so opening before it arrives produced a form whose two required
      // choices could not be made - and a cold link carrying this parameter always
      // arrives that way, because the request is applied once before the first read
      // has answered. Not recorded as served, so the request is still honoured when
      // the accounts do arrive.
      if (this.accounts?.length) {
        this.serveDialogRequest('transferBalanceDialog', () => {
          this.openTransferBalanceDialog();
        });
      } else if (this.accounts) {
        // The accounts are known and there are none to transfer between, so the
        // request cannot ever be satisfied and is discarded rather than left in the
        // address pointing at a dialog that will not open.
        this.clearDialogQueryParams();
      }
    } else {
      // Nothing is being asked of this module. Forgetting what was last served is
      // what lets the viewer ask for the same dialog a second time: the close
      // handler removes the parameters it travelled on, this branch observes their
      // absence, and the next identical request is therefore new again.
      this.serveDialogRequest(null);
    }
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
        this.fetchAccounts();

        // A dialog that closed itself in order to open another module's has
        // already written that request onto the URL, and it wrote it onto the very
        // parameters this clear removes. Clearing anyway would strip
        // `createDialog`/`editDialog`, `activityId` and `dialogModule` back off
        // again, and a lazily loaded activities module - which subscribes after
        // this runs - would find nothing addressed to it and open nothing at all.
        // The hand-off already cleared the two keys that identify this dialog, so
        // there is nothing left here to clean up either.
        if (result?.hasHandedOver) {
          return;
        }

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
      .subscribe((transferred: boolean) => {
        // The dialog OWNS the transfer now, and closes with a result only once it
        // succeeded. It used to close first and be transferred from here, which is
        // what produced the stuck module: this handler cleared the accounts to show a
        // loading state, and the failure branch alerted and returned `EMPTY`, so the
        // re-read never ran and the module was left animating a skeleton over a list
        // it had just discarded - permanently, and over a transfer that had not
        // happened.
        if (transferred) {
          this.fetchAccounts();
        }

        this.clearDialogQueryParams();
      });
  }

  /**
   * Opens a dialog unless the same request has already been served.
   *
   * The request the URL is making - not the dialog's own lifecycle - is what this
   * is keyed on, and that is the whole point. `applyQueryParams` is reached from
   * five places, and one of them is `fetchAccounts`, which every close handler
   * calls; keying on the dialog instead would let a close re-open the dialog that
   * had just closed, because the parameters asking for it are removed by a
   * navigation that has not necessarily been applied yet.
   *
   * The address is what makes this precise rather than merely a lock: asking for a
   * *different* account's detail dialog is a genuine second request and is
   * honoured, while being re-notified about the one already served is not.
   */
  private serveDialogRequest(aAddress: string, aOpen?: () => void) {
    if (this.openedDialogAddress === aAddress) {
      return;
    }

    this.openedDialogAddress = aAddress;

    aOpen?.();
  }

  private reset() {
    this.accounts = undefined;
    this.activitiesCount = 0;
    this.totalBalanceInBaseCurrency = 0;
    this.totalValueInBaseCurrency = 0;
  }
}
