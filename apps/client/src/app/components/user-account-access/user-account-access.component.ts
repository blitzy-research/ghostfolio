import { GfAccessTableComponent } from '@ghostfolio/client/components/access-table/access-table.component';
import { UserService } from '@ghostfolio/client/services/user/user.service';
import { DashboardModuleType } from '@ghostfolio/common/dashboard';
import { CreateAccessDto } from '@ghostfolio/common/dtos';
import { ConfirmationDialogType } from '@ghostfolio/common/enums';
import { Access, User } from '@ghostfolio/common/interfaces';
import { hasPermission, permissions } from '@ghostfolio/common/permissions';
import { NotificationService } from '@ghostfolio/ui/notifications';
import { GfPremiumIndicatorComponent } from '@ghostfolio/ui/premium-indicator';
import { DataService } from '@ghostfolio/ui/services';

import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  CUSTOM_ELEMENTS_SCHEMA,
  DestroyRef,
  OnInit
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatDialog, MatDialogModule } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { ActivatedRoute, Params, Router, RouterModule } from '@angular/router';
import { IonIcon } from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import { addOutline, eyeOffOutline, eyeOutline } from 'ionicons/icons';
import { DeviceDetectorService } from 'ngx-device-detector';
import { EMPTY } from 'rxjs';
import { catchError } from 'rxjs/operators';

import { GfCreateOrUpdateAccessDialogComponent } from './create-or-update-access-dialog/create-or-update-access-dialog.component';
import { CreateOrUpdateAccessDialogParams } from './create-or-update-access-dialog/interfaces/interfaces';

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'has-fab' },
  imports: [
    GfAccessTableComponent,
    GfPremiumIndicatorComponent,
    IonIcon,
    MatButtonModule,
    MatDialogModule,
    MatFormFieldModule,
    MatInputModule,
    ReactiveFormsModule,
    RouterModule
  ],
  schemas: [CUSTOM_ELEMENTS_SCHEMA],
  selector: 'gf-user-account-access',
  styleUrls: ['./user-account-access.scss'],
  templateUrl: './user-account-access.html'
})
export class GfUserAccountAccessComponent implements OnInit {
  public accessesGet: Access[];
  public accessesGive: Access[];
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
  public readonly dialogModule = DashboardModuleType.ACCOUNT_ACCESS;

  public hasPermissionToCreateAccess: boolean;
  public hasPermissionToDeleteAccess: boolean;
  public hasPermissionToUpdateOwnAccessToken: boolean;
  public isAccessTokenHidden = true;
  public updateOwnAccessTokenForm = this.formBuilder.group({
    accessToken: ['', Validators.required]
  });
  public user: User;

