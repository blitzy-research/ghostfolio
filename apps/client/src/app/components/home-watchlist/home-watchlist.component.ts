import { ImpersonationStorageService } from '@ghostfolio/client/services/impersonation-storage.service';
import { UserService } from '@ghostfolio/client/services/user/user.service';
import { locale as defaultLocale } from '@ghostfolio/common/config';
import { DashboardModuleType } from '@ghostfolio/common/dashboard';
import { reportSanitizedError } from '@ghostfolio/common/helper';
import {
  AssetProfileIdentifier,
  Benchmark,
  User
} from '@ghostfolio/common/interfaces';
import { hasPermission, permissions } from '@ghostfolio/common/permissions';
import { GfBenchmarkComponent } from '@ghostfolio/ui/benchmark';
import { GfPremiumIndicatorComponent } from '@ghostfolio/ui/premium-indicator';
import { DataService } from '@ghostfolio/ui/services';

import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  computed,
  CUSTOM_ELEMENTS_SCHEMA,
  DestroyRef,
  inject,
  OnInit
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { MatButtonModule } from '@angular/material/button';
import { MatDialog } from '@angular/material/dialog';
import { ActivatedRoute, Router, RouterModule } from '@angular/router';
import { IonIcon } from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import { addOutline } from 'ionicons/icons';
import { DeviceDetectorService } from 'ngx-device-detector';

import { GfCreateWatchlistItemDialogComponent } from './create-watchlist-item-dialog/create-watchlist-item-dialog.component';
import { CreateWatchlistItemDialogParams } from './create-watchlist-item-dialog/interfaces/interfaces';

/**
 * The stable event identifier a failed watchlist read is reported under.
 *
 * Fixed so it stays searchable, and carrying the reason only - never the response -
 * because a watchlist is the viewer's own.
 */
const WATCHLIST_FETCH_FAILED_EVENT = 'GF-WATCHLIST-FETCH-FAILED';

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    GfBenchmarkComponent,
    GfPremiumIndicatorComponent,
    IonIcon,
    MatButtonModule,
    RouterModule
  ],
  schemas: [CUSTOM_ELEMENTS_SCHEMA],
  selector: 'gf-home-watchlist',
  styleUrls: ['./home-watchlist.scss'],
  templateUrl: './home-watchlist.html'
})
export class GfHomeWatchlistComponent implements OnInit {
  /**
   * The module this component stands for, passed to the benchmark table so that its
   * detail dialog request names an owner.
   *
   * The benchmark table is mounted by three modules and all three can be on the
   * canvas at once, all three observe the same query parameters, and
   * `benchmarkDetailDialog` said nothing about which of them a request was for - so
   * one click opened the dialog up to three times over.
   */
  public readonly benchmarkDialogModule = DashboardModuleType.WATCHLIST;

  /**
   * The query parameters that ask this module for the create-watchlist-item form.
   *
   * Bound by the floating action button in this component's template. Merged rather
   * than replacing the whole map, which discarded every parameter the rest of the
   * canvas had put there.
   */
  protected readonly createDialogQueryParams = {
    createWatchlistItemDialog: true
  };

  protected hasImpersonationId: boolean;
  protected hasPermissionToCreateWatchlistItem: boolean;
  protected hasPermissionToDeleteWatchlistItem: boolean;
  protected user: User;
  /**
   * Whether the watchlist could not be read.
   *
   * Needed because the table below draws its skeletons from the list being
   * undefined, which is indistinguishable from a read that failed - so a failure
   * looked exactly like work still in progress, indefinitely.
   */
  protected hasError = false;

  protected watchlist: Benchmark[];

  protected readonly deviceType = computed(
    () => this.deviceDetectorService.deviceInfo().deviceType
  );

