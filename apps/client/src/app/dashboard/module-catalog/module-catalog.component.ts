import { UserService } from '@ghostfolio/client/services/user/user.service';
import { DashboardModuleType } from '@ghostfolio/common/dashboard';
import { hasPermission } from '@ghostfolio/common/permissions';

import { FocusKeyManager } from '@angular/cdk/a11y';
import {
  AfterViewInit,
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  DestroyRef,
  HostListener,
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
import { DashboardModuleRegistryService } from '../module-registry.service';
import { GfModuleCatalogItemComponent } from './module-catalog-item/module-catalog-item.component';

/**
 * Searchable catalog of the dashboard modules a viewer is allowed to place.
 *
 * The catalog answers exactly one question - "which modules may I add, and
 * which of those match what I am looking for?" - and reports exactly one thing
 * outwards: that a particular module type was chosen. Everything downstream of
 * that choice belongs to the canvas.
 *
 * ## Where its contents come from
 *
 * The module registry is the only source. Every listed row originates from
 * {@link DashboardModuleRegistryService.getAll}, so a module type that is not
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
 * 2. pressing Enter on the row that currently holds the roving focus, which
 *    forwards to that same click rather than emitting separately;
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
   * The definitions currently on display: permission-eligible, then narrowed by
   * the active search term.
   *
   * Replaced wholesale rather than mutated, so the `OnPush` view has a new
   * reference to compare on every update.
   */
  public modules: DashboardModuleDefinition[] = [];

  /**
   * Backs the search field. Typed rather than inferred so that a `null` reset
   * and a `string` edit are both accounted for at the one place the value is
   * read.
   */
  public searchFormControl = new FormControl<string>('');

  /**
   * Emitted once per chosen module, carrying only the discriminator.
   *
   * That is the whole outward contract. The canvas resolves the definition,
   * decides where the module lands and persists the result; nothing about
   * placement is expressed here.
   */
  protected readonly moduleAdded = output<DashboardModuleType>();

  /**
   * Every registered module the current viewer is allowed to see, in registry
   * order.
   *
   * Recomputed only when the viewer changes, and searched - never rendered -
   * directly. Keeping it separate from {@link modules} is what lets a cleared
   * search term restore the full list without going back to the registry, and
   * what lets a permission change re-narrow the display without a synthetic
   * form emission.
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
    private moduleRegistryService: DashboardModuleRegistryService,
    private userService: UserService
  ) {}

  /**
   * Keyboard navigation across the rows.
   *
   * Bound to the host rather than to the document. The precedent this is
   * modelled on listens on `document:keydown` and gates itself on an open flag
   * it owns, but this component owns no open state - the canvas does - so a
   * document-level listener would keep firing for a catalog that is closed, and
   * would compete with whatever has focus instead. A host-scoped listener is
   * self-gating: it can only fire while focus is inside the catalog. Please do
   * not "restore" the document-level form.
   *
   * Only ArrowDown, ArrowUp and Enter are considered. Every other key - the
   * whole of ordinary text entry, Tab, Escape - is left untouched, so the search
   * field keeps working and dismissing the panel stays with the canvas.
   */
  @HostListener('keydown', ['$event'])
  public onKeydown(event: KeyboardEvent) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (!this.keyManager) {
        return;
      }

      // Clearing first keeps the highlight single-valued: the key manager
      // focuses the row it moves to, but nothing tells the row it moved away
      // from to stand down.
      //
      // Note that the active index must NOT be reset here, unlike on a results
      // update. The key manager treats a negative index as "nothing active yet"
      // and answers a movement request from it by activating the first or last
      // row, so resetting at this point would turn every arrow press into a
      // jump to one end of the list instead of a step through it.
      this.removeFocusFromModuleCatalogItems();

      this.keyManager.onKeydown(event);

      const currentItem = this.getCurrentModuleCatalogItem();

      if (currentItem?.rowElement) {
        currentItem.rowElement.nativeElement?.scrollIntoView({
          behavior: 'smooth',
          block: 'center'
        });
      }

      // No `preventDefault()` here on purpose: the key manager already
      // suppresses the default action for the keys it handles, and calling it
      // again would be redundant. Nothing is suppressed for keys it ignores.
      return;
    }

    if (event.key === 'Enter') {
      const currentItem = this.getCurrentModuleCatalogItem();

      // Enter only means "add" when a row is actually highlighted. With nothing
      // highlighted - including an empty result list - the key is left alone
      // rather than swallowed, so plain Enter in the search field behaves
      // normally.
      if (currentItem?.rowElement) {
        event.preventDefault();
        event.stopPropagation();

        // Delegated to the row's own click rather than emitted from here, so
        // clicking and pressing Enter cannot diverge and a single choice can
        // never be reported twice.
        currentItem.rowElement.nativeElement?.click();
      }
    }
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
    // Subscribed before the search stream is wired, and deliberately so. The
    // user store dispatches through a subject that its own constructor has
    // already primed, so this emits synchronously on subscribe - which is what
    // fills the catalog for the very first frame. The search stream cannot do
    // that job: its seed has to travel through the debounce below, so relying
    // on it alone would leave the panel blank for the length of that window,
    // precisely when it opens by itself for a viewer with no saved layout.
    //
    // That first synchronous emission necessarily carries no viewer, because
    // the store primes itself before the fetch that replaces it resolves, and
    // it may carry no state object at all. Every read is therefore
    // optional-chained: this workspace compiles without strict null checks, so
    // nothing but that would stand between an unresolved viewer and a runtime
    // failure. Absent a viewer, only the modules that declare no permission are
    // eligible, which is the correct answer while nothing is known.
    this.userService.stateChanged
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((state) => {
        this.applyPermissionFilter(state?.user?.permissions);

        // Re-narrowed through the same helper the search stream uses, so a
        // viewer change is reflected against the term that is currently typed
        // without pushing a synthetic value into the form control - which would
        // otherwise have to survive the stream's own distinctness check.
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

          // Trimmed once, here, so that whitespace alone counts as no term at
          // all and every operator downstream sees the same normalized value.
          return searchTerm?.trim();
        }),
        debounceTime(300),
        distinctUntilChanged(),
        // The search is local and synchronous, yet still switched: the term is
        // the only input, so a newer one always supersedes an older one, and
        // expressing that with `switchMap` keeps the shape correct if the
        // source ever stops being immediate.
        switchMap((searchTerm) => {
          return of(this.searchModules(searchTerm));
        }),
        takeUntilDestroyed(this.destroyRef)
      )
      .subscribe({
        next: (modules) => {
          this.setModules(modules);
        },
        error: (error) => {
          // A form control's value stream does not fail, so reaching this means
          // the narrowing itself threw. Reported rather than swallowed, and the
          // display is emptied so the template falls back to a notice the
          // viewer can act on instead of leaving stale rows that no longer
          // correspond to the term on screen.
          console.error('Module catalog search stream error:', error);

          this.setModules([]);
        }
      });

    // `valueChanges` does not replay the control's current value, so the first
    // pass has to be asked for explicitly. This is what makes a cleared search
    // term - the state the catalog opens in - resolve to the full eligible list
    // through exactly the same path every later term takes.
    this.searchFormControl.setValue('');
  }

  /**
   * Forwards a row's choice as this component's own output, unchanged.
   *
   * Nothing else happens here. The catalog does not close itself, does not
   * clear the search term and does not track what has already been added: a
   * viewer may well place the same module twice, and the panel's visibility
   * belongs to the canvas.
   *
   * @param moduleType Discriminator of the chosen module.
   */
  public onAddModule(moduleType: DashboardModuleType) {
    this.moduleAdded.emit(moduleType);
  }

  /**
   * Narrows every registered module to those the given viewer may see.
   *
   * A module that declares no permission is unconditionally visible - that is
   * the case for most of them - and a module that declares one is visible only
   * when the viewer holds it. The direction matters: the ancestor of this rule
   * was spelled as an exclusion but evaluated as an inclusion, and reproducing
   * the name without the behaviour would expose administrative modules to
   * everyone.
   *
   * The permissions array is passed in rather than cached so this stays a pure
   * function of the viewer it is called for, and so the shared helper's own
   * fallback applies when a viewer is not resolved yet: an absent array holds
   * nothing, so nothing that requires a permission is eligible.
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

  /**
   * The active search term, normalized the same way the stream normalizes it.
   *
   * @returns The trimmed term, or a falsy value when nothing is being searched
   * for.
   */
  private getSearchTerm() {
    return this.searchFormControl.value?.trim();
  }

  /**
   * Clears the highlight from every rendered row.
   *
   * Guarded because the rows are queried after this component is initialized,
   * so both a keystroke and the first results update can arrive while the query
   * is still unresolved.
   */
  private removeFocusFromModuleCatalogItems() {
    for (const item of this.moduleCatalogItems ?? []) {
      item.removeFocus();
    }
  }

  /**
   * Narrows the eligible modules by a search term.
   *
   * With no term the full eligible list is returned in registry order, which
   * follows the shared metadata's declaration order and is therefore stable
   * across sessions and reviewable in a diff. With a term, matching is fuzzy
   * over the display name only - a viewer searches for what is on the row, and
   * the discriminator, the dimensions and the permission are not things to
   * search by.
   *
   * The index is built per search rather than kept: it is derived from the
   * eligible list, which changes with the viewer, so rebuilding it is what
   * makes a permission change take effect without any cache to invalidate. The
   * lists involved are twenty-one entries long at most.
   *
   * @param searchTerm Normalized term, possibly empty.
   * @returns The definitions to display, in registry order when unfiltered and
   * in relevance order when filtered.
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

    // Required rather than defensive: these updates originate from a stream and
    // from the user store, never from a template-triggered check, and this view
    // is only re-read when it is marked.
    this.changeDetectorRef.markForCheck();
  }
}