  /**
   * The dialog request this module has already served, or `null` for none.
   *
   * A string rather than a boolean so that a request to edit a *different* grant
   * is still honoured while one is open. Reset by the query parameters ceasing to
   * ask for anything rather than by a dialog closing - see
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
  private queryParams: Params;

  public constructor(
    private changeDetectorRef: ChangeDetectorRef,
    private dataService: DataService,
    private destroyRef: DestroyRef,
    private deviceService: DeviceDetectorService,
    private dialog: MatDialog,
    private formBuilder: FormBuilder,
    private notificationService: NotificationService,
    private route: ActivatedRoute,
    private router: Router,
    private userService: UserService
  ) {
    const { globalPermissions } = this.dataService.fetchInfo();

    this.hasPermissionToDeleteAccess = hasPermission(
      globalPermissions,
      permissions.deleteAccess
    );

    this.userService.stateChanged
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((state) => {
        if (state?.user) {
          this.user = state.user;

          this.hasPermissionToCreateAccess = hasPermission(
            this.user.permissions,
            permissions.createAccess
          );

          this.hasPermissionToDeleteAccess = hasPermission(
            this.user.permissions,
            permissions.deleteAccess
          );

          this.hasPermissionToUpdateOwnAccessToken = hasPermission(
            this.user.permissions,
            permissions.updateOwnAccessToken
          );

          this.changeDetectorRef.markForCheck();

          this.applyQueryParams();
        }
      });

    // Recorded rather than acted on. Both dialogs this module opens are sized from
    // `deviceType`, which resolves in `ngOnInit` - after this. On the
    // route-per-screen shell that never mattered, because a screen was constructed
    // by a navigation that had already happened and its parameters arrived
    // afterwards. On one canvas a module is materialised lazily *in response to* a
    // request that is already on the URL, so `queryParams` delivers its current
    // value here, in the constructor, before any prerequisite exists.
    this.route.queryParams
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((params) => {
        this.queryParams = params;

        this.applyQueryParams();
      });

    addIcons({ addOutline, eyeOffOutline, eyeOutline });
  }

  public ngOnInit() {
    this.deviceType = this.deviceService.getDeviceInfo().deviceType;

    this.applyQueryParams();

    this.update();
  }

  public onDeleteAccess(aId: string) {
    this.dataService
      .deleteAccess(aId)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => {
          this.update();
        }
      });
  }

  public onGenerateAccessToken() {
    this.notificationService.confirm({
      confirmFn: () => {
        this.dataService
          .updateOwnAccessToken({
            accessToken: this.updateOwnAccessTokenForm.get('accessToken').value
          })
          .pipe(
            catchError(() => {
              this.notificationService.alert({
                title: $localize`Oops! Incorrect Security Token.`
              });

              return EMPTY;
            }),
            takeUntilDestroyed(this.destroyRef)
          )
          .subscribe(({ accessToken }) => {
            this.notificationService.alert({
              discardFn: () => {
                this.userService.signOut();

                document.location.href = `/${document.documentElement.lang}`;
              },
              message: accessToken,
              title: $localize`Security token`
            });
          });
      },
      confirmType: ConfirmationDialogType.Warn,
      title: $localize`Do you really want to generate a new security token?`
    });
  }

  /**
   * `accessDialogId` rather than `accessId`, and the distinction is load-bearing.
   * `accessId` is the root host's own discriminator for a portfolio shared by
   * link, so borrowing it to address this dialog made the root state depend on
   * whether a generic `editDialog` flag happened to be present - which meant an
   * unrelated module clearing that flag replaced a signed-in viewer's canvas with
   * a stranger's portfolio. See `GfAppQueryParams`.
   */
  public onUpdateAccess(aId: string) {
    void this.router.navigate([], {
      queryParams: {
        accessDialogId: aId,
        dialogModule: DashboardModuleType.ACCOUNT_ACCESS,
        editDialog: true
      },
      queryParamsHandling: 'merge',
      relativeTo: this.route
    });
  }

  /**
   * Opens whatever the current query parameters ask of this module, once it is
   * able to.
   *
   * Reached from four places - a parameter change, the device becoming known, the
   * viewer arriving and the grants arriving - because any of them can be the last
   * one to arrive. That makes idempotence a requirement rather than a nicety, and
   * {@link serveDialogRequest} is what provides it: without it, this module was
   * the only one of the fifteen query-parameter consumers on the canvas with no
   * served-request dedup, and every re-emission of an unchanged request minted
   * another copy of a dialog that was already open. Because every producer here
   * merges, any *other* module writing to the URL is such a re-emission - so the
   * count climbed without bound and each dismissal, being a navigation of its
   * own, was itself another trigger.
   */
  private applyQueryParams() {
    if (!this.deviceType || !this.user) {
      return;
    }

    const { accessDialogId, createDialog, dialogModule, editDialog } =
      this.queryParams ?? {};

    // Neither flag names a dialog of its own, so both are honoured only when the
    // producer addressed this module. That makes the handler fail-safe: an
    // unqualified `createDialog` or `editDialog` raised by any other module opens
    // nothing here. See `GfAppQueryParams`.
    const isAddressed = dialogModule === DashboardModuleType.ACCOUNT_ACCESS;

    if (isAddressed && createDialog && this.hasPermissionToCreateAccess) {
      this.serveDialogRequest('createDialog', () => {
        this.openCreateAccessDialog();
      });
    } else if (isAddressed && editDialog && accessDialogId) {
      const access = this.accessesGive?.find(({ id }) => {
        return id === accessDialogId;
      });

      if (access) {
        this.serveDialogRequest(`editDialog:${access.id}`, () => {
          this.openUpdateAccessDialog(access);
        });
      } else if (this.accessesGive) {
        // Only once the grants are known. Before that an `editDialog` is a request
        // this module cannot yet resolve, and clearing it would discard the request
        // instead of waiting for the data that would satisfy it. Deliberately not
        // recorded as served either, so it is still honoured when they arrive.
        this.clearDialogQueryParams();
      }
    } else {
      // Nothing is being asked of this module - either the parameters are gone or
      // they name somebody else. Forgetting what was last served is what lets the
      // viewer ask for the same dialog a second time: the close handler removes the
      // parameters it travelled on, this branch observes their absence, and the next
      // identical request is therefore new again.
      this.serveDialogRequest(null);
    }
  }

