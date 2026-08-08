import { UserService } from '@ghostfolio/client/services/user/user.service';
import { DashboardModuleType } from '@ghostfolio/common/dashboard';
import { reportSanitizedError } from '@ghostfolio/common/helper';
import { hasPermission } from '@ghostfolio/common/permissions';

import { FocusKeyManager } from '@angular/cdk/a11y';
import {
  AfterViewInit,
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  DestroyRef,
  ElementRef,
  HostListener,
  Input,
  OnInit,
  QueryList,
  ViewChild,
  ViewChildren,
  output
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormControl, ReactiveFormsModule } from '@angular/forms';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import Fuse from 'fuse.js';
import { of } from 'rxjs';
import {
  debounceTime,
  distinctUntilChanged,
  map,
  switchMap
} from 'rxjs/operators';

import { DashboardModuleDefinition } from '../interfaces/interfaces';
import { GfModuleRegistryService } from '../module-registry.service';
import { GfModuleCatalogItemComponent } from './module-catalog-item/module-catalog-item.component';

/**
 * Searchable catalog of the dashboard modules a viewer is allowed to place. It
 * reports one thing outwards - that a module type was chosen - and everything
 * downstream of that choice belongs to the canvas.
 *
 * The module registry is the only source of rows, and it deliberately returns
 * every module it holds, permission included: hiding entries inside the
 * registry would move an authorization decision somewhere it could be neither
 * seen nor tested. Narrowing to the current viewer is therefore this
 * component's job, done in {@link
 * GfModuleCatalogComponent.applyPermissionFilter} before a row is rendered or a
 * module type emitted. The canvas repeats the check against saved layouts and
 * the API stays independently guarded; those are layers of the same defence,
 * not a licence to relax this one.
 *
 * Only `name`, `moduleType` and `permission` are read. The lazy `loadComponent`
 * thunk is never called here - resolving a module class belongs to the module
 * host, and calling it from a listing would fetch every module bundle just to
 * draw a list of names.
 *
 * It owns no layout state: no cell coordinate and no cell size is declared,
 * read, displayed or emitted. It owns no panel state either - the canvas mounts
 * this content inside its own side drawer and decides when that drawer is open.
 * It persists nothing and navigates nowhere, which is also why a row is a card
 * rather than an anchor.
 *
 * A module can be chosen in three interchangeable ways, all converging on one
 * emission per choice: clicking a row; pressing Enter or Space on the focused
 * row, which its own button handles natively; or dragging a row onto empty
 * canvas, which bypasses this component entirely - the row writes the
 * discriminator as a native drag payload and the canvas reads it on drop.
 */
@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    GfModuleCatalogItemComponent,
    MatFormFieldModule,
    MatInputModule,
    ReactiveFormsModule
  ],
  selector: 'gf-module-catalog',
  styleUrls: ['./module-catalog.scss'],
  templateUrl: './module-catalog.html'
})
export class GfModuleCatalogComponent implements AfterViewInit, OnInit {
  @ViewChildren(GfModuleCatalogItemComponent)
  public moduleCatalogItems: QueryList<GfModuleCatalogItemComponent>;

  // Discriminators only, never geometry: a row says whether its module is
  // already on the canvas, and the grid remains the sole authority on where
  // anything sits.
  @Input() placedModuleTypes: DashboardModuleType[] = [];

  @Input() unavailableModuleTypes: DashboardModuleType[] = [];

  @ViewChild('search', { read: ElementRef })
  private searchField: ElementRef<HTMLInputElement>;

  public modules: DashboardModuleDefinition[] = [];

  public searchFormControl = new FormControl<string>('');

  // The one row in the tab order. The list is a roving-tabindex composite, so
  // exactly one row is tabbable at a time and the arrow keys move that point
  // rather than the browser's own focus order.
  public tabbableIndex = 0;

  protected readonly moduleAdded = output<DashboardModuleType>();

  protected readonly dragStarted = output<DashboardModuleType>();

  protected readonly dragEnded = output<void>();

  private eligibleModules: DashboardModuleDefinition[] = [];

  private keyManager: FocusKeyManager<GfModuleCatalogItemComponent>;

  public constructor(
    private changeDetectorRef: ChangeDetectorRef,
    private destroyRef: DestroyRef,
    private moduleRegistryService: GfModuleRegistryService,
    private userService: UserService
  ) {}

  // Bound on the host rather than on the list, because the search field sits
  // above the rows and a viewer typing into it must still be able to step
  // through them with the arrow keys without leaving the field.
  @HostListener('keydown', ['$event'])
  public onKeydown(event: KeyboardEvent) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (!this.keyManager) {
        return;
      }

      this.removeFocusFromModuleCatalogItems();

      this.keyManager.onKeydown(event);

      const currentItem = this.getCurrentModuleCatalogItem();

      this.tabbableIndex = Math.max(this.keyManager.activeItemIndex ?? 0, 0);

      if (currentItem?.rowElement) {
        currentItem.rowElement.nativeElement?.scrollIntoView({
          block: 'nearest'
        });
      }