  private readonly changeDetectorRef = inject(ChangeDetectorRef);
  private readonly dataService = inject(DataService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly deviceDetectorService = inject(DeviceDetectorService);
  private readonly dialog = inject(MatDialog);
  private readonly impersonationStorageService = inject(
    ImpersonationStorageService
  );
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly userService = inject(UserService);

  /**
   * Whether the create-watchlist-item request has already been served.
   *
   * Every producer on the canvas merges rather than replaces its query parameters -
   * it has to, or it would drop a sibling module's and the shared-portfolio
   * identifier - so these parameters are re-observed whenever any *other* module
   * writes to the URL, and opening on every emission stacked a second copy of a
   * dialog that was already up. Keyed on the request rather than on the dialog's own
   * lifecycle, because the close handler removes the parameters through a navigation
   * that has not necessarily been applied yet.
   */
  private hasServedCreateDialogRequest = false;

  public constructor() {
    this.impersonationStorageService
      .onChangeHasImpersonation()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((impersonationId) => {
        this.hasImpersonationId = !!impersonationId;
      });

    this.route.queryParams
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((params) => {
        const isRequested = !!params['createWatchlistItemDialog'];

        if (this.hasServedCreateDialogRequest === isRequested) {
          return;
        }

        this.hasServedCreateDialogRequest = isRequested;

        if (isRequested) {
          this.openCreateWatchlistItemDialog();
        }
      });

    this.userService.stateChanged
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((state) => {
        if (state?.user) {
          this.user = state.user;

          this.hasPermissionToCreateWatchlistItem =
            !this.hasImpersonationId &&
            hasPermission(
              this.user.permissions,
              permissions.createWatchlistItem
            );
          this.hasPermissionToDeleteWatchlistItem =
            !this.hasImpersonationId &&
            hasPermission(
              this.user.permissions,
              permissions.deleteWatchlistItem
            );

          this.changeDetectorRef.markForCheck();
        }
      });

    addIcons({ addOutline });
  }

  public ngOnInit() {
    this.loadWatchlistData();
  }

  /**
   * Reads the watchlist again.
   *
   * The same call the module makes on arrival, so a viewer whose read failed can
   * recover in place rather than removing the module and adding it back.
   */
  protected onRetry() {
    this.loadWatchlistData();
  }

  protected onWatchlistItemDeleted({
    dataSource,
    symbol
  }: AssetProfileIdentifier) {
    this.dataService
      .deleteWatchlistItem({ dataSource, symbol })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => {
          return this.loadWatchlistData();
        }
      });
  }

  private loadWatchlistData() {
    this.hasError = false;

    this.dataService
      .fetchWatchlist()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        error: (error: unknown) => {
          // The read had no failure handler, so a rejection left `watchlist`
          // undefined - and the table beneath draws its skeleton rows from exactly
          // that, so the module went on looking like it was loading for as long as it
          // stayed on the canvas, with nothing said and nothing to press.
          this.hasError = true;

          reportSanitizedError(WATCHLIST_FETCH_FAILED_EVENT, error);

          this.changeDetectorRef.markForCheck();
        },
        next: ({ watchlist }) => {
          this.watchlist = watchlist;

          this.changeDetectorRef.markForCheck();
        }
      });
  }

  private openCreateWatchlistItemDialog() {
    this.userService
      .get()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((user) => {
        this.user = user;

        const dialogRef = this.dialog.open<
          GfCreateWatchlistItemDialogComponent,
          CreateWatchlistItemDialogParams
        >(GfCreateWatchlistItemDialogComponent, {
          autoFocus: false,
          data: {
            deviceType: this.deviceType(),
            // The list the dialog checks a repeat against, so it can say the symbol
            // is already watched without asking a server that would accept the
            // duplicate silently.
            existingItems: (this.watchlist ?? []).map(
              ({ dataSource, symbol }) => {
                return { dataSource, symbol };
              }
            ),
            locale: this.user?.settings?.locale ?? defaultLocale
          },
          width: this.deviceType() === 'mobile' ? '100vw' : '50rem'
        });

        dialogRef
          .afterClosed()
          .pipe(takeUntilDestroyed(this.destroyRef))
          .subscribe((created) => {
            // The dialog OWNS the create now, and closes with a result only once it
            // succeeded. The request used to be issued from here, after the dialog
            // had already gone: a rejection had nowhere to be reported, the symbol
            // the viewer had searched for was discarded with the dialog, and the
            // watchlist just looked unchanged. All that is left here is to re-read
            // the list the dialog has already added to.
            if (created) {
              this.loadWatchlistData();
            }

            // Removes the parameter this dialog travelled on, and only that one.
            // The `navigate(['.'])` this replaced named a route segment instead,
            // which dropped every query parameter on the canvas: closing this
            // dialog also closed a sibling module's and discarded the
            // shared-portfolio access identifier along with it.
            void this.router.navigate([], {
              queryParams: { createWatchlistItemDialog: null },
              queryParamsHandling: 'merge',
              relativeTo: this.route
            });
          });
      });
  }
}