  /**
   * Opens a dialog unless the same request has already been served.
   *
   * Keyed on the request the URL is making rather than on the dialog's own
   * lifecycle: the close handler removes the parameters through a navigation, and
   * until that navigation is applied the parameters still ask for the dialog that
   * has just been dismissed. Keying on the dialog instead is what made a dismissal
   * a duplication trigger.
   */
  private serveDialogRequest(aAddress: string, aOpen?: () => void) {
    if (this.openedDialogAddress === aAddress) {
      return;
    }

    this.openedDialogAddress = aAddress;

    aOpen?.();
  }

  /**
   * Removes the query parameters this module's dialogs travel on, and only
   * those.
   *
   * Merging is what makes the clear safe on a single canvas: every module
   * observes the same query parameters, so dropping them all would close a
   * sibling module's dialog as a side effect of closing this one's.
   *
   * `accessId` is deliberately NOT among the keys cleared here, and that is a
   * correctness point rather than an omission: it belongs to the root host, where
   * it identifies a portfolio shared by link. Clearing it from this module used to
   * be necessary because this dialog travelled on it; now that the dialog has
   * `accessDialogId` of its own, clearing `accessId` here would close somebody's
   * shared portfolio as a side effect of closing an unrelated dialog.
   */
  private clearDialogQueryParams() {
    void this.router.navigate([], {
      queryParams: {
        accessDialogId: null,
        createDialog: null,
        dialogModule: null,
        editDialog: null
      },
      queryParamsHandling: 'merge',
      relativeTo: this.route
    });
  }

  private openCreateAccessDialog() {
    const dialogRef = this.dialog.open<
      GfCreateOrUpdateAccessDialogComponent,
      CreateOrUpdateAccessDialogParams
    >(GfCreateOrUpdateAccessDialogComponent, {
      data: {
        access: {
          alias: '',
          grantee: null,
          id: null,
          permissions: ['READ_RESTRICTED'],
          type: 'PRIVATE'
        }
      },
      height: this.deviceType === 'mobile' ? '98vh' : undefined,
      width: this.deviceType === 'mobile' ? '100vw' : '50rem'
    });

    dialogRef.afterClosed().subscribe((access: CreateAccessDto | null) => {
      if (access) {
        this.update();
      }

      this.clearDialogQueryParams();
    });
  }

  // Takes the grant itself rather than its identifier, because the caller has
  // already had to resolve it: an `editDialog` naming a grant that is not there is
  // an outcome {@link applyQueryParams} has to tell apart from one that simply has
  // not loaded yet, and only it knows which.
  private openUpdateAccessDialog(access: Access) {
    const dialogRef = this.dialog.open<
      GfCreateOrUpdateAccessDialogComponent,
      CreateOrUpdateAccessDialogParams
    >(GfCreateOrUpdateAccessDialogComponent, {
      data: {
        access: {
          alias: access.alias,
          grantee: access.grantee === 'Public' ? null : access.grantee,
          id: access.id,
          permissions: access.permissions,
          type: access.type
        }
      },
      height: this.deviceType === 'mobile' ? '98vh' : undefined,
      width: this.deviceType === 'mobile' ? '100vw' : '50rem'
    });

    dialogRef.afterClosed().subscribe((result) => {
      if (result) {
        this.update();
      }

      this.clearDialogQueryParams();
    });
  }

  private update() {
    this.accessesGet = this.user.access.map(({ alias, id, permissions }) => {
      return {
        alias,
        id,
        permissions,
        grantee: $localize`Me`,
        type: 'PRIVATE'
      };
    });

    this.dataService
      .fetchAccesses()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((accesses) => {
        this.accessesGive = accesses;

        this.changeDetectorRef.markForCheck();

        // An `editDialog` that arrived before the grants did is a request this
        // module could not resolve at the time; this is the moment it can.
        this.applyQueryParams();
      });
  }
}
