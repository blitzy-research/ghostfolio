import type { GfAppQueryParams } from '@ghostfolio/client/interfaces/interfaces';
import { IcsService } from '@ghostfolio/client/services/ics/ics.service';
import { ImpersonationStorageService } from '@ghostfolio/client/services/impersonation-storage.service';
import { UserService } from '@ghostfolio/client/services/user/user.service';
import { DEFAULT_PAGE_SIZE } from '@ghostfolio/common/config';
import { DashboardModuleType } from '@ghostfolio/common/dashboard';
import { CreateOrderDto, UpdateOrderDto } from '@ghostfolio/common/dtos';
import { downloadAsFile } from '@ghostfolio/common/helper';
import {
  Activity,
  AssetProfileIdentifier,
  User
} from '@ghostfolio/common/interfaces';
import { hasPermission, permissions } from '@ghostfolio/common/permissions';
import { DateRange } from '@ghostfolio/common/types';
import { GfActivitiesTableComponent } from '@ghostfolio/ui/activities-table';
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
import { PageEvent } from '@angular/material/paginator';
import { MatSnackBarModule } from '@angular/material/snack-bar';
import { Sort, SortDirection } from '@angular/material/sort';
import { MatTableDataSource } from '@angular/material/table';
import { ActivatedRoute, Router, RouterModule } from '@angular/router';
import { IonIcon } from '@ionic/angular/standalone';
import { format, parseISO } from 'date-fns';
import { addIcons } from 'ionicons';
import { addOutline } from 'ionicons/icons';
import { DeviceDetectorService } from 'ngx-device-detector';
import { Subscription } from 'rxjs';

import { GfCreateOrUpdateActivityDialogComponent } from './create-or-update-activity-dialog/create-or-update-activity-dialog.component';
import { CreateOrUpdateActivityDialogParams } from './create-or-update-activity-dialog/interfaces/interfaces';
import { GfImportActivitiesDialogComponent } from './import-activities-dialog/import-activities-dialog.component';
import { ImportActivitiesDialogParams } from './import-activities-dialog/interfaces/interfaces';

@Component({
  host: { class: 'has-fab' },
  imports: [
    GfActivitiesTableComponent,
    IonIcon,
    MatButtonModule,
    MatSnackBarModule,
    RouterModule
  ],
  selector: 'gf-activities',
  styleUrls: ['./activities.scss'],
  templateUrl: './activities.html'
})
export class GfActivitiesComponent implements OnInit {
  public activityTypesFilter: string[] = [];
  public dataSource: MatTableDataSource<Activity>;
  public deviceType: string;
  /**
   * The query parameters that ask this module for a blank create form.
   *
   * Shared by the floating action button in this component's template and by
   * {@link onCreateActivity}, so the two controls that mean the same thing cannot
   * drift apart. The explicit nulls are the point of it: `activityId` and
   * `editDialog` may already be on the URL from an edit request, and because
   * {@link applyQueryParams} tests `createDialog` first, merging without clearing
   * them opened a create form pre-filled from the activity being edited.
   */
  public readonly createDialogQueryParams = {
    activityId: null as string,
    createDialog: true,
    dialogModule: DashboardModuleType.ACTIVITIES,
    editDialog: null as boolean
  };

  public hasImpersonationId: boolean;
  public hasPermissionToCreateActivity: boolean;
  public hasPermissionToDeleteActivity: boolean;
  public pageIndex = 0;
  public pageSize = DEFAULT_PAGE_SIZE;
  public routeQueryParams: Subscription;
  public sortColumn = 'date';
  public sortDirection: SortDirection = 'desc';
  public totalItems: number | undefined;
  public user: User;

