import { TokenStorageService } from '@ghostfolio/client/services/token-storage.service';
import { UserService } from '@ghostfolio/client/services/user/user.service';
import {
  BULL_BOARD_COOKIE_NAME,
  BULL_BOARD_ROUTE,
  DATA_GATHERING_QUEUE_PRIORITY_HIGH,
  DATA_GATHERING_QUEUE_PRIORITY_LOW,
  DATA_GATHERING_QUEUE_PRIORITY_MEDIUM,
  QUEUE_JOB_STATUS_LIST
} from '@ghostfolio/common/config';
import {
  getDateWithTimeFormatString,
  reportSanitizedError
} from '@ghostfolio/common/helper';
import { AdminJobs, User } from '@ghostfolio/common/interfaces';
import { hasPermission, permissions } from '@ghostfolio/common/permissions';
import { NotificationService } from '@ghostfolio/ui/notifications';
import { AdminService } from '@ghostfolio/ui/services';

import { CommonModule } from '@angular/common';
import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  DestroyRef,
  inject,
  OnInit,
  viewChild
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import {
  FormControl,
  FormGroup,
  FormsModule,
  ReactiveFormsModule
} from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatMenuModule } from '@angular/material/menu';
import { MatSelectModule } from '@angular/material/select';
import { MatSort, MatSortModule } from '@angular/material/sort';
import { MatTableDataSource, MatTableModule } from '@angular/material/table';
import { IonIcon } from '@ionic/angular/standalone';
import { JobStatus } from 'bull';
import { addIcons } from 'ionicons';
import {
  alertCircleOutline,
  cafeOutline,
  checkmarkCircleOutline,
  chevronDownCircleOutline,
  chevronUpCircleOutline,
  ellipsisHorizontal,
  ellipsisVertical,
  openOutline,
  pauseOutline,
  playOutline,
  removeCircleOutline,
  timeOutline
} from 'ionicons/icons';
import { get } from 'lodash';
import { NgxSkeletonLoaderModule } from 'ngx-skeleton-loader';

/**
 * The stable event identifier a failed queue read is reported under.
 *
 * Fixed so it stays searchable, and carrying the reason only - never the response -
 * because a queue payload names the symbols a deployment is gathering.
 */
const ADMIN_JOBS_FETCH_FAILED_EVENT = 'GF-ADMIN-JOBS-FETCH-FAILED';

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    CommonModule,
    FormsModule,
    IonIcon,
    MatButtonModule,
    MatMenuModule,
    MatSelectModule,
    MatSortModule,
    MatTableModule,
    NgxSkeletonLoaderModule,
    ReactiveFormsModule
  ],
  selector: 'gf-admin-jobs',
  styleUrls: ['./admin-jobs.scss'],
  templateUrl: './admin-jobs.html'
})
export class GfAdminJobsComponent implements OnInit {
  protected readonly sort = viewChild.required(MatSort);

  protected readonly DATA_GATHERING_QUEUE_PRIORITY_HIGH =
    DATA_GATHERING_QUEUE_PRIORITY_HIGH;

  protected readonly DATA_GATHERING_QUEUE_PRIORITY_LOW =
    DATA_GATHERING_QUEUE_PRIORITY_LOW;

  protected readonly DATA_GATHERING_QUEUE_PRIORITY_MEDIUM =
    DATA_GATHERING_QUEUE_PRIORITY_MEDIUM;

  protected dataSource = new MatTableDataSource<AdminJobs['jobs'][0]>();
  protected defaultDateTimeFormat: string;

  protected readonly filterForm = new FormGroup({
    status: new FormControl<JobStatus | null>(null)
  });

  protected readonly displayedColumns = [
    'index',
    'type',
    'symbol',
    'dataSource',
    'priority',
    'attempts',
    'created',
    'finished',
    'status',
    'actions'
  ];

  /**
   * Whether the queue could not be read.
   *
   * Needed because the skeleton below is drawn from `isLoading`, and the read used to
   * have no failure handler at all - so a rejection left the flag raised and the
   * screen went on animating a row that was never going to arrive, for as long as the
   * module stayed on the canvas. The only trace was whatever global notice the
   * response happened to earn, six seconds of it, with nothing on the screen to press
   * afterwards.
   */
  protected hasError = false;

  protected hasPermissionToAccessBullBoard = false;
  protected isLoading = false;
  protected readonly statusFilterOptions = QUEUE_JOB_STATUS_LIST;

  private user: User;

  private readonly adminService = inject(AdminService);
  private readonly changeDetectorRef = inject(ChangeDetectorRef);
  private readonly destroyRef = inject(DestroyRef);
  private readonly notificationService = inject(NotificationService);
  private readonly tokenStorageService = inject(TokenStorageService);
  private readonly userService = inject(UserService);

