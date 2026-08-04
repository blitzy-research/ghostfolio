import { UserService } from '@ghostfolio/client/services/user/user.service';
import { CreatePlatformDto, UpdatePlatformDto } from '@ghostfolio/common/dtos';
import { ConfirmationDialogType } from '@ghostfolio/common/enums';
import { getLocale } from '@ghostfolio/common/helper';
import { GfEntityLogoComponent } from '@ghostfolio/ui/entity-logo';
import { NotificationService } from '@ghostfolio/ui/notifications';
import { AdminService, DataService } from '@ghostfolio/ui/services';
import { GfValueComponent } from '@ghostfolio/ui/value';

import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  DestroyRef,
  Input,
  OnInit,
  ViewChild
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { MatButtonModule } from '@angular/material/button';
import { MatDialog } from '@angular/material/dialog';
import { MatMenuModule } from '@angular/material/menu';
import { MatSort, MatSortModule } from '@angular/material/sort';
import { MatTableDataSource, MatTableModule } from '@angular/material/table';
import { ActivatedRoute, Params, Router, RouterModule } from '@angular/router';
import { IonIcon } from '@ionic/angular/standalone';
import { Platform } from '@prisma/client';
import { addIcons } from 'ionicons';
import {
  createOutline,
  ellipsisHorizontal,
  trashOutline
} from 'ionicons/icons';
import { get } from 'lodash';
import { DeviceDetectorService } from 'ngx-device-detector';

import { GfCreateOrUpdatePlatformDialogComponent } from './create-or-update-platform-dialog/create-or-update-platform-dialog.component';
import { CreateOrUpdatePlatformDialogParams } from './create-or-update-platform-dialog/interfaces/interfaces';

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    GfEntityLogoComponent,
    GfValueComponent,
    IonIcon,
    MatButtonModule,
    MatMenuModule,
    MatSortModule,
    MatTableModule,
    RouterModule
  ],
  selector: 'gf-admin-platform',
  styleUrls: ['./admin-platform.component.scss'],
  templateUrl: './admin-platform.component.html'
})
export class GfAdminPlatformComponent implements OnInit {
  @Input() locale = getLocale();

  @ViewChild(MatSort) sort: MatSort;

  /**
   * The query parameters that ask this component for a blank create form.
   *
   * Bound by the template's control. The explicit nulls are the point of it: an
   * `editPlatformDialog` request may still be on the URL, and because
   * {@link applyQueryParams} tests `createPlatformDialog` first, merging without
   * clearing them would leave a stale edit request to open the moment the create
   * form was dismissed.
   */
  public readonly createDialogQueryParams = {
    createPlatformDialog: true,
    editPlatformDialog: null as boolean,
    platformId: null as string
  };

  public dataSource = new MatTableDataSource<Platform>();
  public deviceType: string;
  public displayedColumns = ['name', 'url', 'accounts', 'actions'];
  public platforms: Platform[];

  /**
   * The dialog request this component has already served, or `null` for none.
   *
   * Reset by the query parameters ceasing to ask for anything rather than by a
   * dialog closing - see {@link serveDialogRequest}.
   */
  private openedDialogAddress: string = null;

  /**
   * The query parameters as they stand, held rather than consumed on arrival.
   *
   * Both dialogs are sized from `deviceType`, which resolves in `ngOnInit` - after
   * the constructor. That ordering only matters on one canvas, where the module
   * hosting this component is materialised lazily *in response to* a request that
   * is already on the URL, so the parameters arrive before they can be honoured
   * correctly: the dialog was laid out for the wrong device every time.
   */
  private queryParams: Params;

  public constructor(
    private adminService: AdminService,
    private changeDetectorRef: ChangeDetectorRef,
    private dataService: DataService,
    private destroyRef: DestroyRef,
    private deviceService: DeviceDetectorService,
    private dialog: MatDialog,
    private notificationService: NotificationService,
    private route: ActivatedRoute,
    private router: Router,
    private userService: UserService
  ) {
    this.route.queryParams
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((params) => {
        this.queryParams = params;

        this.applyQueryParams();
      });

    addIcons({ createOutline, ellipsisHorizontal, trashOutline });
  }

  public ngOnInit() {
    this.deviceType = this.deviceService.getDeviceInfo().deviceType;

    // Re-evaluated once the device is known, so a request that was already on the
    // URL when this component was created is honoured now that it can be honoured
    // correctly.
    this.applyQueryParams();

    this.fetchPlatforms();
  }

  /**
   * Opens whatever the current query parameters ask for, once the device is known.
   *
   * Reached from three places - a parameter change, the device becoming known and
   * the platforms arriving - because any of them can be the last one to arrive.
   * That makes idempotence a requirement rather than a nicety, and
   * {@link serveDialogRequest} is what provides it.
   */
  private applyQueryParams() {
    if (!this.deviceType) {
      return;
    }

    const { createPlatformDialog, editPlatformDialog, platformId } =
      this.queryParams ?? {};

    if (createPlatformDialog) {
      this.serveDialogRequest('createPlatformDialog', () => {
        this.openCreatePlatformDialog();
      });
    } else if (editPlatformDialog) {
      const platform = this.platforms?.find(({ id }) => {
        return id === platformId;
      });

      // A platform that cannot be found is the only outcome besides opening the
      // dialog. Passing it on regardless destructured `undefined` and threw, which
      // is exactly what an `editPlatformDialog` naming a platform that had since
      // been deleted used to do.
      if (platform) {
        this.serveDialogRequest(`editPlatformDialog:${platform.id}`, () => {
          this.openUpdatePlatformDialog(platform);
        });
      } else if (this.platforms) {
        // Only once the platforms are known. Before that the request is one this
        // component cannot yet resolve, and clearing it would discard the request
        // instead of waiting for the data that would satisfy it. Deliberately not
        // recorded as served either, so it is still honoured when they arrive.
        this.clearDialogQueryParams();
      }
    } else {
      // Nothing is being asked. Forgetting what was last served is what lets the
      // same dialog be asked for a second time: the close handler removes the
      // parameters it travelled on, this branch observes their absence, and the
      // next identical request is therefore new again.
      this.serveDialogRequest(null);
    }
  }

