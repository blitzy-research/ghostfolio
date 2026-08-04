import { GfPublicPortfolioComponent } from '@ghostfolio/client/components/public-portfolio/public-portfolio.component';
import { DashboardIntentService } from '@ghostfolio/client/core/dashboard-intent.service';
import { GfAppQueryParams } from '@ghostfolio/client/interfaces/interfaces';
import { UserService } from '@ghostfolio/client/services/user/user.service';
import { User, UserDashboardLayout } from '@ghostfolio/common/interfaces';
import { hasPermission } from '@ghostfolio/common/permissions';

import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  CUSTOM_ELEMENTS_SCHEMA,
  DestroyRef,
  DOCUMENT,
  Inject,
  OnDestroy,
  OnInit
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { MatButtonModule } from '@angular/material/button';
import { MatSidenavModule } from '@angular/material/sidenav';
import { ActivatedRoute, Router } from '@angular/router';
import { IonIcon } from '@ionic/angular/standalone';
import { Gridster, GridsterItem } from 'angular-gridster2';
import type { GridsterConfig, GridsterItemConfig } from 'angular-gridster2';
import { addIcons } from 'ionicons';
import { addOutline, closeOutline } from 'ionicons/icons';
import { Subject } from 'rxjs';

import { DashboardModuleType } from '../enums/dashboard-module-type';
import type {
  DashboardLayoutItem,
  DashboardModuleDefinition
} from '../interfaces/interfaces';
import { GfModuleCatalogComponent } from '../module-catalog/module-catalog.component';
import { DashboardModuleRegistryService } from '../module-registry.service';
import { GfDashboardLayoutService } from '../services/dashboard-layout.service';
import { createDashboardCanvasConfig } from './dashboard-canvas.config';
import { GfDashboardModuleHostComponent } from './dashboard-module-host/dashboard-module-host.component';
import { GfDashboardToolbarComponent } from './dashboard-toolbar/dashboard-toolbar.component';
import { GfEmptyCanvasStateComponent } from './empty-canvas-state/empty-canvas-state.component';
import { GfSignInPromptComponent } from './sign-in-prompt/sign-in-prompt.component';

/**
 * The single canvas the application is mounted on, and the only component the
 * root route resolves to.
 *
 * It owns three things and deliberately nothing else:
 *
 * - **which of four states the viewer is looking at** - a portfolio shared by
 *   access link, a sign-in prompt, an authenticated canvas with nothing placed
 *   on it, or an authenticated canvas hydrated from a saved arrangement;
 * - **the one array of grid items** that says where every module sits and how
 *   large it is. No module component holds any part of that, and there is no
 *   second copy of it anywhere;
 * - **when an arrangement is worth saving**. Every trigger converges on one
 *   subject here, and the debounce, the projection onto the wire shape and the
 *   HTTP write all belong to `GfDashboardLayoutService`.
 *
 * What it deliberately cannot do. It imports no module component: the only
 * handle on a module class is a lazy thunk held by
 * `DashboardModuleRegistryService`, which is what preserves the code-splitting
 * boundary the collapsed route table used to provide, and what makes it
 * impossible to put a component on the canvas without registering it first. It
 * addresses no screen - the router still owns the single root route, and the
 * only navigation issued from here removes a spent parameter from the address
 * bar. And it renders no navigation chrome, no tab strip and no page heading,
 * because none of those has anywhere left to point.
 */
@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  // Both classes are functional rather than decorative. `gf-gridster` is the
  // scope the global grid stylesheet hangs every one of its overrides off:
  // gridster's three components ship unencapsulated styles with hardcoded
  // colours at element-selector specificity, and Angular injects those after the
  // application stylesheet, so an override needs this extra class to outweigh
  // them. `page` is what the floating catalog trigger's position rule is nested
  // inside, and it supplies the host's column layout. `has-tabs` is deliberately
  // absent - there are no tabs, and it participates in a height calculation that
  // does not apply here.
  host: { class: 'page gf-gridster' },
  imports: [
    GfDashboardModuleHostComponent,
    GfDashboardToolbarComponent,
    GfEmptyCanvasStateComponent,
    GfModuleCatalogComponent,
    GfPublicPortfolioComponent,
    GfSignInPromptComponent,
    Gridster,
    GridsterItem,
    IonIcon,
    MatButtonModule,
    MatSidenavModule
  ],
  schemas: [CUSTOM_ELEMENTS_SCHEMA],
  selector: 'gf-dashboard-canvas',
  styleUrls: ['./dashboard-canvas.scss'],
  templateUrl: './dashboard-canvas.html'
})
export class GfDashboardCanvasComponent implements OnDestroy, OnInit {
  /**
   * Whether the module catalog drawer is open.
   *
   * Owned here rather than by the catalog, which renders no drawer of its own.
   * It is bound in both directions, because the drawer also closes itself on
   * Escape and this flag drives the trigger's glyph.
   */
  public isCatalogOpen = false;