  /**
   * The dialog request this module has already served, or `null` for none.
   *
   * Kept so that being told the same thing more than once opens one dialog - see
   * {@link applyQueryParams} for why that happens. Reset by the query parameters
   * ceasing to ask for anything rather than by a dialog closing - see
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
    private icsService: IcsService,
    private impersonationStorageService: ImpersonationStorageService,
    private route: ActivatedRoute,
    private router: Router,
    private userService: UserService
  ) {
    // Recorded rather than acted on. Every dialog this module opens is sized from
    // `deviceType` and filled from `user`, and both are resolved in `ngOnInit` -
    // which runs *after* this. On the route-per-screen shell that never mattered,
    // because a screen was constructed by a navigation that had already happened
    // and its parameters arrived afterwards. On one canvas a module is
    // materialised lazily *in response to* a request that is already on the URL,
    // so `queryParams` delivers its current value here, in the constructor,
    // before any of those prerequisites exist. Acting on it then produced a
    // dialog laid out for the wrong device and handed `user: undefined`, which
    // left the account and currency selectors of an edit form empty.
    this.routeQueryParams = this.route.queryParams
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

        // The permissions this module gates its dialogs on are withdrawn while
        // impersonating, so they are recomputed here rather than only when the
        // viewer changes.
        if (this.user) {
          this.updateUser(this.user);
        }

        this.applyQueryParams();
      });

    this.userService.stateChanged
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((state) => {
        if (state?.user) {
          this.updateUser(state.user);

          this.fetchActivities();

          this.changeDetectorRef.markForCheck();

          this.applyQueryParams();
        }
      });

    // Re-evaluated once the device is known, so a request that was already on the
    // URL when this module was created is honoured now that it can be honoured
    // correctly.
    this.applyQueryParams();
  }

  public fetchActivities() {
    this.dataSource = undefined;
    this.totalItems = undefined;

    const dateRange = this.user?.settings?.dateRange;
    const range = this.isCalendarYear(dateRange) ? dateRange : undefined;

    this.dataService
      .fetchActivities({
        range,
        activityTypes: this.activityTypesFilter.length
          ? this.activityTypesFilter
          : undefined,
        filters: this.userService.getFilters(),
        skip: this.pageIndex * this.pageSize,
        sortColumn: this.sortColumn,
        sortDirection: this.sortDirection,
        take: this.pageSize
      })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(({ activities, count }) => {
        this.dataSource = new MatTableDataSource(activities);
        this.totalItems = count;

        // Nothing opens a dialog from here, and the omission is the point.
        //
        // A viewer with no activities used to have the create dialog opened for
        // them at the end of this fetch. On the route-per-screen shell that was a
        // helpful shortcut: the activities screen was the only thing on it, the
        // viewer had deliberately navigated there, and the form they were obviously
        // after appeared. On one canvas the same code is an ambush. This module is
        // one card among many that all load at once, nobody asked for it in
        // particular, and the dialog it opened dimmed and blocked the entire canvas
        // behind a full-viewport scrim - measured at 1440x900 as a 100% scrim over
        // an 800x720 panel, with every other module unreachable behind it. The
        // accounts module makes the same offer for the same viewer at the same
        // moment, so which response arrived first decided whether one onboarding
        // dialog appeared or two appeared stacked - an outcome the previous shell
        // could not produce.
        //
        // Nor was it a one-off: the fetch runs on every load, so the modal returned
        // on every visit, measured re-appearing 847 ms into a reload of a URL
        // carrying no parameters at all, because the component re-created them
        // itself. A viewer who had not yet recorded a first activity could not reach
        // their own dashboard without dismissing a form first.
        //
        // The invitation is not lost, only made voluntary: the table still renders
        // its "add your first activity" call to action for exactly this viewer,
        // reaching {@link onCreateActivity}, and the module still carries its
        // floating add button. Both route through the same query-parameter intent
        // this used to fire unbidden, so the dialog is one click away - opened when
        // it is asked for, which is what the call below serves.
        this.applyQueryParams();
        this.changeDetectorRef.markForCheck();
      });
  }

  public onChangePage(page: PageEvent) {
    this.pageIndex = page.pageIndex;

    this.fetchActivities();
  }

  public onClickActivity({ dataSource, symbol }: AssetProfileIdentifier) {
    // No discriminator: the holding detail dialog is opened by the application
    // shell rather than by any module, so its parameters name themselves and are
    // deliberately global.
    //
    // Two nulls are still required, because merging obliges a producer to null what
    // it takes over. `dataSource` and `symbol` are shared identifiers read by three
    // different flags, the other two belonging to the market data administration
    // module and to the benchmark table, so leaving either up would re-point *their*
    // dialog at this holding rather than merely leaving it alone.
    void this.router.navigate([], {
      queryParams: {
        dataSource,
        symbol,
        assetProfileDialog: null,
        benchmarkDetailDialog: null,
        holdingDetailDialog: true
      },
      queryParamsHandling: 'merge',
      relativeTo: this.route
    });
  }

  public onCloneActivity(aActivity: Activity) {
    this.openCreateActivityDialog(aActivity);
  }

  /**
   * Opens the create-activity dialog on behalf of the empty-state call to
   * action rendered by the activities table.
   *
   * That control used to be an anchor carrying its own router link. It now
   * raises an output instead, which the table bubbles up as
   * `createActivityClicked`, so the intent has to be turned back into the
   * dialog request here — without this handler the button is inert.
   *
   * The payload is deliberately identical to the floating action button's in this
   * component's own template, and it merges while explicitly nulling the two keys
   * that would otherwise make the form arrive filled in: `activityId`, because a
   * blank form is the only thing this control can mean, and `editDialog`, because
   * leaving both flags up would make the outcome depend on which one
   * {@link applyQueryParams} happens to test first.
   *
   * Merging rather than replacing is what keeps the clear that narrow. Replacing
   * the whole map would also discard the shared-portfolio access identifier, the
   * sign-in token hand-off and every sibling module's dialog state, none of which
   * this control has any business touching.
   */
  public onCreateActivity() {
    void this.router.navigate([], {
      queryParams: this.createDialogQueryParams,
      queryParamsHandling: 'merge',
      relativeTo: this.route
    });
  }