  /**
   * Removes the query parameters this component's dialogs travel on, and only
   * those.
   *
   * The empty command array keeps the request on the current URL - the workspace's
   * route-agnostic convention - and merging is what makes the clear safe on a
   * single canvas. The `navigate(['.'])` this replaced named a route segment
   * instead, which dropped every query parameter on the canvas: closing this
   * dialog also closed a sibling module's and discarded the shared-portfolio access
   * identifier along with it.
   */
  private clearDialogQueryParams() {
    void this.router.navigate([], {
      queryParams: {
        createPlatformDialog: null,
        editPlatformDialog: null,
        platformId: null
      },
      queryParamsHandling: 'merge',
      relativeTo: this.route
    });
  }

  /**
   * Opens a dialog unless the same request has already been served.
   *
   * Keyed on the request the URL is making rather than on the dialog's own
   * lifecycle: the close handler removes the parameters through a navigation, and
   * until that navigation is applied the parameters still ask for the dialog that
   * has just been dismissed.
   */
  private serveDialogRequest(aAddress: string, aOpen?: () => void) {
    if (this.openedDialogAddress === aAddress) {
      return;
    }

    this.openedDialogAddress = aAddress;

    aOpen?.();
  }

  public onDeletePlatform(aId: string) {
    this.notificationService.confirm({
      confirmFn: () => {
        this.deletePlatform(aId);
      },
      confirmType: ConfirmationDialogType.Warn,
      title: $localize`Do you really want to delete this platform?`
    });
  }

  public onUpdatePlatform({ id }: Platform) {
    // Merged, not replaced. Replacing the whole map discarded every parameter the
    // rest of the canvas had put there - a sibling module's open dialog, the
    // shared-portfolio access identifier, the sign-in token hand-off - as a side
    // effect of opening this one dialog. `createPlatformDialog` is nulled because
    // it is tested first, so a stale one would open a blank form instead of this
    // platform.
    void this.router.navigate([], {
      queryParams: {
        createPlatformDialog: null,
        editPlatformDialog: true,
        platformId: id
      },
      queryParamsHandling: 'merge',
      relativeTo: this.route
    });
  }

  private deletePlatform(aId: string) {
    this.adminService
      .deletePlatform(aId)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => {
          this.userService
            .get(true)
            .pipe(takeUntilDestroyed(this.destroyRef))
            .subscribe();

          this.fetchPlatforms();
        }
      });
  }

  private fetchPlatforms() {
    this.adminService
      .fetchPlatforms()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((platforms) => {
        this.platforms = platforms;

        this.dataSource = new MatTableDataSource(platforms);
        this.dataSource.sort = this.sort;
        this.dataSource.sortingDataAccessor = get;

        this.dataService.updateInfo();

        this.changeDetectorRef.markForCheck();

        // An edit request that named a platform before the platforms were known
        // could not be resolved then. Re-evaluated here rather than discarded,
        // which is what the request-keyed guard makes safe.
        this.applyQueryParams();
      });
  }

  private openCreatePlatformDialog() {
    const dialogRef = this.dialog.open<
      GfCreateOrUpdatePlatformDialogComponent,
      CreateOrUpdatePlatformDialogParams
    >(GfCreateOrUpdatePlatformDialogComponent, {
      data: {
        platform: {
          id: null,
          name: null,
          url: null
        }
      },
      height: this.deviceType === 'mobile' ? '98vh' : undefined,
      width: this.deviceType === 'mobile' ? '100vw' : '50rem'
    });

    dialogRef
      .afterClosed()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((platform: CreatePlatformDto | null) => {
        if (platform) {
          this.adminService
            .postPlatform(platform)
            .pipe(takeUntilDestroyed(this.destroyRef))
            .subscribe({
              next: () => {
                this.userService
                  .get(true)
                  .pipe(takeUntilDestroyed(this.destroyRef))
                  .subscribe();

                this.fetchPlatforms();
              }
            });
        }

        this.clearDialogQueryParams();
      });
  }

  private openUpdatePlatformDialog({
    id,
    name,
    url
  }: {
    id: string;
    name: string;
    url: string;
  }) {
    const dialogRef = this.dialog.open<
      GfCreateOrUpdatePlatformDialogComponent,
      CreateOrUpdatePlatformDialogParams
    >(GfCreateOrUpdatePlatformDialogComponent, {
      data: {
        platform: {
          id,
          name,
          url
        }
      },
      height: this.deviceType === 'mobile' ? '98vh' : undefined,
      width: this.deviceType === 'mobile' ? '100vw' : '50rem'
    });

    dialogRef
      .afterClosed()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((platform: UpdatePlatformDto | null) => {
        if (platform) {
          this.adminService
            .putPlatform(platform)
            .pipe(takeUntilDestroyed(this.destroyRef))
            .subscribe({
              next: () => {
                this.userService
                  .get(true)
                  .pipe(takeUntilDestroyed(this.destroyRef))
                  .subscribe();

                this.fetchPlatforms();
              }
            });
        }

        this.clearDialogQueryParams();
      });
  }
}