  /**
   * Gates the paint of the authenticated canvas until the viewer and their
   * saved arrangement have both resolved.
   *
   * Without it a returning viewer would see one frame of the first-visit
   * treatment - an empty canvas with the catalog swinging open - before their
   * arrangement arrived.
   */
  public isInitialized = false;

  /**
   * Whether the URL addresses a portfolio shared by access link, which takes
   * precedence over every other state.
   */
  public isPublicPortfolio = false;

  /**
   * Whether the viewer has been resolved and is genuinely not signed in.
   *
   * Distinct from "not resolved yet": an unresolved viewer leaves all four
   * states unset, so nothing is painted speculatively.
   */
  public isSignedOut = false;

  /**
   * The single source of truth for every module's position and size.
   *
   * `readonly` is the point: exactly one array exists for the lifetime of this
   * component and it is mutated in place, because gridster writes coordinates
   * straight onto the objects inside it while a module is being dragged or
   * resized. Replacing the array, mirroring it or cloning it per frame would all
   * either lose those writes or fight them.
   */
  public readonly modules: DashboardLayoutItem[] = [];

  /**
   * Grid-engine policy, minted once from the single declaration site.
   *
   * Assigned in the constructor because `options` is a *required* signal input
   * on `<gridster>` that the grid reads during its own initialization, so it has
   * to hold a value before this component's template first renders.
   */
  public options: GridsterConfig;

  /**
   * The live grid, handed over by the configuration's init callback.
   *
   * Needed for two things only: asking the engine where a new module fits, and
   * finding the element of a module that is already placed so it can be brought
   * into view.
   */
  private gridster: Gridster;

  /**
   * Whether an arrangement has already been fetched once, which is what makes
   * every later fetch a forced one.
   */
  private hasHydratedLayout = false;

  /**
   * Whether the viewer has been asked for. Guards the network call alone, so
   * that leaving the shared-portfolio state can resolve a viewer that was never
   * resolved while it was being shown.
   */
  private hasRequestedViewer = false;

  /**
   * The one place a layout change is reported.
   *
   * The grid's four callbacks and the three mutations this component performs
   * itself all fan into this subject, and it is subscribed exactly once. There
   * is no per-event subject and no second write origin, so no module component
   * has a path to a save.
   */
  private layoutChange$ = new Subject<void>();

  /**
   * The current viewer. `undefined` means not resolved yet and `null` means
   * resolved and absent; the two are never conflated. Read for its permissions
   * and its identity, never for anything about the layout.
   */
  private user: User;

