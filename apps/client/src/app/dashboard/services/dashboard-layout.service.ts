import { UpdateUserDashboardLayoutDto } from '@ghostfolio/common/dtos';
import { UserDashboardLayout } from '@ghostfolio/common/interfaces';
import { DataService } from '@ghostfolio/ui/services';

import { DestroyRef, Injectable, OnDestroy } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ObservableStore } from '@codewithdan/observable-store';
import { Observable, Subject, of, throwError } from 'rxjs';
import { catchError, debounceTime, map, switchMap, tap } from 'rxjs/operators';

import { DashboardLayoutItem } from '../interfaces/interfaces';
import { DashboardLayoutStoreActions } from './dashboard-layout-store.actions';
import { DashboardLayoutStoreState } from './dashboard-layout-store.state';

@Injectable({
  providedIn: 'root'
})
export class GfDashboardLayoutService
  extends ObservableStore<DashboardLayoutStoreState>
  implements OnDestroy
{
  private hasPendingSnapshot = false;
  private pendingSnapshot: DashboardLayoutItem[] = null;
  private snapshot$ = new Subject<DashboardLayoutItem[]>();

  public constructor(
    private dataService: DataService,
    private destroyRef: DestroyRef
  ) {
    super({ trackStateHistory: true });

    this.setState(
      { layout: undefined },
      DashboardLayoutStoreActions.Initialize
    );

    this.snapshot$
      .pipe(
        tap((modules) => {
          this.pendingSnapshot = modules;
          this.hasPendingSnapshot = true;
        }),
        debounceTime(500),
        map((modules) => {
          this.hasPendingSnapshot = false;

          return this.createLayoutDto(modules);
        }),
        switchMap((dto) =>
          this.dataService.patchUserDashboardLayout(dto).pipe(
            catchError((error) => {
              console.error('Failed to persist the dashboard layout', error);

              return of(null);
            })
          )
        ),
        takeUntilDestroyed(this.destroyRef)
      )
      .subscribe((layout) => {
        if (layout) {
          this.setState(
            { layout },
            DashboardLayoutStoreActions.UpdateDashboardLayout
          );
        }
      });
  }

  public get(force = false): Observable<UserDashboardLayout | null> {
    const state = this.getState();

    if (state?.layout !== undefined && force !== true) {
      // Get from cache
      return of(state.layout);
    }

    // Get from endpoint
    return this.fetchLayout();
  }

  public ngOnDestroy() {
    this.flushPendingSnapshot();
  }

  public scheduleSave(modules: DashboardLayoutItem[]) {
    this.snapshot$.next(modules);
  }

  private createLayoutDto(
    modules: DashboardLayoutItem[]
  ): UpdateUserDashboardLayoutDto {
    return {
      modules: (modules ?? []).map(({ cols, moduleType, rows, x, y }) => ({
        cols,
        moduleType,
        rows,
        x,
        y
      })),
      version: 1
    };
  }

  private fetchLayout(): Observable<UserDashboardLayout | null> {
    return this.dataService.fetchUserDashboardLayout().pipe(
      map((layout) => {
        this.setState(
          { layout },
          DashboardLayoutStoreActions.GetDashboardLayout
        );

        return layout;
      }),
      catchError((error) => this.handleError(error))
    );
  }

  private flushPendingSnapshot() {
    if (!this.hasPendingSnapshot) {
      return;
    }

    const dto = this.createLayoutDto(this.pendingSnapshot);

    this.hasPendingSnapshot = false;
    this.pendingSnapshot = null;

    // Closing the browser tab inside the debounce is an accepted loss window.
    this.dataService.patchUserDashboardLayout(dto).subscribe({
      error: (error) => {
        console.error('Failed to flush the dashboard layout', error);
      }
    });
  }

  private handleError(error: unknown) {
    console.error('Failed to fetch the dashboard layout', error);

    return throwError(() => error);
  }
}