      return;
    }
  }

  // Deferred to `AfterViewInit` because `FocusKeyManager` needs a populated
  // `QueryList`; `withWrap` makes the list circular so arrowing past either end
  // continues rather than stopping dead.
  public ngAfterViewInit() {
    this.keyManager = new FocusKeyManager(this.moduleCatalogItems).withWrap();
  }

  public ngOnInit() {
    this.userService.stateChanged
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((state) => {
        this.applyPermissionFilter(state?.user?.permissions);

        this.setModules(this.searchModules(this.getSearchTerm()));
      });

    this.searchFormControl.valueChanges
      .pipe(
        map((searchTerm) => {
          this.changeDetectorRef.markForCheck();

          return searchTerm?.trim();
        }),
        // The search index is rebuilt per query and the permission filter
        // re-runs on every viewer emission, so the debounce is what keeps
        // typing from re-searching per keystroke. `distinctUntilChanged`
        // additionally drops a re-emission that trimmed to the same term.
        debounceTime(300),
        distinctUntilChanged(),
        switchMap((searchTerm) => {
          return of(this.searchModules(searchTerm));
        }),
        takeUntilDestroyed(this.destroyRef)
      )
      .subscribe({
        next: (modules) => {
          this.setModules(modules);
        },
        // A failed search empties the list rather than terminating the stream,
        // so the next keystroke is still searched. The error is reported
        // sanitized because a search term is viewer input.
        error: (error: unknown) => {
          reportSanitizedError('GF-MODULE-CATALOG-SEARCH-FAILED', error);

          this.setModules([]);
        }
      });

    // Primes the stream so the full list is rendered before anything is typed.
    this.searchFormControl.setValue('');
  }

  /**
   * Where focus should land inside the panel, which is this component's
   * decision rather than the canvas's: the search field first, and the first
   * row when the field is absent.
   *
   * Both outcomes are read back from the document rather than assumed, because
   * `focus()` on a detached or hidden element is a silent no-op - and the
   * canvas uses the return value to decide whether it owes focus back when the
   * panel closes.
   */
  public focusSearchField(): boolean {
    const searchField = this.searchField?.nativeElement;

    if (searchField) {
      searchField.focus();

      if (searchField.ownerDocument?.activeElement === searchField) {
        return true;
      }
    }

    this.keyManager?.setFirstItemActive();

    const firstRow = this.moduleCatalogItems?.first?.rowElement?.nativeElement;

    return !!firstRow && firstRow.ownerDocument?.activeElement === firstRow;
  }

  public onAddModule(moduleType: DashboardModuleType) {
    this.moduleAdded.emit(moduleType);
  }

  public onModuleDragEnd() {
    this.dragEnded.emit();
  }

  public onModuleDragStart(moduleType: DashboardModuleType) {
    this.dragStarted.emit(moduleType);
  }

  public onModuleCatalogItemFocused(aIndex: number) {
    this.tabbableIndex = aIndex;

    this.keyManager?.updateActiveItem(aIndex);

    this.changeDetectorRef.markForCheck();
  }

  public isPlaced(aModuleType: DashboardModuleType): boolean {
    return this.placedModuleTypes?.includes(aModuleType) ?? false;
  }

  public isUnavailable(aModuleType: DashboardModuleType): boolean {
    return this.unavailableModuleTypes?.includes(aModuleType) ?? false;
  }

  // Applied to the registry's full list before a row is rendered or a module
  // type emitted, so an unpermitted module can be neither seen nor chosen.
  // Absence of a declared permission means unconditionally visible.
  private applyPermissionFilter(permissions: string[]) {
    this.eligibleModules = this.moduleRegistryService
      .getAll()
      .filter(({ permission }) => {
        return !permission || hasPermission(permissions, permission);
      });
  }

  private getCurrentModuleCatalogItem() {
    return this.moduleCatalogItems?.find(({ getHasFocus }) => {
      return getHasFocus;
    });
  }

  private getSearchTerm() {
    return this.searchFormControl.value?.trim();
  }

  private removeFocusFromModuleCatalogItems() {
    for (const item of this.moduleCatalogItems ?? []) {
      item.removeFocus();
    }
  }

  // Searched over the already-filtered list, so a term can never surface a
  // module the viewer may not place. `context` is a key alongside `name`
  // because two modules can share a display name and the qualifier is what
  // tells them apart.
  private searchModules(searchTerm: string): DashboardModuleDefinition[] {
    if (!searchTerm) {
      return this.eligibleModules;
    }

    const fuse = new Fuse(this.eligibleModules, {
      keys: ['name', 'context'],
      threshold: 0.3
    });

    return fuse.search(searchTerm).map(({ item }) => {
      return item;
    });
  }

  // A new result set invalidates the roving point: the row that held it may not
  // be in the list any more, so focus is cleared from every row and the tab
  // order is reset to the first one.
  private setModules(modules: DashboardModuleDefinition[]) {
    this.modules = modules;

    this.removeFocusFromModuleCatalogItems();
    this.keyManager?.setActiveItem(-1);

    this.tabbableIndex = 0;

    this.changeDetectorRef.markForCheck();
  }
}
