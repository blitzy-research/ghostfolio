import { UserService } from '@ghostfolio/client/services/user/user.service';
import { CreateTagDto, UpdateTagDto } from '@ghostfolio/common/dtos';
import { ConfirmationDialogType } from '@ghostfolio/common/enums';
import { getLocale } from '@ghostfolio/common/helper';
import { NotificationService } from '@ghostfolio/ui/notifications';
import { DataService } from '@ghostfolio/ui/services';
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
import { Tag } from '@prisma/client';
import { addIcons } from 'ionicons';
import {
  createOutline,
  ellipsisHorizontal,
  trashOutline
} from 'ionicons/icons';
import { get } from 'lodash';
import { DeviceDetectorService } from 'ngx-device-detector';

import { GfCreateOrUpdateTagDialogComponent } from './create-or-update-tag-dialog/create-or-update-tag-dialog.component';
import { CreateOrUpdateTagDialogParams } from './create-or-update-tag-dialog/interfaces/interfaces';

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    GfValueComponent,
    IonIcon,
    MatButtonModule,
    MatMenuModule,
    MatSortModule,
    MatTableModule,
    RouterModule
  ],
  selector: 'gf-admin-tag',
  styleUrls: ['./admin-tag.component.scss'],
  templateUrl: './admin-tag.component.html'
})
export class GfAdminTagComponent implements OnInit {
  @Input() locale = getLocale();

  @ViewChild(MatSort) sort: MatSort;

  /**
   * The query parameters that ask this component for a blank create form.
   *
   * Bound by the template's control and reused by nothing else. The explicit nulls
   * are the point of it: an `editTagDialog` request may still be on the URL, and
   * because {@link applyQueryParams} tests `createTagDialog` first, merging without
   * clearing them would leave a stale edit request to open the moment the create
   * form was dismissed.
   */
  public readonly createDialogQueryParams = {
    createTagDialog: true,
    editTagDialog: null as boolean,
    tagId: null as string
  };

  public dataSource = new MatTableDataSource<Tag>();
  public deviceType: string;
  public displayedColumns = ['name', 'userId', 'activities', 'actions'];
  public tags: Tag[];

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

    this.applyQueryParams();

    this.fetchTags();
  }

  /**
   * Opens whatever the current query parameters ask for, once the device is known.
   *
   * Reached from three places - a parameter change, the device becoming known and
   * the tags arriving - because any of them can be the last one to arrive. That
   * makes idempotence a requirement rather than a nicety, and
   * {@link serveDialogRequest} is what provides it.
   */
  private applyQueryParams() {
    if (!this.deviceType) {
      return;
    }

    const { createTagDialog, editTagDialog, tagId } = this.queryParams ?? {};

    if (createTagDialog) {
      this.serveDialogRequest('createTagDialog', () => {
        this.openCreateTagDialog();
      });
    } else if (editTagDialog) {
      const tag = this.tags?.find(({ id }) => {
        return id === tagId;
      });

      // A tag that cannot be found is the only outcome besides opening the dialog.
      // Passing it on regardless would destructure `undefined` and throw, which is
      // what an `editTagDialog` naming a tag that has since been deleted would
      // otherwise produce.
      if (tag) {
        this.serveDialogRequest(`editTagDialog:${tag.id}`, () => {
          this.openUpdateTagDialog(tag);
        });
      } else if (this.tags) {
        // Only once the tags are known. Before that the request is one this
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
        createTagDialog: null,
        editTagDialog: null,
        tagId: null
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

  public onDeleteTag(aId: string) {
    this.notificationService.confirm({
      confirmFn: () => {
        this.deleteTag(aId);
      },
      confirmType: ConfirmationDialogType.Warn,
      title: $localize`Do you really want to delete this tag?`
    });
  }

  public onUpdateTag({ id }: Tag) {
    // `createTagDialog` is nulled because it is tested first, so a stale one would
    // open a blank form instead of this tag.
    void this.router.navigate([], {
      queryParams: {
        createTagDialog: null,
        editTagDialog: true,
        tagId: id
      },
      queryParamsHandling: 'merge',
      relativeTo: this.route
    });
  }

  private deleteTag(aId: string) {
    this.dataService
      .deleteTag(aId)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => {
          this.userService
            .get(true)
            .pipe(takeUntilDestroyed(this.destroyRef))
            .subscribe();

          this.fetchTags();
        }
      });
  }

  private fetchTags() {
    this.dataService
      .fetchTags()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((tags) => {
        this.tags = tags;

        this.dataSource = new MatTableDataSource(this.tags);
        this.dataSource.sort = this.sort;
        this.dataSource.sortingDataAccessor = get;

        this.dataService.updateInfo();

        this.changeDetectorRef.markForCheck();

        // An edit request that named a tag before the tags were known could not be
        // resolved then. Re-evaluated here rather than discarded, which is what the
        // request-keyed guard makes safe.
        this.applyQueryParams();
      });
  }

  private openCreateTagDialog() {
    const dialogRef = this.dialog.open<
      GfCreateOrUpdateTagDialogComponent,
      CreateOrUpdateTagDialogParams
    >(GfCreateOrUpdateTagDialogComponent, {
      data: {
        tag: {
          id: null,
          name: null
        }
      },
      height: this.deviceType === 'mobile' ? '98vh' : undefined,
      width: this.deviceType === 'mobile' ? '100vw' : '50rem'
    });

    dialogRef
      .afterClosed()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((tag: CreateTagDto | null) => {
        if (tag) {
          this.dataService
            .postTag(tag)
            .pipe(takeUntilDestroyed(this.destroyRef))
            .subscribe({
              next: () => {
                this.userService
                  .get(true)
                  .pipe(takeUntilDestroyed(this.destroyRef))
                  .subscribe();

                this.fetchTags();
              }
            });
        }

        this.clearDialogQueryParams();
      });
  }

  private openUpdateTagDialog({ id, name }: { id: string; name: string }) {
    const dialogRef = this.dialog.open<
      GfCreateOrUpdateTagDialogComponent,
      CreateOrUpdateTagDialogParams
    >(GfCreateOrUpdateTagDialogComponent, {
      data: {
        tag: {
          id,
          name
        }
      },
      height: this.deviceType === 'mobile' ? '98vh' : undefined,
      width: this.deviceType === 'mobile' ? '100vw' : '50rem'
    });

    dialogRef
      .afterClosed()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((tag: UpdateTagDto | null) => {
        if (tag) {
          this.dataService
            .putTag(tag)
            .pipe(takeUntilDestroyed(this.destroyRef))
            .subscribe({
              next: () => {
                this.userService
                  .get(true)
                  .pipe(takeUntilDestroyed(this.destroyRef))
                  .subscribe();

                this.fetchTags();
              }
            });
        }

        this.clearDialogQueryParams();
      });
  }
}