  public constructor(
    private changeDetectorRef: ChangeDetectorRef,
    private dashboardIntentService: DashboardIntentService,
    private dashboardLayoutService: GfDashboardLayoutService,
    private destroyRef: DestroyRef,
    @Inject(DOCUMENT) private document: Document,
    private moduleRegistryService: DashboardModuleRegistryService,
    private route: ActivatedRoute,
    private router: Router,
    private userService: UserService
  ) {
    addIcons({ addOutline, closeOutline });

    this.options = createDashboardCanvasConfig({
      onEmptyCellDrop: (event, item) => this.handleEmptyCellDrop(event, item),
      onGridsterInit: (gridster) => {
        this.gridster = gridster;
      },
      onLayoutChange: () => this.notifyLayoutChange()
    });

    // Read from the snapshot before anything subscribes to anything. Both
    // subscriptions below deliver their current value the moment they are
    // subscribed, and what they do with it depends on whether this is a shared
    // portfolio, so the answer has to exist first.
    this.isPublicPortfolio = this.isSharedPortfolioRequest(
      this.route.snapshot.queryParams
    );

    this.userService.stateChanged
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((state) => {
        this.handleViewerState(state?.user);
      });

    this.dashboardIntentService.revealModule$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((moduleType) => {
        this.revealOrPlaceModule(moduleType);
      });

    // Kept last so that the viewer resolution it kicks off sees a store
    // subscription that is already in place.
    this.route.queryParams
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((queryParams: GfAppQueryParams) => {
        this.isPublicPortfolio = this.isSharedPortfolioRequest(queryParams);

        this.resolveViewer();

        this.changeDetectorRef.markForCheck();
      });

    this.layoutChange$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => {
        // The complete current arrangement, every time. What to send and when to
        // send it is the layout service's business, not this component's.
        this.dashboardLayoutService.scheduleSave(this.modules);
      });
  }

  public ngOnDestroy() {
    this.document.body.classList.remove('has-fab');
  }

  public ngOnInit() {
    // Companion of the global rule that positions the floating catalog trigger:
    // it pads the document so the trigger never sits on top of the end of the
    // canvas. Added for this component's lifetime and removed with it, because
    // no other component on a single-canvas shell owns that class.
    this.document.body.classList.add('has-fab');

    this.clearJwtQueryParam();

    // Idempotent, and normally already done by the query-parameter subscription
    // in the constructor. Named here as well so that resolution has one
    // documented entry point that does not depend on when an observable happens
    // to deliver its current value.
    this.resolveViewer();
  }

  /**
   * The registry's definition for a placed module, or `undefined` for a
   * discriminator the registry no longer knows.
   *
   * Handing back the registry's own object rather than a copy is a contract with
   * the module host, which compares successive definitions to decide whether it
   * still has to fetch a component class. A fresh object per call would make
   * every change-detection pass look like a new module and refetch it.
   */
  public getModuleDefinition(
    aModuleType: DashboardModuleType
  ): DashboardModuleDefinition {
    return this.moduleRegistryService.get(aModuleType);
  }

  /**
   * A module was chosen in the catalog. One already on the canvas is brought
   * into view instead of being placed a second time.
   */
  public onAddModule(aModuleType: DashboardModuleType) {
    this.revealOrPlaceModule(aModuleType);
  }

  /**
   * Keeps the open flag in step with a drawer that closed itself - on Escape,
   * for instance - so the trigger never claims the catalog is still open.
   */
  public onCatalogOpenedChange(aIsOpened: boolean) {
    this.isCatalogOpen = aIsOpened;

    this.changeDetectorRef.markForCheck();
  }

  public onOpenCatalog() {
    this.isCatalogOpen = true;

    this.changeDetectorRef.markForCheck();
  }

  /**
   * Removes one module from the arrangement.
   *
   * Located by identity rather than by discriminator, because the item handed
   * back is the very object the grid has been maintaining. The same array is
   * spliced and the same subject is notified as on every other path, so removal
   * reaches persistence exactly the way a drag does.
   */
  public onRemoveModule(aItem: DashboardLayoutItem) {
    const index = this.modules.indexOf(aItem);

    if (index === -1) {
      return;
    }

    this.modules.splice(index, 1);

    this.notifyLayoutChange();

    this.changeDetectorRef.markForCheck();
  }

  public onToggleCatalog() {
    this.isCatalogOpen = !this.isCatalogOpen;

    this.changeDetectorRef.markForCheck();
  }

  /**
   * Adopts a resolved viewer and, when it is a different one, refetches their
   * arrangement.
   *
   * Guarding on identity is what keeps the store's other emissions - a settings
   * write, a refreshed subscription - from refetching a layout that has not
   * changed, while still catching the two cases that matter: a first resolution
   * and a switch to another account.
   */
  private adoptViewer(aUser: User) {
    const isDifferentViewer = aUser.id !== this.user?.id;

    this.isSignedOut = false;
    this.user = aUser;

    if (isDifferentViewer) {
      this.hydrateLayout();
    }

    this.changeDetectorRef.markForCheck();
  }

  /**
   * Puts a fetched arrangement on the canvas.
   *
   * The array is emptied and refilled rather than replaced, so the one array
   * this component owns keeps its identity.
   */
  private applyLayout(aLayout: UserDashboardLayout | null) {
    const items = this.createLayoutItems(aLayout);

    this.modules.length = 0;
    this.modules.push(...items);

    // Set before `isInitialized`, and that order is the requirement rather than
    // a detail: the drawer is bound to this flag, so flipping it afterwards
    // would paint one frame with the panel shut. All three ways of arriving with
    // nothing placed are treated identically - no saved arrangement at all, a
    // saved arrangement with no modules, and one whose every module is unknown
    // to the registry or not permitted for this viewer - so removing the last
    // module never strands anyone on a blank canvas. It only ever opens the
    // panel: a viewer who closed it and then had a populated arrangement arrive
    // does not have it reopened.
    if (this.modules.length === 0) {
      this.isCatalogOpen = true;
    }

    this.isInitialized = true;

    this.changeDetectorRef.markForCheck();
  }

  /**
   * Removes a spent `jwt` from the address bar.
   *
   * The token itself was already adopted by the route guard, which owns that
   * half precisely because navigating from inside `canActivate` risks cancelling
   * the navigation in progress. Nothing is saved or exchanged here.
   *
   * The empty command array is this workspace's route-agnostic convention, and
   * merging is what preserves every other parameter on the URL - a shared
   * portfolio id and each dialog flag among them.
   */
  private clearJwtQueryParam() {
    const { jwt }: GfAppQueryParams = this.route.snapshot.queryParams;

    if (!jwt) {
      return;
    }

    void this.router.navigate([], {
      queryParams: { jwt: null },
      queryParamsHandling: 'merge',
      relativeTo: this.route
    });
  }

  /**
   * Mints one grid item for a module.
   *
   * The minimum footprint is copied onto every item, on all three paths that
   * mint one, and that is required rather than tidy: the grid's
   * `itemValidateCallback` measures a placement against these two members, they
   * are optional on `GridsterItemConfig`, and an absent minimum would be
   * compared against with no value to compare to.
   *
   * @param aDefinition the registry definition, and the only source of the
   * footprint.
   * @param aPosition the cell to place at; omitted for click-to-add, where the
   * grid engine is asked for a free cell instead.
   */
  private createLayoutItem(
    aDefinition: DashboardModuleDefinition,
    aPosition?: { x: number; y: number }
  ): DashboardLayoutItem {
    return {
      cols: aDefinition.defaultItemCols,
      minItemCols: aDefinition.minItemCols,
      minItemRows: aDefinition.minItemRows,
      moduleType: aDefinition.moduleType,
      rows: aDefinition.defaultItemRows,
      x: aPosition?.x ?? 0,
      y: aPosition?.y ?? 0
    };
  }

  /**
   * Turns a saved arrangement into grid items, dropping everything it cannot
   * honour.
   *
   * Three entries are dropped in silence, and each of them has to be: a
   * discriminator the registry no longer knows, which is how an arrangement
   * saved before a module was renamed or withdrawn survives; one whose module
   * declares a permission this viewer does not hold, which is the visibility
   * gate the deleted navigation chrome used to be the only holder of; and a
   * repeated discriminator, which the template's own cell key could not tell
   * apart from the first.
   *
   * The persisted discriminator is a plain string on purpose - the wire contract
   * has to tolerate a value written by an older client - and the registry lookup
   * is what narrows it. The typed discriminator is then taken from the resolved
   * definition, so nothing is asserted or cast anywhere on this path.
   */
  private createLayoutItems(
    aLayout: UserDashboardLayout | null
  ): DashboardLayoutItem[] {
    const definitions = this.getDefinitionsByModuleType();
    const items: DashboardLayoutItem[] = [];

    for (const { cols, moduleType, rows, x, y } of aLayout?.modules ?? []) {
      const definition = definitions.get(moduleType);

      if (!definition || !this.isModulePermitted(definition)) {
        continue;
      }

      const isAlreadyPlaced = items.some((item) => {
        return item.moduleType === definition.moduleType;
      });

      if (isAlreadyPlaced) {
        continue;
      }

      items.push({
        ...this.createLayoutItem(definition, { x, y }),
        cols,
        rows
      });
    }

    return items;
  }

  /**
   * The registry's definitions keyed by their discriminator as a plain string.
   *
   * Built rather than reached for directly because the two places a
   * discriminator arrives from the outside world - a saved arrangement and a
   * drag payload - both carry a string, while the registry's own lookup takes
   * the typed discriminator. Going through this map keeps both paths free of a
   * type assertion, and the registry remains the only thing consulted.
   */
  private getDefinitionsByModuleType(): Map<string, DashboardModuleDefinition> {
    return new Map<string, DashboardModuleDefinition>(
      this.moduleRegistryService.getAll().map((definition) => {
        return [definition.moduleType, definition];
      })
    );
  }

  /**
   * Something was dropped onto an empty cell.
   *
   * The payload contract is frozen by the catalog row that starts the drag: the
   * raw kebab-case discriminator under the `text/plain` key, with no JSON, no
   * wrapper object, no prefix and no custom MIME type. `dataTransfer` is
   * optional on the event and a drag carrying nothing must not throw, which is
   * why it is read optionally and the result is checked before it is used.
   *
   * The cell comes from the item the grid already positioned under the pointer;
   * the footprint comes from the definition.
   */
  private handleEmptyCellDrop(aEvent: DragEvent, aItem: GridsterItemConfig) {
    const moduleType = aEvent.dataTransfer?.getData('text/plain');

    if (!moduleType) {
      return;
    }

    const definition = this.getDefinitionsByModuleType().get(moduleType);

    if (!definition || !this.isModulePermitted(definition)) {
      return;
    }

    this.placeModule(definition, { x: aItem.x, y: aItem.y });
  }

  /**
   * Interprets one emission of the viewer store.
   *
   * The three cases are genuinely three: a viewer, no viewer, and no answer yet.
   * The store primes itself with `undefined` before anything has been fetched,
   * and a failed fetch leaves it there, so `undefined` concludes nothing and
   * changes nothing. Only an explicit `null` means signed out.
   *
   * A shared portfolio ignores the store outright: whose session is looking at
   * the link has no bearing on what the link shows.
   */
  private handleViewerState(aUser: User) {
    if (this.isPublicPortfolio) {
      return;
    }

    if (aUser) {
      this.adoptViewer(aUser);

      return;
    }

    if (aUser === null) {
      this.markSignedOut();
    }
  }

  /**
   * Fetches the viewer's saved arrangement.
   *
   * Every fetch after the first bypasses the cache. The layout store caches on
   * its slice being defined rather than on it being truthy, so a cached absence
   * belonging to the previous viewer would otherwise be served to whoever just
   * signed in - and served as "no saved arrangement", which is exactly the state
   * that opens the catalog.
   */
  private hydrateLayout() {
    const force = this.hasHydratedLayout;

    this.hasHydratedLayout = true;

    this.dashboardLayoutService
      .get(force)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        error: () => {
          // A failed read is not an empty arrangement, and must not be reported
          // as one: doing so would open the catalog as though this were a first
          // visit. The canvas is only marked ready, so it neither hangs on a
          // blank frame nor loses what it already had.
          this.isInitialized = true;

          this.changeDetectorRef.markForCheck();
        },
        next: (layout) => {
          this.applyLayout(layout);
        }
      });
  }

  /**
   * Whether this viewer may see a module.
   *
   * Absence of a declared permission means unconditionally visible. Nothing is
   * special-cased by name here - the metadata is the entire rule, which is what
   * replaces the single admin gate the deleted header used to hold - and the
   * same check is applied by the catalog independently. Server-side
   * authorization is unaffected by either.
   */
  private isModulePermitted({
    permission
  }: DashboardModuleDefinition): boolean {
    return !permission || hasPermission(this.user?.permissions, permission);
  }

  /**
   * Whether the URL addresses a portfolio shared by access link.
   *
   * `accessId` alone is not enough, because it is not exclusively a share-link
   * parameter: the account access module produces
   * `?accessId=<id>&dialogModule=account-access&editDialog=true` against this
   * very route to reopen its own edit dialog (see `onUpdateAccess` in
   * `components/user-account-access/user-account-access.component.ts`). Matching
   * on `accessId` by itself would replace a signed-in viewer's whole canvas with
   * a stranger's portfolio the moment they edited one of their own access
   * grants, so the absence of `editDialog` is part of the condition and must
   * stay.
   */
  private isSharedPortfolioRequest({
    accessId,
    editDialog
  }: GfAppQueryParams): boolean {
    return !!accessId && !editDialog;
  }

  /**
   * Records that the viewer is resolved and not signed in.
   *
   * The arrangement is deliberately left in place. Tearing the canvas down
   * destroys every `gridster-item`, and each destruction invokes the grid's
   * item-removed callback, so emptying the array first would schedule a write of
   * an empty arrangement and erase what the viewer had saved.
   * `notifyLayoutChange` refuses to report while signed out for the same reason.
   */
  private markSignedOut() {
    this.isSignedOut = true;
    this.user = null;

    this.changeDetectorRef.markForCheck();
  }

  /**
   * Reports that the arrangement changed and should be saved.
   *
   * Suppressed unless the arrangement is actually on screen. Destroying the
   * canvas - signing out, or following a shared link - destroys every grid item,
   * and every one of those destructions invokes the item-removed callback. Those
   * are teardown rather than intent, and reporting them would schedule a write
   * that reflects nothing the viewer did.
   *
   * Nothing else happens here. The four grid callbacks fire once per settled
   * interaction and anything expensive on this path would eat into the budget
   * the drag is being measured against.
   */
  private notifyLayoutChange() {
    if (!this.isInitialized || this.isPublicPortfolio || this.isSignedOut) {
      return;
    }

    this.layoutChange$.next();
  }

  /**
   * Places a module that is not on the canvas yet, or brings the one that is
   * into view.
   *
   * @param aDefinition the registry definition; its declared footprint is the
   * only source of the item's size.
   * @param aPosition the cell a drop landed on. Omitted for click-to-add, where
   * the grid engine decides.
   */
  private placeModule(
    aDefinition: DashboardModuleDefinition,
    aPosition?: { x: number; y: number }
  ) {
    if (!this.isInitialized) {
      return;
    }

    const placed = this.modules.find(({ moduleType }) => {
      return moduleType === aDefinition.moduleType;
    });

    if (placed) {
      this.revealPlacedModule(placed);

      return;
    }

    const item = this.createLayoutItem(aDefinition, aPosition);

    // Click-to-add. Where a module fits is the engine's answer to give, never
    // this component's to guess: `getNextPossiblePosition` writes the cell onto
    // the candidate and reports whether one exists at all, and `false` means the
    // canvas is full - to which the correct response is to add nothing rather
    // than to place something on top of something else.
    //
    // It has to be the component instance. The identically named member of the
    // `GridsterApi` surface returns `void`, so its answer could neither be acted
    // on nor asserted.
    //
    // With no instance yet - possible only before the grid has ever rendered -
    // the item keeps the origin it was minted with and the engine's own
    // `addItem` settles it on init through the very same routine, so nothing is
    // computed here either.
    if (
      !aPosition &&
      this.gridster &&
      !this.gridster.getNextPossiblePosition(item)
    ) {
      return;
    }

    this.modules.push(item);

    this.notifyLayoutChange();

    // A module added below the fold scrolls itself into view, because the grid
    // configuration asks for that; nothing here needs to.
    this.changeDetectorRef.markForCheck();
  }

  /**
   * Asks for the viewer, but only if nobody has answered yet.
   *
   * The three answers are kept apart, and the guard is where that matters most.
   * A viewer already adopted and a viewer already known to be absent both leave
   * `user` defined, and neither needs asking again. `undefined` is the one case
   * that does: it means nothing has answered, and it must be *asked* rather than
   * read as an absence, which is what would open the catalog on somebody else's
   * behalf.
   *
   * The store subscription in the constructor is established before this can
   * first run and delivers the store's current value the moment it is
   * subscribed, so by here `user` already reflects anything the store knew - the
   * route guard's own fetch included. That ordering is why this needs no reading
   * of the store, whose state accessor is not public anyway.
   *
   * A successful ask returns through that same subscription, because the user
   * service sets its state synchronously as the response arrives. Only the
   * failure is handled here, and it is the single thing that establishes "not
   * signed in".
   */
  private resolveViewer() {
    if (
      this.isPublicPortfolio ||
      this.hasRequestedViewer ||
      this.user !== undefined
    ) {
      return;
    }

    this.hasRequestedViewer = true;

    this.userService
      .get()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        error: () => {
          this.markSignedOut();
        }
      });
  }

  /**
   * Acts on a reveal-module intent, from the catalog or from anywhere in the
   * application that published one.
   *
   * An unknown discriminator resolves to nothing and is dropped in silence,
   * exactly as a stale saved entry is, and one the viewer may not see is dropped
   * too - the same check, applied at the same place, for both.
   */
  private revealOrPlaceModule(aModuleType: DashboardModuleType) {
    const definition = this.moduleRegistryService.get(aModuleType);

    if (!definition || !this.isModulePermitted(definition)) {
      return;
    }

    this.placeModule(definition);
  }

  /**
   * Brings a module that is already placed into view instead of placing it
   * twice, which the canvas could not represent anyway: cells are keyed on the
   * discriminator, so a repeated one would collide.
   *
   * Called optionally throughout, because a document without a layout engine
   * implements neither the lookup's element nor the scroll.
   */
  private revealPlacedModule(aItem: DashboardLayoutItem) {
    const element = this.gridster?.getItemComponent(aItem)?.el;

    element?.scrollIntoView?.({ behavior: 'smooth', block: 'nearest' });
  }
}