  public onDeleteActivities() {
    this.dataService
      .deleteActivities({
        filters: this.userService.getFilters()
      })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => {
        this.userService
          .get(true)
          .pipe(takeUntilDestroyed(this.destroyRef))
          .subscribe();

        this.fetchActivities();

        this.changeDetectorRef.markForCheck();
      });
  }

  public onDeleteActivity(aId: string) {
    this.dataService
      .deleteActivity(aId)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => {
        this.userService
          .get(true)
          .pipe(takeUntilDestroyed(this.destroyRef))
          .subscribe();

        this.fetchActivities();

        this.changeDetectorRef.markForCheck();
      });
  }

  public onExport(activityIds?: string[]) {
    let fetchExportParams: any = { activityIds };

    if (!activityIds) {
      fetchExportParams = {
        activityTypes: this.activityTypesFilter.length
          ? this.activityTypesFilter
          : undefined,
        filters: this.userService.getFilters()
      };
    }

    this.dataService
      .fetchExport(fetchExportParams)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((data) => {
        for (const activity of data.activities) {
          delete activity.id;
        }

        downloadAsFile({
          content: data,
          fileName: `ghostfolio-export-${format(
            parseISO(data.meta.date),
            'yyyyMMddHHmm'
          )}.json`,
          format: 'json'
        });
      });
  }

  public onExportDrafts(activityIds?: string[]) {
    this.dataService
      .fetchExport({ activityIds })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((data) => {
        downloadAsFile({
          content: this.icsService.transformActivitiesToIcsContent(
            data.activities
          ),
          contentType: 'text/calendar',
          fileName: `ghostfolio-draft${
            data.activities.length > 1 ? 's' : ''
          }-${format(parseISO(data.meta.date), 'yyyyMMddHHmmss')}.ics`,
          format: 'string'
        });
      });
  }

  public onImport() {
    const dialogRef = this.dialog.open<
      GfImportActivitiesDialogComponent,
      ImportActivitiesDialogParams
    >(GfImportActivitiesDialogComponent, {
      data: {
        deviceType: this.deviceType,
        user: this.user
      },
      height: this.deviceType === 'mobile' ? '98vh' : undefined,
      width: this.deviceType === 'mobile' ? '100vw' : '50rem'
    });

    dialogRef
      .afterClosed()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => {
        this.userService
          .get(true)
          .pipe(takeUntilDestroyed(this.destroyRef))
          .subscribe();

        this.fetchActivities();

        this.changeDetectorRef.markForCheck();
      });
  }

  public onImportDividends() {
    const dialogRef = this.dialog.open<
      GfImportActivitiesDialogComponent,
      ImportActivitiesDialogParams
    >(GfImportActivitiesDialogComponent, {
      data: {
        activityTypes: ['DIVIDEND'],
        deviceType: this.deviceType,
        user: this.user
      },
      height: this.deviceType === 'mobile' ? '98vh' : undefined,
      width: this.deviceType === 'mobile' ? '100vw' : '50rem'
    });

    dialogRef
      .afterClosed()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => {
        this.userService
          .get(true)
          .pipe(takeUntilDestroyed(this.destroyRef))
          .subscribe();

        this.fetchActivities();

        this.changeDetectorRef.markForCheck();
      });
  }

  public onSortChanged({ active, direction }: Sort) {
    this.pageIndex = 0;
    this.sortColumn = active;
    this.sortDirection = direction;

    this.fetchActivities();
  }

  public onTypesFilterChanged(aTypes: string[]) {
    this.activityTypesFilter = aTypes;
    this.pageIndex = 0;

    this.fetchActivities();
  }

  public onUpdateActivity(aActivity: Activity) {
    void this.router.navigate([], {
      queryParams: {
        activityId: aActivity.id,
        dialogModule: DashboardModuleType.ACTIVITIES,
        editDialog: true
      },
      queryParamsHandling: 'merge',
      relativeTo: this.route
    });
  }

  public openUpdateActivityDialog(aActivity: Activity) {
    const dialogRef = this.dialog.open<
      GfCreateOrUpdateActivityDialogComponent,
      CreateOrUpdateActivityDialogParams
    >(GfCreateOrUpdateActivityDialogComponent, {
      data: {
        activity: aActivity,
        accounts: this.user?.accounts,
        user: this.user
      },
      height: this.deviceType === 'mobile' ? '98vh' : '80vh',
      width: this.deviceType === 'mobile' ? '100vw' : '50rem'
    });

    dialogRef
      .afterClosed()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((activity: UpdateOrderDto) => {
        if (activity) {
          this.dataService
            .putActivity(activity)
            .pipe(takeUntilDestroyed(this.destroyRef))
            .subscribe({
              next: () => {
                this.fetchActivities();

                this.changeDetectorRef.markForCheck();
              }
            });
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
   */
  private applyQueryParams() {
    if (!this.deviceType || !this.user) {
      return;
    }

    const { activityId, createDialog, dialogModule, editDialog } =
      this.queryParams ?? {};

    // On the single-canvas shell every module observes the same query
    // parameters at once, so `createDialog` and `editDialog` carry no
    // indication of who they were meant for. `dialogModule` does, and
    // testing it first makes this handler fail-safe: an unqualified
    // or foreign-qualified flag - the accounts module's floating action
    // button, or the account-access module's edit link - opens nothing
    // here. See the same gate in
    // `components/user-account-access/user-account-access.component.ts`.
    //
    // Not addressed here is treated as *nothing requested* rather than returned
    // on, so that the final branch still forgets what was last served. Returning
    // early left the record standing, which meant a viewer who closed a dialog and
    // asked for the same one again was ignored.
    const isAddressed = dialogModule === DashboardModuleType.ACTIVITIES;

    if (isAddressed && createDialog) {
      if (activityId) {
        this.serveDialogRequest(`createDialog:${activityId}`, () => {
          this.dataService
            .fetchActivity(activityId)
            .pipe(takeUntilDestroyed(this.destroyRef))
            .subscribe((activity) => {
              this.openCreateActivityDialog(activity);
            });
        });
      } else {
        this.serveDialogRequest('createDialog', () => {
          this.openCreateActivityDialog();
        });
      }
    } else if (isAddressed && editDialog) {
      if (activityId) {
        this.serveDialogRequest(`editDialog:${activityId}`, () => {
          this.dataService
            .fetchActivity(activityId)
            .pipe(takeUntilDestroyed(this.destroyRef))
            .subscribe((activity) => {
              this.openUpdateActivityDialog(activity);
            });
        });
      } else {
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
   * dropping them all would close a sibling module's dialog, and would discard
   * the shared-portfolio access identifier, as a side effect of closing this
   * one's. `dialogModule` is cleared with them because this module only ever
   * opens a dialog while that discriminator names it.
   */
  private clearDialogQueryParams() {
    void this.router.navigate([], {
      queryParams: {
        activityId: null,
        createDialog: null,
        dialogModule: null,
        editDialog: null
      },
      queryParamsHandling: 'merge',
      relativeTo: this.route
    });
  }

  private isCalendarYear(dateRange: DateRange) {
    if (!dateRange) {
      return false;
    }

    return /^\d{4}$/.test(dateRange);
  }

  private openCreateActivityDialog(aActivity?: Activity) {
    this.userService
      .get()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((user) => {
        this.updateUser(user);

        const dialogRef = this.dialog.open<
          GfCreateOrUpdateActivityDialogComponent,
          CreateOrUpdateActivityDialogParams
        >(GfCreateOrUpdateActivityDialogComponent, {
          data: {
            accounts: this.user?.accounts,
            activity: {
              ...aActivity,
              accountId: aActivity?.accountId,
              date: new Date(),
              id: null,
              fee: 0,
              type: aActivity?.type ?? 'BUY',
              unitPrice: null
            },
            user: this.user
          },
          height: this.deviceType === 'mobile' ? '98vh' : '80vh',
          width: this.deviceType === 'mobile' ? '100vw' : '50rem'
        });

        dialogRef
          .afterClosed()
          .pipe(takeUntilDestroyed(this.destroyRef))
          .subscribe((transaction: CreateOrderDto | null) => {
            if (transaction) {
              this.dataService.postActivity(transaction).subscribe({
                next: () => {
                  this.userService
                    .get(true)
                    .pipe(takeUntilDestroyed(this.destroyRef))
                    .subscribe();

                  this.fetchActivities();

                  this.changeDetectorRef.markForCheck();
                }
              });
            }

            this.clearDialogQueryParams();
          });
      });
  }

  /**
   * Opens a dialog unless the same request has already been served.
   *
   * The request the URL is making - not the dialog's own lifecycle - is what this
   * is keyed on, and that is the whole point. `applyQueryParams` is reached from
   * five places, and one of them is `fetchActivities`, which every close handler
   * calls; keying on the dialog instead would let a close re-open the dialog that
   * had just closed, because the parameters asking for it are removed by a
   * navigation that has not necessarily been applied yet.
   *
   * The address is what makes this precise rather than merely a lock: asking to
   * edit a *different* activity while an edit form is open is a genuine second
   * request and is honoured, while being re-notified about the one already served
   * is not.
   */
  private serveDialogRequest(aAddress: string, aOpen?: () => void) {
    if (this.openedDialogAddress === aAddress) {
      return;
    }

    this.openedDialogAddress = aAddress;

    aOpen?.();
  }

  private updateUser(aUser: User) {
    this.user = aUser;

    this.hasPermissionToCreateActivity =
      !this.hasImpersonationId &&
      hasPermission(this.user.permissions, permissions.createActivity);
    this.hasPermissionToDeleteActivity =
      !this.hasImpersonationId &&
      hasPermission(this.user.permissions, permissions.deleteActivity);
  }
}