  public constructor() {
    this.userService.stateChanged
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((state) => {
        if (state?.user) {
          this.user = state.user;

          this.defaultDateTimeFormat = getDateWithTimeFormatString(
            this.user.settings.locale
          );

          this.hasPermissionToAccessBullBoard = hasPermission(
            this.user.permissions,
            permissions.accessAdminControlBullBoard
          );
        }
      });

    addIcons({
      alertCircleOutline,
      cafeOutline,
      checkmarkCircleOutline,
      chevronDownCircleOutline,
      chevronUpCircleOutline,
      ellipsisHorizontal,
      ellipsisVertical,
      openOutline,
      pauseOutline,
      playOutline,
      removeCircleOutline,
      timeOutline
    });
  }

  public ngOnInit() {
    this.filterForm.valueChanges
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => {
        const currentFilter = this.filterForm.controls.status.value;
        this.fetchJobs(currentFilter ? [currentFilter] : undefined);
      });

    this.fetchJobs();
  }

  protected onDeleteJob(aId: string) {
    this.adminService
      .deleteJob(aId)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        // Re-read on either outcome. A refused delete leaves the row exactly as it
        // was, which is indistinguishable from a delete that worked and a table that
        // has not caught up - so the table is refreshed from the server rather than
        // left to imply an outcome it does not know.
        error: () => {
          this.fetchJobs();
        },
        next: () => {
          this.fetchJobs();
        }
      });
  }

  protected onDeleteJobs() {
    const currentFilter = this.filterForm.controls.status.value;

    this.adminService
      .deleteJobs({ status: currentFilter ? [currentFilter] : [] })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        // See `onDeleteJob`: the table is refreshed either way, because a partially
        // applied bulk delete is exactly the case where the screen must not be left
        // guessing.
        error: () => {
          this.fetchJobs(currentFilter ? [currentFilter] : undefined);
        },
        next: () => {
          this.fetchJobs(currentFilter ? [currentFilter] : undefined);
        }
      });
  }

  protected onExecuteJob(aId: string) {
    this.adminService
      .executeJob(aId)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        // See `onDeleteJob`. A refused execute is the one that matters most here,
        // because the job's status is the whole reason the control was pressed.
        error: () => {
          this.fetchJobs();
        },
        next: () => {
          this.fetchJobs();
        }
      });
  }

  protected onOpenBullBoard() {
    const token = this.tokenStorageService.getToken();

    document.cookie = [
      `${BULL_BOARD_COOKIE_NAME}=${encodeURIComponent(token)}`,
      'path=/',
      'SameSite=Strict'
    ].join('; ');

    window.open(BULL_BOARD_ROUTE, '_blank');
  }

  /**
   * Shows one job's payload.
   *
   * The serialised structure is the MESSAGE. As a heading it grew the dialog to
   * whatever height the payload needed and pushed the close button off the bottom
   * of the viewport, where a pointer cannot reach it; as the message it is bounded
   * and scrolls inside the dialog, and the heading now says what is being shown.
   */
  protected onViewData(aData: AdminJobs['jobs'][0]['data']) {
    this.notificationService.alert({
      message: JSON.stringify(aData, null, '  '),
      title: $localize`Data`
    });
  }

  /**
   * Shows one job's stack trace. See `onViewData`: a stack trace is the longest
   * thing this screen displays, so it is the message rather than the heading.
   */
  protected onViewStacktrace(aStacktrace: AdminJobs['jobs'][0]['stacktrace']) {
    this.notificationService.alert({
      message: JSON.stringify(aStacktrace, null, '  '),
      title: $localize`Stacktrace`
    });
  }

  /**
   * Reads the queue again, keeping whichever status filter is applied.
   *
   * The filter is re-read rather than remembered so a retry answers the question the
   * viewer is currently asking, not the one they asked when the failure happened.
   */
  protected onRetry() {
    const currentFilter = this.filterForm.controls.status.value;

    this.fetchJobs(currentFilter ? [currentFilter] : undefined);
  }

  private fetchJobs(aStatus?: JobStatus[]) {
    this.hasError = false;
    this.isLoading = true;

    this.adminService
      .fetchJobs({ status: aStatus })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        error: (error: unknown) => {
          // Lowered on this path too, which is the fix: the flag is what draws the
          // skeleton, so leaving it raised is what turned a failed read into a screen
          // that looked busy forever.
          this.hasError = true;
          this.isLoading = false;

          reportSanitizedError(ADMIN_JOBS_FETCH_FAILED_EVENT, error);

          this.changeDetectorRef.markForCheck();
        },
        next: ({ jobs }) => {
          this.dataSource = new MatTableDataSource(jobs);
          this.dataSource.sort = this.sort();
          this.dataSource.sortingDataAccessor = get;

          this.isLoading = false;

          this.changeDetectorRef.markForCheck();
        }
      });
  }
}
