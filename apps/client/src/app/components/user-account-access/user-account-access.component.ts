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
import { ActivatedRoute, Router, RouterModule } from '@angular/router';
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
        }
      });

    this.route.queryParams
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((params) => {
        // The generic dialog flags are honoured only when the producer addressed
        // this module. Bailing out first makes the handler fail-safe: an
        // unqualified `createDialog` or `editDialog` raised by any other module
        // opens nothing here. See `GfAppQueryParams`.
        if (params['dialogModule'] !== DashboardModuleType.ACCOUNT_ACCESS) {
          return;
        }

        if (params['createDialog']) {
          this.openCreateAccessDialog();
        } else if (params['editDialog'] && params['accessId']) {
          this.openUpdateAccessDialog(params['accessId']);
        }
      });

    addIcons({ addOutline, eyeOffOutline, eyeOutline });
  }

  public ngOnInit() {
    this.deviceType = this.deviceService.getDeviceInfo().deviceType;

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

  public onUpdateAccess(aId: string) {
    void this.router.navigate([], {
      queryParams: {
        accessId: aId,
        dialogModule: DashboardModuleType.ACCOUNT_ACCESS,
        editDialog: true
      },
      queryParamsHandling: 'merge',
      relativeTo: this.route
    });
  }

  /**
   * Removes the query parameters this module's dialogs travel on, and only
   * those.
   *
   * Merging is what makes the clear safe on a single canvas: every module
   * observes the same query parameters, so dropping them all would close a
   * sibling module's dialog as a side effect of closing this one's. Clearing
   * `accessId` alongside `editDialog` also matters beyond this module - the two
   * together are how the canvas tells an access grant being edited from a
   * portfolio shared by link - so leaving either behind would misreport the
   * canvas's own state.
   */
  private clearDialogQueryParams() {
    void this.router.navigate([], {
      queryParams: {
        accessId: null,
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

  private openUpdateAccessDialog(accessId: string) {
    const access = this.accessesGive?.find(({ id }) => {
      return id === accessId;
    });

    if (!access) {
      return;
    }

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
      });
  }
}
