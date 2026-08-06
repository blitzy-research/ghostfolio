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
  HostListener,
  Input,
  OnInit,
  QueryList,
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
 * Rows come from {@link GfModuleRegistryService.getAll}, which deliberately
 * returns every module it holds, permission included: hiding entries inside the
 * registry would move an authorization decision somewhere it could be neither seen
 * nor tested. Narrowing to the current viewer is therefore this component's job,
 * done in {@link GfModuleCatalogComponent.applyPermissionFilter} before a row is
 * rendered or a module type emitted. The canvas repeats the check against saved
 * layouts and the API stays independently guarded; those are layers of the same
 * defence, not a licence to relax this one.
 *
 * Only `name`, `moduleType` and `permission` are read. The lazy `loadComponent`
 * thunk is never called here - doing so would fetch every module bundle just to
 * draw a list of names.
 *
 * The module registry is the only source. Every listed row originates from
 * {@link GfModuleRegistryService.getAll}, so a module type that is not
 * registered cannot be offered, and there is no second place a module could be
 * introduced from. The registry deliberately returns every module it holds,
 * permission included, because hiding entries inside it would move an
 * authorization decision somewhere it could be neither seen nor tested - so
 * narrowing that list to the current viewer is this component's job, performed
 * in {@link GfModuleCatalogComponent.applyPermissionFilter}, before a row is
 * ever rendered or a module type ever emitted. The canvas repeats the same
 * check against saved layouts, and the API endpoints stay independently
 * guarded; those are layers of the same defence, not a licence to relax this
 * one.
 *
 * Only three members of a definition are ever read: `name`, `moduleType` and
 * `permission`. In particular the lazy `loadComponent` thunk is never called
 * here - resolving a module class belongs to the module host, and calling it
 * from a catalog listing would fetch all twenty-one module bundles just to draw
 * a list of names.
 *
 * ## What it deliberately cannot do
 *
 * - **It owns no layout state.** No cell coordinate and no cell size is
 *   declared, read, displayed or emitted. The catalog emits a bare
 *   {@link DashboardModuleType}; the canvas resolves geometry from the registry
 *   and the grid engine enforces the declared floor.
 * - **It owns no panel state.** No open-state input and no open or close method
 *   is exposed, and no drawer, backdrop or floating action button is rendered.
 *   The canvas mounts this content inside its own side drawer and decides when
 *   that drawer is open - including opening it unprompted for a viewer with no
 *   saved layout.
 * - **It persists nothing.** A layout write originates only from a grid state
 *   change on the canvas, so no data service, no HTTP client and no browser
 *   storage is reachable from here.
 * - **It navigates nowhere.** The URL no longer selects a screen, so no router
 *   API, link directive or route constant is imported. That is also why a row is
 *   a card rather than an anchor.
 *
 * ## Interaction contract
 *
 * A module can be chosen in three interchangeable ways, all of which converge
 * on one emission per choice:
 *
 * 1. clicking a row, which the row reports through its own output;
 * 2. pressing Enter or Space on the row that currently holds focus, which the
 *    row's own button handles natively and reports through that same output;
 * 3. dragging a row onto empty canvas, which bypasses this component entirely -
 *    the row writes the discriminator as a native drag payload and the canvas
 *    reads it on drop.
 *
 * @example
 * ```html
 * <gf-module-catalog (moduleAdded)="onAddModule($event)" />
 * ```
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
  /**
   * The rendered rows, in display order.
   *
   * Queried as components rather than as elements because the key manager moves
   * a roving focus between them through their `FocusableOption` implementation,
   * and because reading which row currently holds that focus goes through the
   * component instance.
   */
  @ViewChildren(GfModuleCatalogItemComponent)
  public moduleCatalogItems: QueryList<GfModuleCatalogItemComponent>;

  /**
   * The definitions currently on display: permission-eligible, then narrowed by the
   * active search term.
   *
   * Assigned rather than mutated, but note that an empty search term assigns
   * {@link eligibleModules} itself, so this is not always a fresh reference - the
   * explicit `markForCheck()` in {@link setModules} is what re-reads the view.
   */
  public modules: DashboardModuleDefinition[] = [];

  /**
   * The module types currently on the canvas.
   *
   * Supplied by the canvas, which owns the arrangement, and read for one purpose
   * only: telling a row that its module is already placed so it can say so. It is
   * deliberately a list of TYPES and not of grid items - no coordinate and no size
   * reaches this component - so the grid remains the single authority on geometry
   * and this holds no copy of it.
   */
  @Input() placedModuleTypes: DashboardModuleType[] = [];

  /**
   * The module types the canvas has no room for.
   *
   * Read for one purpose, exactly as {@link placedModuleTypes} is: telling a row
   * that clicking it cannot currently succeed, so the catalog stops inviting an
   * action that would silently do nothing. Also a list of TYPES and nothing more -
   * answering *why* there is no room needs the grid's geometry, which is why the
   * canvas answers it and this only reports the answer.
   */
  @Input() unavailableModuleTypes: DashboardModuleType[] = [];

  public searchFormControl = new FormControl<string>('');

  /**
   * Which row currently holds the list's single tab stop.
   *
   * A roving-focus list has exactly one: the row the key manager last moved to,
   * or the first row before any movement. Publishing it here is what lets Tab
   * reach the results at all - every row being permanently untabbable is what made
   * the whole result list unreachable from the keyboard, and narrowing the list by
   * search made that worse rather than better, because there was then nothing else
   * for Tab to land on either.
   *
   * It is reset to the first row whenever the results change, since the row that
   * held it may no longer be in the list.
   */
  public tabbableIndex = 0;

  protected readonly moduleAdded = output<DashboardModuleType>();

  /**
   * Every registered module the current viewer is allowed to see, in registry order.
   * Searched rather than rendered directly.
   *
   * Recomputed on every user-store emission, not only when the permissions actually
   * change. Keeping it separate from {@link modules} is what lets a cleared search
   * term restore the full list without going back to the registry, and what lets a
   * permission change re-narrow the display without a synthetic form emission.
   */
  private eligibleModules: DashboardModuleDefinition[] = [];

  /**
   * Drives the roving focus across the rows. Undefined until the view has been
   * initialized, so every use is guarded: a keystroke can reach the host before
   * the first query resolves.
   */
  private keyManager: FocusKeyManager<GfModuleCatalogItemComponent>;

  public constructor(
    private changeDetectorRef: ChangeDetectorRef,
    private destroyRef: DestroyRef,
    private moduleRegistryService: GfModuleRegistryService,
    private userService: UserService
  ) {}

  /**
   * Bound to the host rather than to `document` on purpose: this component owns no
   * open state, so a document-level listener would keep firing for a closed catalog
   * and compete with whatever has focus. A host-scoped listener can only fire while
   * focus is inside the catalog, which is self-gating.
   *
   * Bound to the host rather than to the document. The precedent this is
   * modelled on listens on `document:keydown` and gates itself on an open flag
   * it owns, but this component owns no open state - the canvas does - so a
   * document-level listener would keep firing for a catalog that is closed, and
   * would compete with whatever has focus instead. A host-scoped listener is
   * self-gating: it can only fire while focus is inside the catalog. Please do
   * not "restore" the document-level form.
   *
   * Only ArrowDown and ArrowUp are considered. Every other key - the whole of
   * ordinary text entry, Tab, Escape, and activation - is left untouched, so the
   * search field keeps working, dismissing the panel stays with the canvas, and
   * activating a row stays with the row's own button.
   */
  @HostListener('keydown', ['$event'])
  public onKeydown(event: KeyboardEvent) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (!this.keyManager) {
        return;
      }

      // Clearing first keeps the highlight single-valued. The key manager
      // focuses the row it moves to and the browser blurs the one it left, which
      // clears that row on its own, but the clear is done here too so the state
      // is already single-valued by the time the lookup below reads it rather
      // than depending on blur having been dispatched first.
      //
      // Note that the active index must NOT be reset here, unlike on a results
      // update. The key manager treats a negative index as "nothing active yet"
      // and answers a movement request from it by activating the first or last
      // row, so resetting at this point would turn every arrow press into a
      // jump to one end of the list instead of a step through it.
      this.removeFocusFromModuleCatalogItems();

      this.keyManager.onKeydown(event);

      const currentItem = this.getCurrentModuleCatalogItem();

      // Moves the tab stop with the focus, which is the other half of the roving
      // pattern: a viewer who arrowed to a row and then tabbed away must come back
      // to that row rather than to the top of the list.
      this.tabbableIndex = Math.max(this.keyManager.activeItemIndex ?? 0, 0);

      if (currentItem?.rowElement) {
        currentItem.rowElement.nativeElement?.scrollIntoView({
          // `nearest` rather than `center`: this list is a scroll region of its
          // own, and asking to centre a row scrolls it even when the row is
          // already fully visible, which makes every arrow press jolt the panel.
          block: 'nearest'
        });
      }

      // No `preventDefault()` here on purpose: the key manager already
      // suppresses the default action for the keys it handles, and calling it
      // again would be redundant. Nothing is suppressed for keys it ignores.
      return;
    }

    // Enter and Space are deliberately absent. The key manager moves real DOM
    // focus onto the focused row's button, and a focused native button already
    // activates on both keys by itself - so handling either here would add the
    // module a second time. Leaving them alone also keeps plain Enter in the
    // search field behaving normally.
  }

  public ngAfterViewInit() {
    // Constructed exactly once. The key manager subscribes to the query list
    // itself, so it keeps tracking the rows as search results narrow and widen;
    // rebuilding it per update would discard that subscription and the active
    // row along with it. Wrapping is deliberate: at either end of the list the
    // next step continues from the opposite end.
    this.keyManager = new FocusKeyManager(this.moduleCatalogItems).withWrap();
  }

  public ngOnInit() {
    // Subscribed before the search stream deliberately: the user store emits
    // synchronously on subscribe, which is what fills the catalog for the first
    // frame. The search stream cannot do that job, because its seed has to travel
    // through the debounce below - leaving the panel blank for that window, exactly
    // when it opens by itself for a viewer with no saved layout.
    //
    // That first emission carries no viewer and may carry no state object at all,
    // hence the optional chaining. Absent a viewer only the modules that declare no
    // permission are eligible, which is the correct answer while nothing is known.
    this.userService.stateChanged
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((state) => {
        this.applyPermissionFilter(state?.user?.permissions);

        this.setModules(this.searchModules(this.getSearchTerm()));
      });

    this.searchFormControl.valueChanges
      .pipe(
        map((searchTerm) => {
          // The results are deliberately left standing while the new term
          // settles. The template decides between the list and its "no results"
          // notice from the list itself, so emptying it here - rather than when
          // the narrowed result arrives - would flash that notice between
          // keystrokes.
          //
          // Marking is still required: a term can arrive programmatically, from
          // the seed below or from a reset, and such an emission is not a DOM
          // event, so nothing else would mark this `OnPush` view for the
          // template to re-read the term it renders its empty state from.
          this.changeDetectorRef.markForCheck();

          return searchTerm?.trim();
        }),
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
        error: (error: unknown) => {
          // A form control's value stream does not fail, so reaching this means
          // the narrowing itself threw. Recorded rather than swallowed, and
          // recorded through the shared reporter, which emits the event id and a
          // numeric status and nothing else - no stack and no search term. The
          // actionable part of the response is the display, which is emptied so
          // the template falls back to a notice the viewer can see instead of
          // leaving stale rows that no longer correspond to the term on screen.
          reportSanitizedError('GF-MODULE-CATALOG-SEARCH-FAILED', error);

          this.setModules([]);
        }
      });

    // `valueChanges` does not replay the control's current value, so the first
    // pass has to be asked for explicitly. This is what makes a cleared search
    // term - the state the catalog opens in - resolve to the full eligible list
    // through exactly the same path every later term takes.
    this.searchFormControl.setValue('');
  }

  public onAddModule(moduleType: DashboardModuleType) {
    this.moduleAdded.emit(moduleType);
  }

  /**
   * Adopts focus that arrived at a row from somewhere other than the arrow keys -
   * a Tab into the list, a click, the browser restoring focus after the panel
   * reopens.
   *
   * Both halves matter and they are different things. The tab stop moves, so that
   * leaving and re-entering the panel returns to the row the viewer is on. The key
   * manager's active index is updated WITHOUT moving focus, which is the whole
   * point of `updateActiveItem`: it means the next arrow press steps from the row
   * the viewer is actually on rather than from wherever the manager last put
   * focus itself - and from its initial "nothing active", that first press would
   * otherwise jump to one end of the list.
   *
   * @param aIndex Position of the row that took focus, in display order.
   */
  public onModuleCatalogItemFocused(aIndex: number) {
    this.tabbableIndex = aIndex;

    this.keyManager?.updateActiveItem(aIndex);

    this.changeDetectorRef.markForCheck();
  }

  /**
   * @param aModuleType The module type a row offers.
   * @returns Whether that module is already on the canvas.
   */
  public isPlaced(aModuleType: DashboardModuleType): boolean {
    return this.placedModuleTypes?.includes(aModuleType) ?? false;
  }

  /**
   * @param aModuleType The module type a row offers.
   * @returns Whether the canvas currently has no room for that module.
   */
  public isUnavailable(aModuleType: DashboardModuleType): boolean {
    return this.unavailableModuleTypes?.includes(aModuleType) ?? false;
  }

  /**
   * A module that declares no permission is unconditionally visible; one that
   * declares a permission is visible only while the viewer holds it. Inverting that
   * direction would expose the administrative modules to everyone.
   *
   * The permissions array is passed in rather than cached, so this stays a pure
   * function of the viewer it is called for and an unresolved viewer's absent array
   * simply holds nothing.
   *
   * @param permissions Permissions held by the current viewer, if any.
   */
  private applyPermissionFilter(permissions: string[]) {
    this.eligibleModules = this.moduleRegistryService
      .getAll()
      .filter(({ permission }) => {
        return !permission || hasPermission(permissions, permission);
      });
  }

  /**
   * The row that currently holds the roving focus, if any.
   *
   * Reads the row's focus state as a property, which is why the row exposes it
   * as a getter. Were it a method, this would still compile and would match the
   * first row every time.
   *
   * @returns The focused row, or `undefined` when none is - including before the
   * view has been initialized and whenever the list is empty.
   */
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

  /**
   * Matching is fuzzy over the display name only, because that is the one thing on
   * the row a viewer can see to search by.
   *
   * The index is rebuilt per search rather than kept, so a permission change takes
   * effect with no cache to invalidate; the list is a few dozen entries at most.
   *
   * @param searchTerm Normalized term, possibly empty.
   * @returns The definitions to display, in registry order when unfiltered and in
   * relevance order when filtered.
   */
  private searchModules(searchTerm: string): DashboardModuleDefinition[] {
    if (!searchTerm) {
      return this.eligibleModules;
    }

    const fuse = new Fuse(this.eligibleModules, {
      keys: ['name'],
      threshold: 0.3
    });

    return fuse.search(searchTerm).map(({ item }) => {
      return item;
    });
  }

  /**
   * Publishes a new set of rows and resets the roving focus onto none of them.
   *
   * Both halves of that reset are necessary and they are not the same thing:
   * the rows carry the highlight that is painted, while the key manager holds
   * the index the next movement is measured from. A row that was highlighted
   * may not be in the new list at all, so leaving either behind would either
   * paint a highlight the viewer cannot move away from or resume movement from
   * a row that is no longer there.
   *
   * @param modules The definitions to display.
   */
  private setModules(modules: DashboardModuleDefinition[]) {
    this.modules = modules;

    this.removeFocusFromModuleCatalogItems();
    this.keyManager?.setActiveItem(-1);

    // Back to the first row, because the row that held the tab stop may not be in
    // the new list at all - and a tab stop pointing at a row that no longer exists
    // is the same thing as no tab stop.
    this.tabbableIndex = 0;

    // Required rather than defensive: these updates originate from a stream and
    // from the user store, never from a template-triggered check, and this view
    // is only re-read when it is marked.
    this.changeDetectorRef.markForCheck();
  }
}
