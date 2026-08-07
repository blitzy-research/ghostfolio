import { GfPublicPortfolioComponent } from '@ghostfolio/client/components/public-portfolio/public-portfolio.component';
import { DashboardIntentService } from '@ghostfolio/client/core/dashboard-intent.service';
import { LayoutService } from '@ghostfolio/client/core/layout.service';
import { GfAppQueryParams } from '@ghostfolio/client/interfaces/interfaces';
import { UserService } from '@ghostfolio/client/services/user/user.service';
import {
  DashboardModuleLayoutItem,
  User,
  UserDashboardLayout
} from '@ghostfolio/common/interfaces';
import { hasPermission } from '@ghostfolio/common/permissions';

import { HttpErrorResponse } from '@angular/common/http';
import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  CUSTOM_ELEMENTS_SCHEMA,
  DestroyRef,
  ElementRef,
  OnDestroy,
  OnInit,
  QueryList,
  ViewChild,
  ViewChildren
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatSidenavModule } from '@angular/material/sidenav';
import { ActivatedRoute, Router } from '@angular/router';
import { IonIcon } from '@ionic/angular/standalone';
import { Gridster, GridsterItem } from 'angular-gridster2';
import type { GridsterConfig, GridsterItemConfig } from 'angular-gridster2';
import { StatusCodes } from 'http-status-codes';
import { addIcons } from 'ionicons';
import { closeOutline, gridOutline } from 'ionicons/icons';
import { NgxSkeletonLoaderModule } from 'ngx-skeleton-loader';
import { Subject } from 'rxjs';

import { DashboardModuleType } from '../enums/dashboard-module-type';
import type {
  DashboardLayoutItem,
  DashboardModuleDefinition,
  DashboardModuleGeometryStep
} from '../interfaces/interfaces';
import { GfModuleCatalogComponent } from '../module-catalog/module-catalog.component';
import { GfModuleRegistryService } from '../module-registry.service';
import { GfDashboardLayoutService } from '../services/dashboard-layout.service';
import {
  createDashboardCanvasConfig,
  DEFAULT_DROP_PREVIEW_COLS,
  DEFAULT_DROP_PREVIEW_ROWS,
  GRID_COLUMNS,
  GRID_ROWS
} from './dashboard-canvas.config';
import { GfDashboardModuleHostComponent } from './dashboard-module-host/dashboard-module-host.component';
import { GfDashboardToolbarComponent } from './dashboard-toolbar/dashboard-toolbar.component';
import { GfEmptyCanvasStateComponent } from './empty-canvas-state/empty-canvas-state.component';
import { GfSignInPromptComponent } from './sign-in-prompt/sign-in-prompt.component';

/**
 * The one status that means the viewer's session was rejected.
 *
 * Widened to `number` at the point of declaration rather than compared as an
 * enum member. `HttpErrorResponse.status` is a plain `number`, and comparing a
 * number against an enum member is exactly what
 * `@typescript-eslint/no-unsafe-enum-comparison` reports; annotating here keeps
 * the comparison below both warning-free and free of a type assertion.
 */
const UNAUTHORIZED_STATUS: number = StatusCodes.UNAUTHORIZED;

/**
 * The one layout document shape this build can interpret.
 *
 * It is the same number `GfDashboardLayoutService` stamps onto every write, and
 * the same one the API refuses to serve anything else for. Restating it here is
 * what lets the canvas refuse a document from a newer build rather than rewriting
 * it in an older shape — a check it must be able to make on its own, because it is
 * the component that would do the rewriting.
 */
const SUPPORTED_LAYOUT_VERSION = 1;

/**
 * The single canvas the application is mounted on, and the only component the
 * root route resolves to.
 *
 * It owns three things and deliberately nothing else: which of four states the
 * viewer is looking at; the one array of grid items that says where every module
 * sits and how large it is, of which no module component holds any part and of
 * which there is no second copy; and when an arrangement is worth saving, where
 * every trigger converges on one subject here while the debounce, the wire
 * projection and the HTTP write all belong to `GfDashboardLayoutService`.
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
 * `GfModuleRegistryService`, which is what preserves the code-splitting
 * boundary the collapsed route table used to provide, and what makes it
 * impossible to put a component on the canvas without registering it first. It
 * addresses no screen - the router still owns the single root route, and the
 * only navigation issued from here removes a spent parameter from the address
 * bar. And it renders no navigation chrome, no tab strip and no page heading,
 * because none of those has anywhere left to point.
 */
@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  // `gf-gridster` is functional rather than decorative: it is the scope the global
  // grid stylesheet hangs every override off, because gridster ships unencapsulated
  // styles with hardcoded colours at element-selector specificity and Angular
  // injects them after the application stylesheet, so an override needs this extra
  // class to outweigh them.
  //
  // `page` is deliberately NOT carried. It is the class for a screen that flows and
  // scrolls the document, and it inset the canvas by 2rem top and bottom above the
  // small breakpoint - which on a shell that is exactly one viewport tall left an
  // empty band above the control bar and pushed it 32px off the top of the screen.
  // Everything else it supplied is either already declared on this component's own
  // host (the flex column) or contradicted by it (a scrollport, where this shell
  // scrolls the grid inside itself instead). The one rule it carried that the
  // modules genuinely need - keeping their own floating buttons in normal flow - is
  // re-homed in this component's stylesheet.
  host: { class: 'gf-gridster' },
  imports: [
    GfDashboardModuleHostComponent,
    GfDashboardToolbarComponent,
    GfEmptyCanvasStateComponent,
    GfModuleCatalogComponent,
    // Used ONLY inside the template's `@defer` block, which is what lets Angular
    // emit it - and the charting and map libraries it reaches - as a separate
    // chunk instead of part of the initial bundle. Referencing it outside that
    // block would put all of it back into the initial graph for every visitor.
    GfPublicPortfolioComponent,
    GfSignInPromptComponent,
    Gridster,
    GridsterItem,
    IonIcon,
    MatButtonModule,
    MatCardModule,
    MatSidenavModule,
    NgxSkeletonLoaderModule
  ],
  schemas: [CUSTOM_ELEMENTS_SCHEMA],
  selector: 'gf-dashboard-canvas',
  styleUrls: ['./dashboard-canvas.scss'],
  templateUrl: './dashboard-canvas.html'
})
export class GfDashboardCanvasComponent implements OnDestroy, OnInit {
  /**
   * Every module chrome currently drawn on the canvas.
   *
   * Queried rather than tracked, so it is the grid's own rendering that decides
   * what is on screen rather than a second list this component would have to keep
   * in step. It is used for two things and nothing else: refreshing every mounted
   * module in place, and moving keyboard focus to a surviving neighbour after one
   * is removed. Neither reads or writes a coordinate or a size.
   */
  @ViewChildren(GfDashboardModuleHostComponent)
  public moduleHosts: QueryList<GfDashboardModuleHostComponent>;

  /**
   * The floating catalog trigger, held as the last resort for focus after a
   * removal.
   *
   * Optional by construction: it is not drawn for a shared portfolio, for a signed
   * out viewer or for an arrangement that failed to read, and none of those states
   * can produce a removal anyway.
   *
   * Read as an `ElementRef` explicitly. The reference names a Material button, so
   * the default read would hand back that component instance - which has no
   * `focus()` of the kind wanted here - rather than the element focus is placed on.
   */
  @ViewChild('catalogTrigger', { read: ElementRef })
  private catalogTrigger: ElementRef<HTMLElement>;

  /**
   * Whether the grid engine has just refused to place a module because the
   * arrangement has no room left for it.
   *
   * The grid is a bounded surface - twelve columns by a capped number of rows -
   * so "there is nowhere to put this" is a reachable, legitimate outcome, not an
   * error. It still has to be said out loud: the engine simply declines, and
   * without this the add would look exactly like a click that never registered.
   *
   * Set only by a refusal and cleared as soon as the arrangement changes in a way
   * that could make room, so the notice can never outlive the condition it
   * describes.
   */
  public hasCapacityError = false;

  /**
   * Whether the viewer's saved arrangement could not be read.
   *
   * A distinct state rather than a variant of "nothing placed", and the
   * distinction is the whole point: an unreadable arrangement is not an empty
   * one. Reporting it as empty would open the catalog as though this were a
   * first visit and, worse, let the next module the viewer added be written out
   * as their complete arrangement - erasing everything the read had failed to
   * fetch. While this is set the canvas offers a retry and nothing else: no
   * empty-state affordance, no grid, and no write of any kind.
   */
  public hasLayoutError = false;

  /**
   * Whether the arrangement currently on screen has failed to persist.
   *
   * Mirrored from the layout service so the viewer is told that what they can
   * see is not stored, and so they can ask for the retained snapshot to be sent
   * again. The service keeps that snapshot; nothing about it is held here.
   */
  public hasSaveError = false;

  /**
   * Whether the viewer could not be read for a reason that is not "not signed
   * in".
   *
   * A failed request for the viewer is not the same as an absent viewer. Only an
   * unauthorized response means signed out - and that answer arrives through the
   * viewer store, because the response interceptor signs out on 401 - so
   * everything else is reported here as a transient failure with a retry rather
   * than as a session that has ended.
   */
  public hasViewerError = false;

  /**
   * The text of the canvas's polite live region: the outcome of the most recent
   * thing the viewer did to the arrangement - a move, a resize, an addition, a
   * removal, or a refusal of any of them.
   *
   * One region for all of them, deliberately. Two live regions on one surface
   * compete: a screen reader interleaves them in an order neither controls, and
   * an announcement from one can cut the other off mid-sentence. Every outcome
   * this canvas reports is the result of the same single user action, so one
   * region says it once.
   *
   * Empty until something is actually done, so nothing is announced on load. It
   * is a plain string rather than a queue because each announcement supersedes
   * the last - a user stepping a module across the grid wants where it is now,
   * not a recital of every cell it passed through.
   */
  public canvasAnnouncement = '';

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
   * The module types the grid currently has no room for, for the catalog to mark
   * its rows with.
   *
   * Types only - no coordinate and no size crosses into the catalog, so the grid
   * remains the sole authority on geometry. This is the answer to a geometric
   * question, computed here because here is the only place that may ask it.
   *
   * Recomputed at the two moments it can change rather than derived on read: the
   * answer costs one engine probe per unplaced module, which is far too much to
   * repeat on every change-detection pass.
   */
  public unavailableModuleTypes: DashboardModuleType[] = [];

  private gridster: Gridster;

  /**
   * Watches the grid's own host box so the engine can be told to recompute its
   * column pitch when that box changes for a reason the engine cannot see.
   *
   * The grid engine listens for `window` resize events and nothing else. That is
   * sufficient for a full-width canvas, but this canvas sits inside a side
   * drawer container: opening the catalog changes only the *content pane's*
   * margin, so the grid's host narrows by the drawer's width with no window
   * resize to hear. Left unobserved, the engine keeps laying out at the wide
   * pitch and the right-hand modules extend underneath the drawer.
   *
   * Bound to one particular engine instance and released with it, in
   * {@link releaseGridster}. It has to be, because it holds that instance's host
   * element and a closure over the instance itself: this canvas outlives its grid,
   * so an observer released only at the canvas's own teardown would keep a
   * detached element and a dead engine alive for as long as the viewer stayed on a
   * state that draws no grid.
   */
  private gridsterResizeObserver: ResizeObserver | null = null;

  /**
   * The pending focus restoration after a removal, held only so it can be
   * cancelled.
   *
   * A task rather than an inline call for the reasons set out on
   * {@link restoreFocusAfterRemoval}, and cancellable because it reaches into the
   * view: a component torn down inside that one task would otherwise be asked to
   * focus chrome that no longer exists.
   */
  private focusRestorationHandle: number | undefined;

  private hasHydratedLayout = false;

  /**
   * Raised only while a runaway placement is being corrected.
   *
   * The correction travels through the grid engine, which reports it back through
   * the same handler that requested it. Without this the handler would inspect the
   * corrected arrangement and consider correcting it again; with it, the inner pass
   * simply records and schedules what the outer pass asked for. See
   * {@link clampRunawayPlacement}.
   */
  private isClampingPlacement = false;

  /**
   * The viewer's arrangement in full, including the modules that are not on the
   * canvas because they are not currently permitted.
   *
   * Kept because the live grid array cannot express the whole arrangement.
   * `applyLayout` deliberately places only the modules this viewer may see, so
   * without this the next ordinary edit would report the visible subset as the
   * entire arrangement and the server would *delete* every module a lapsed
   * subscription or a withdrawn admin role had hidden - permanently, and as a
   * side effect of dragging something unrelated. It is also the only place a
   * module that has never been on screen still has a saved position, which is
   * what lets a permission granted mid-session put it back where the viewer
   * left it.
   *
   * It is not a second authority over geometry, and Rule 2 depends on that
   * distinction: for every module that *is* on the canvas, the entry here is
   * overwritten from grid state each time a change is reported, so the grid
   * remains the only thing that decides where a visible module sits. What this
   * holds on its own is the saved geometry of modules the grid has no cell for.
   *
   * Restricted to discriminators the registry still knows. An unknown one is
   * dropped once, on hydration, which is how an arrangement saved before a
   * module was withdrawn stops carrying it.
   */
  private canonicalModules: DashboardModuleLayoutItem[] = [];

  /**
   * Whether the viewer has been asked for. Guards the network call alone, so
   * that leaving the shared-portfolio state can resolve a viewer that was never
   * resolved while it was being shown.
   */
  private hasRequestedViewer = false;

  /**
   * Which read of the saved arrangement is the current one.
   *
   * Incremented before every fetch, so a response that belongs to a previous
   * viewer - or to a previous attempt for the same viewer - can be recognised
   * and discarded. Without it a slow first response arriving after a fast second
   * one would overwrite the newer viewer's arrangement with the older viewer's,
   * and the layout service's own `switchMap` cannot prevent that because each
   * read is a separate subscription made from here.
   */
  private hydrationGeneration = 0;

  /**
   * The arrangement most recently reported as worth saving, as a canonical
   * fingerprint of exactly the five persisted fields per module.
   *
   * This is what makes reporting idempotent, and it is required rather than an
   * optimisation. The grid invokes its init callback once per cell while a saved
   * arrangement is being drawn, and its resize callback on every pixel reflow -
   * opening the catalog drawer alone produces one per placed module - so a
   * change-free trigger is the common case, not the exception. Comparing the
   * canonical projection rather than counting triggers is what lets all four
   * callbacks stay wired, as the persistence contract requires, while only a
   * genuine change reaches the write path.
   */
  private lastReportedLayout: string = null;

  /**
   * The one place a layout change is reported.
   *
   * The grid's four callbacks - drag, resize, add and remove - are its only
   * feeders, and it is subscribed exactly once. This component never reports a
   * change of its own accord, not even on the paths where it is the one mutating
   * the array: adding an item renders a cell whose initialization the engine
   * reports through `itemInitCallback`, and removing one destroys a cell whose
   * teardown the engine reports through `itemRemovedCallback`, so letting the
   * engine speak is both sufficient and the only way the trigger set stays
   * genuinely closed. There is no per-event subject and no second write origin,
   * so no module component has a path to a save.
   */
  private layoutChange$ = new Subject<void>();

  /**
   * The module the viewer has just placed and which should be brought into view
   * as soon as the grid gives it an element.
   *
   * Held by identity, because the object in the arrangement array is the very
   * one the grid hands back when it reports a first paint, so no discriminator
   * comparison and no cast is needed. Cleared as soon as it is honoured, which
   * is what keeps a later hydration from scrolling.
   */
  private pendingRevealItem: DashboardLayoutItem = null;

  /**
   * The current viewer. `undefined` means not resolved yet and `null` means
   * resolved and absent; the two are never conflated. Read for its permissions
   * and its identity, never for anything about the layout.
   */
  private user: User | null | undefined;

  public constructor(
    private changeDetectorRef: ChangeDetectorRef,
    private dashboardIntentService: DashboardIntentService,
    private dashboardLayoutService: GfDashboardLayoutService,
    private destroyRef: DestroyRef,
    // The shell-wide "reload the content" bus, consumed here so that the control
    // which asks for it refreshes whatever the viewer has placed rather than the
    // one feature component that happened to subscribe to it directly.
    private layoutService: LayoutService,
    private moduleRegistryService: GfModuleRegistryService,
    private route: ActivatedRoute,
    private router: Router,
    private userService: UserService
  ) {
    addIcons({ closeOutline, gridOutline });

    this.options = createDashboardCanvasConfig({
      onEmptyCellDrop: (event, item) => this.handleEmptyCellDrop(event, item),
      onGridsterDestroy: (gridster) => this.releaseGridster(gridster),
      onGridsterInit: (gridster) => {
        this.gridster = gridster;

        this.observeGridsterViewport(gridster);
      },
      onItemInit: (item) => this.handleItemInit(item),
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

    // A refresh of the whole dashboard, delivered by re-mounting what is placed.
    //
    // The bus itself predates the canvas and had exactly one subscriber - inside a
    // single feature component - so the control that asks for a refresh did nothing
    // whatsoever unless the viewer happened to have that one module on their
    // canvas. Answering it here makes the refresh a property of the arrangement
    // instead: every mounted module is re-created, so every module re-reads what it
    // draws from, and no module has to know the control exists.
    //
    // Deliberately NOT a layout concern. No cell is moved, resized, added or
    // removed, so no grid callback fires and no write is reported - which is
    // exactly right, because refreshing content is not a change to the
    // arrangement.
    this.layoutService.shouldReloadContent$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => {
        this.reloadPlacedModules();
      });

    // An identity change that begins somewhere other than here - the shell
    // adopting the token a newly created account was issued, for instance -
    // reaches the canvas through this stream, and it arrives *before* the new
    // token is stored rather than after the new viewer has resolved. Suspending
    // on it is what stops this canvas reporting the previous viewer's
    // arrangement, or leaving it on screen, during the interval in between.
    this.dashboardLayoutService.identityTransition$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => {
        this.suspendCanvas();
      });

    // Mirrored rather than owned: the layout service keeps the snapshot whose
    // write failed, and this flag only decides whether the viewer is told about
    // it and offered the retry that re-enters that same service.
    this.dashboardLayoutService
      .getHasSaveError()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((hasSaveError) => {
        this.hasSaveError = hasSaveError;

        this.changeDetectorRef.markForCheck();
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
        // The complete current arrangement, every time, stamped with the viewer
        // it belongs to. `canonicalModules` rather than `modules`, because the
        // complete arrangement is not necessarily all on the canvas: a module
        // the viewer is not currently entitled to see has a saved position and
        // no cell, and sending only what has a cell would erase it. It is
        // recomputed from grid state by `notifyLayoutChange` immediately before
        // this fires, so what is read here is current by construction.
        //
        // What to send and when to send it is the layout service's business, not
        // this component's - but *whose* arrangement it is can only be answered
        // here, and it has to travel with the snapshot because the write happens
        // after a debounce, by which time the token that authorises it may belong
        // to somebody else.
        this.dashboardLayoutService.scheduleSave(
          this.user?.id,
          this.canonicalModules
        );
      });
  }

  public ngOnDestroy() {
    // The BACKSTOP, not the ordinary path. The engine's own teardown hook releases
    // the observer whenever the grid goes away - which is usually while this
    // component carries on - and this covers the one case that hook cannot: the
    // whole canvas being destroyed. Left connected, the observer would keep the
    // grid's host element and a closure over the engine alive and would call into a
    // torn-down engine on the next reflow.
    this.gridsterResizeObserver?.disconnect();
    this.gridsterResizeObserver = null;
    this.gridster = null;

    // A removal in this component's final moments leaves a task queued that would
    // reach into a view that no longer exists.
    window.clearTimeout(this.focusRestorationHandle);
    this.focusRestorationHandle = undefined;
  }

  public ngOnInit() {
    // The document is deliberately NOT given the `has-fab` class here.
    //
    // That class pads the body so that a page which flows and scrolls ends clear
    // of a floating trigger. This shell does neither: it is exactly one viewport
    // tall - `main` is `block-size: 100svh` - and the grid scrolls inside it. The
    // padding therefore has no content to push down and instead makes the document
    // taller than the viewport, which gives the whole page its own 48px scroll.
    // That scroll is not cosmetic: it moves the control bar off the top of the
    // screen, and it is a scrollable ancestor, so revealing a module could scroll
    // the page as well as the canvas and displace everything the viewer was
    // looking at.
    //
    // The requirement it served - that content clears the trigger - is met on the
    // canvas instead of on the body: the trigger steps aside from the catalog
    // while the catalog is open, and the grid's own scrolling region is what
    // brings a module fully into view.

    this.clearJwtQueryParam();

    this.resolveViewer();
  }

  /**
   * Hands back the registry's own definition object rather than a copy, because
   * the module host compares successive definitions by reference to decide whether
   * it still has to fetch a component class. A fresh object per call would make
   * every change-detection pass look like a new module and refetch it.
   */
  public getModuleDefinition(
    aModuleType: DashboardModuleType
  ): DashboardModuleDefinition | undefined {
    return this.moduleRegistryService.get(aModuleType);
  }

  /**
   * Whether a placed module may still be drawn for the current viewer.
   *
   * Asked by the template for every cell it renders, on every pass, so a
   * permission the viewer no longer holds stops being drawn the moment their
   * record is refreshed - even before the arrangement itself has been tidied.
   * Belt and braces with {@link applyPermittedModules}, and deliberately so:
   * one drops the module from the arrangement, the other guarantees it is not
   * painted in the meantime.
   */
  /**
   * The module types currently on the canvas, for the catalog to mark its rows
   * with.
   *
   * Derived on read rather than stored, so it cannot drift from the arrangement
   * the grid owns. A fresh array is fine here because it is consumed by an input
   * whose component compares membership rather than identity.
   */
  public get placedModuleTypes(): DashboardModuleType[] {
    return this.modules.map(({ moduleType }) => moduleType);
  }

  public isModuleRenderable({ moduleType }: DashboardLayoutItem): boolean {
    const definition = this.moduleRegistryService.get(moduleType);

    return !!definition && this.isModulePermitted(definition);
  }

  /**
   * A module was chosen in the catalog. One already on the canvas is brought
   * into view instead of being placed a second time.
   */
  public onAddModule(aModuleType: DashboardModuleType) {
    this.revealOrPlaceModule(aModuleType);
  }

  /**
   * Returns the grid's drop indicator to the engine's own default footprint.
   *
   * Restoring it is not tidiness. The engine reads the default once per hovered
   * cell, so an override left behind would size the NEXT module's indicator from
   * the module dragged before it - and a drag that is cancelled or released
   * outside the grid is the common case, which is exactly why the catalog raises
   * its end event unconditionally.
   */
  public onCatalogDragEnd() {
    this.applyDropPreviewFootprint(
      DEFAULT_DROP_PREVIEW_COLS,
      DEFAULT_DROP_PREVIEW_ROWS
    );
  }

  /**
   * Sizes the grid's drop indicator from the dragged module's own registered
   * footprint, for as long as that drag lasts.
   *
   * The engine draws its indicator from exactly one place: while a drag hovers a
   * free cell it mints a candidate as `{ x, y, cols: defaultItemCols, rows:
   * defaultItemRows }` and previews that. Those two members are grid-wide, so
   * every module was previewed at 4x4 while the item the canvas actually appends
   * on drop carries the registry's own footprint - which for most modules is
   * wider. The viewer was shown one shape and given another. Only the indicator
   * was ever wrong; placement has always been correct.
   *
   * The override is applied by REPLACING the configuration object rather than
   * mutating it, and that is a requirement rather than a style choice: the engine
   * exposes its configuration as a required signal input and derives its effective
   * options through a `computed` over it, so a new object identity is what makes
   * that derivation re-run. Writing into the existing object changes nothing the
   * engine will ever read again. The current object is spread into the new one so
   * that the runtime bookkeeping the engine writes onto it survives the swap.
   *
   * Silent for a module type the registry does not know - the same treatment a
   * stale persisted entry gets - because there is no footprint to preview and the
   * engine's default is then the honest answer.
   *
   * @param aModuleType the module whose row is being dragged.
   */
  public onCatalogDragStart(aModuleType: DashboardModuleType) {
    const definition = this.moduleRegistryService.get(aModuleType);

    if (!definition) {
      return;
    }

    this.applyDropPreviewFootprint(
      definition.defaultItemCols,
      definition.defaultItemRows
    );
  }

  /**
   * Keeps the open flag in step with a drawer that closed itself - on Escape,
   * for instance - so the trigger never claims the catalog is still open.
   */
  public onCatalogOpenedChange(aIsOpened: boolean) {
    this.setCatalogOpen(aIsOpened);
  }

  public onOpenCatalog() {
    this.setCatalogOpen(true);
  }

  /**
   * Asks for the saved arrangement again after a failed read.
   *
   * Returns the canvas to the state it was in before the read - nothing painted,
   * nothing placed, nothing reportable - so a successful retry is
   * indistinguishable from a first load, and a second failure lands back on the
   * same notice rather than accumulating state.
   */
  public onRetryLayout() {
    this.hasLayoutError = false;
    this.isInitialized = false;

    this.modules.length = 0;
    this.canonicalModules = [];
    this.lastReportedLayout = null;

    this.changeDetectorRef.markForCheck();

    this.hydrateLayout();
  }

  /**
   * Sends the arrangement whose write failed again.
   *
   * Delegated in full, and it re-enters the very stream the grid's own callbacks
   * feed: the layout service still owns the snapshot, the debounce, the projection
   * and the single request, so this adds no second write origin and no second
   * request builder. It carries no arrangement of its own - the one the grid
   * produced is still held, unwritten, which is the whole reason a retry is
   * offerable at all.
   */
  public onRetrySave() {
    this.dashboardLayoutService.retryFailedSave();
  }

  /**
   * Asks for the viewer again after a failed read.
   *
   * The request guard is released first, because it is what stops a viewer from
   * being asked for twice; without releasing it the retry would resolve to
   * nothing at all.
   */
  public onRetryViewer() {
    this.hasViewerError = false;
    this.hasRequestedViewer = false;

    this.changeDetectorRef.markForCheck();

    this.resolveViewer();
  }

  /**
   * Applies a keyboard move step to one module.
   *
   * The step is resolved against grid state here, never in the chrome that sent
   * it, so Rule 2 holds: the grid remains the single authority for placement and
   * the chrome only ever expresses an intent.
   */
  public onMoveModule(
    aItem: DashboardLayoutItem,
    { deltaCols, deltaRows }: DashboardModuleGeometryStep
  ) {
    this.applyGeometryStep(aItem, {
      cols: aItem.cols,
      rows: aItem.rows,
      x: aItem.x + deltaCols,
      y: aItem.y + deltaRows
    });
  }

  /**
   * Removes one module from the arrangement.
   *
   * Located by identity rather than by discriminator, because the item handed
   * back is the very object the grid has been maintaining.
   *
   * Nothing is reported from here. Splicing the array destroys that module's
   * `gridster-item`, and the engine reports the destruction through
   * `itemRemovedCallback` - one of the four callbacks that are the entire
   * persistence trigger set. Reporting here as well would give removal a second,
   * non-callback origin, and would queue a snapshot before the engine had
   * settled the cells that shift into the gap.
   */
  public onRemoveModule(aItem: DashboardLayoutItem) {
    const index = this.modules.indexOf(aItem);

    if (index === -1) {
      return;
    }

    const definition = this.getModuleDefinition(aItem.moduleType);
    const name = definition?.name ?? aItem.moduleType;

    // Resolved BEFORE the array is touched, while the removed module's chrome is
    // still in the query and its neighbours are still either side of it. After the
    // splice the query is re-projected and every index past this one shifts, so
    // the same lookup would then name a different module.
    const focusTarget = this.resolveFocusTargetAfterRemoval(definition);

    this.modules.splice(index, 1);

    // A refusal notice is about the arrangement as it was; removing a module
    // frees the very space it was about, so it stops being true here.
    this.hasCapacityError = false;

    this.canvasAnnouncement = $localize`${name}:moduleName: removed from the dashboard`;

    // Emptying the canvas returns the viewer to the same position a first visit
    // puts them in - nothing placed, and the only way forward is to place
    // something - so it gets the same treatment: the catalog comes to them. Both
    // `applyLayout` and `applyPermittedModules` already do this for an
    // arrangement that arrives empty; without it here, removing the last module
    // leaves a bare canvas whose one affordance is a floating button.
    if (this.modules.length === 0) {
      this.isCatalogOpen = true;
    }

    this.changeDetectorRef.markForCheck();

    this.restoreFocusAfterRemoval(focusTarget);
  }

  /**
   * Applies a keyboard resize step to one module, growing or shrinking it from
   * its bottom-right corner - the same pair of edges the pointer handles expose,
   * so the two input methods cannot disagree about which way a module grows.
   */
  public onResizeModule(
    aItem: DashboardLayoutItem,
    { deltaCols, deltaRows }: DashboardModuleGeometryStep
  ) {
    this.applyGeometryStep(aItem, {
      cols: aItem.cols + deltaCols,
      rows: aItem.rows + deltaRows,
      x: aItem.x,
      y: aItem.y
    });
  }

  public onToggleCatalog() {
    this.setCatalogOpen(!this.isCatalogOpen);
  }

  /**
   * Adopts a resolved viewer, and reacts to the two transitions that change what
   * may be on the canvas.
   *
   * Guarding on identity is what keeps the store's other emissions - a settings
   * write, a refreshed subscription - from refetching a layout that has not
   * changed, while still catching the two cases that matter: a first resolution
   * and a switch to another account.
   *
   * A switch is a genuine identity transition and is treated as one, in this
   * order: the canvas is suspended *before* the new viewer is recorded, so
   * nothing the previous viewer left on screen survives the change and no
   * removal it causes can report itself; the layout service is then told which
   * identity writes are authorised for, which also discards anything the
   * previous one left pending; and only then is the new arrangement read.
   * Reversing any two of those steps reopens the window the order exists to
   * close.
   *
   * A read is also started when the canvas is suspended but the viewer has not
   * changed. That is what recovers from a transition begun elsewhere: the shell
   * suspends this canvas before replacing a token, and the viewer that arrives
   * afterwards may legitimately be the same one, which must still be rehydrated
   * rather than left looking at nothing.
   */
  private adoptViewer(aUser: User) {
    const isDifferentViewer = aUser.id !== this.user?.id;
    const previousPermissions = this.user?.permissions;

    this.hasViewerError = false;
    this.isSignedOut = false;
    this.user = aUser;

    this.dashboardLayoutService.adoptIdentity(aUser.id);

    // The second disjunct is what recovers a suspended canvas. A transition
    // begun elsewhere - the shell adopting the token a newly created account was
    // issued - suspends this canvas, and the viewer that resolves afterwards may
    // legitimately be the same one, in which case there is nothing to compare
    // and the canvas would be left showing nothing at all. Reading `isInitialized`
    // is exact rather than approximate: a failed read raises it precisely so the
    // canvas is not treated as suspended, so a persistently failing endpoint is
    // retried through the affordance the error state offers and not by every
    // unrelated store emission.
    if (isDifferentViewer || !this.isInitialized) {
      // Everything the previous viewer had on screen goes first, and it goes
      // before anything is fetched. Leaving it up would show one account's
      // arrangement while another's was loading, and - because the grid reports
      // its own reflows - would give the incoming viewer's first write a chance
      // to carry the outgoing viewer's modules.
      this.resetForViewerChange();
      this.hydrateLayout();

      this.changeDetectorRef.markForCheck();

      return;
    }

    // Same viewer, different entitlements. Module visibility is screened on
    // every path that mints a grid item, but those paths only run when an
    // arrangement is fetched or a module is added, so without this a permission
    // that was revoked mid-session would leave the module it gated on screen -
    // and the only client-side gate the deleted navigation chrome used to hold
    // would be a gate that closes just once. Re-screening rather than
    // refetching is deliberate: the server holds no new arrangement, and a
    // refetch would discard positions the viewer has moved since.
    if (this.hasPermissionsChanged(previousPermissions, aUser?.permissions)) {
      this.applyPermittedModules();
    }

    this.changeDetectorRef.markForCheck();
  }

  /**
   * Re-issues the grid configuration with a different drop-indicator footprint.
   *
   * A NEW object, spread from the current one, and both halves are deliberate.
   * The engine takes its configuration as a required signal input and derives the
   * options it actually reads through a `computed` over that input, so identity is
   * what invalidates the derivation - mutating the object in place changes nothing
   * the engine will consult again. Spreading the current object forward is what
   * preserves the runtime bookkeeping the engine writes onto the configuration it
   * was handed, which a freshly built configuration would discard.
   *
   * This is presentation only, and it touches no arrangement. No item is created,
   * moved, resized or removed, so none of the four persistence callbacks fires and
   * nothing is written; the two members changed are read solely for the engine's
   * own preview, because every item this canvas mints carries an explicit `cols`
   * and `rows` of its own.
   *
   * @param aCols column span the indicator should describe.
   * @param aRows row span the indicator should describe.
   */
  private applyDropPreviewFootprint(aCols: number, aRows: number) {
    this.options = {
      ...this.options,
      defaultItemCols: aCols,
      defaultItemRows: aRows
    };

    this.changeDetectorRef.markForCheck();
  }

  /**
   * Decides whether the grid's own reveal applies to the cells about to be drawn.
   *
   * The configuration ships `scrollToNewItems: true`, because a module placed
   * below the fold has to be brought into view rather than appear to have been
   * swallowed. The engine applies it from the first size computation of *every*
   * item though, which is the same moment `itemInitCallback` fires, so it cannot
   * itself tell a module the viewer just placed from one being restored - and a
   * returning viewer's canvas scrolling itself to the bottom-most saved module as
   * it loads is not a reveal, it is a canvas that has lost its place.
   *
   * This component is the only layer that knows which it is, so it is the layer
   * that decides: withheld while it draws cells nobody asked for - hydrating a
   * saved arrangement, re-screening what the viewer may see - and released for the
   * item the viewer placed. Every path that fills the arrangement array passes
   * through one of those three, so there is no fourth case to get wrong.
   *
   * Re-issued as a new object for the same reason {@link
   * applyDropPreviewFootprint} does it: the engine derives the options it reads
   * through a `computed` over its signal input, so identity is what invalidates
   * that derivation, and spreading the current object forward preserves the
   * runtime bookkeeping the engine has written onto it.
   *
   * Presentation only. No item is created, moved, resized or removed, so no
   * persistence callback fires and nothing is written.
   *
   * ⚠ Called BEFORE the cells in question are drawn, never from inside a callback
   * the engine raises while drawing one: the engine reads `$options` on entry to
   * its own size computation, and re-issuing a parent-bound input during that
   * pass is what an `ExpressionChangedAfterItHasBeenChecked` is made of.
   *
   * @param aIsEnabled whether the next first paint should scroll itself into view.
   */
  private applyNewItemReveal(aIsEnabled: boolean) {
    if (this.options.scrollToNewItems === aIsEnabled) {
      return;
    }

    this.options = { ...this.options, scrollToNewItems: aIsEnabled };

    this.changeDetectorRef.markForCheck();
  }

  /**
   * Commits a requested geometry through the grid engine, or reports that it
   * could not be committed.
   *
   * The engine does the deciding, and that is the whole point: it is asked in
   * exactly the way a pointer drag asks it, so a keyboard step is subject to the
   * identical rules. `checkItemChanges` runs the engine's own collision check,
   * which evaluates `itemValidateCallback` (the declared 2x2-and-registry
   * minimums), the grid bounds, and overlap with every sibling; on refusal it
   * restores the working geometry and repaints, and on acceptance it copies the
   * new geometry onto the item this canvas owns and invokes
   * `itemChangeCallback` - which is `notifyLayoutChange`, the one write origin
   * Rule 4 permits. So this method adds no second persistence path and no
   * validation of its own: duplicating either is how the two input methods would
   * drift apart.
   *
   * Acceptance is read from the item afterwards rather than from a return value,
   * because the engine's method returns nothing. The copy-on-success is what
   * makes that reliable: on refusal the item is left exactly as it was.
   */
  private applyGeometryStep(
    aItem: DashboardLayoutItem,
    aGeometry: Pick<DashboardLayoutItem, 'cols' | 'rows' | 'x' | 'y'>
  ) {
    const itemComponent = this.gridster?.getItemComponent(aItem);

    if (!itemComponent) {
      return;
    }

    // The engine keeps a working copy of the geometry separate from the item
    // bound into the cell; it is the working copy that gets mutated and the
    // bound item that receives the result.
    const workingItem = itemComponent.$item();
    const previousGeometry = {
      cols: workingItem.cols,
      rows: workingItem.rows,
      x: workingItem.x,
      y: workingItem.y
    };

    workingItem.cols = aGeometry.cols;
    workingItem.rows = aGeometry.rows;
    workingItem.x = aGeometry.x;
    workingItem.y = aGeometry.y;

    // Paints the requested geometry before it is judged, exactly as a drag does;
    // a refusal repaints from the restored values.
    itemComponent.setSize();
    itemComponent.checkItemChanges(workingItem, previousGeometry);

    const isAccepted =
      aItem.cols === aGeometry.cols &&
      aItem.rows === aGeometry.rows &&
      aItem.x === aGeometry.x &&
      aItem.y === aGeometry.y;
    const isResize =
      aGeometry.cols !== previousGeometry.cols ||
      aGeometry.rows !== previousGeometry.rows;

    this.announceGeometry(aItem, isAccepted, isResize);

    this.changeDetectorRef.markForCheck();
  }

  /**
   * Writes the outcome of a geometry request into the canvas's live region.
   *
   * Without this a keyboard user gets no feedback at all: the module moves on
   * screen and nothing says where it went, and a refusal is indistinguishable
   * from a key that did not register. Coordinates are announced one-based,
   * because "column 1" is what a person counting columns means, while the grid
   * counts from zero.
   */
  private announceGeometry(
    aItem: DashboardLayoutItem,
    aIsAccepted: boolean,
    aIsResize: boolean
  ) {
    const name =
      this.getModuleDefinition(aItem.moduleType)?.name ?? aItem.moduleType;

    if (!aIsAccepted) {
      this.canvasAnnouncement = aIsResize
        ? $localize`${name}:moduleName: cannot be resized any further`
        : $localize`${name}:moduleName: cannot be moved any further`;

      return;
    }

    this.canvasAnnouncement = aIsResize
      ? $localize`${name}:moduleName: resized to ${aItem.cols}:columns: columns by ${aItem.rows}:rows: rows`
      : $localize`${name}:moduleName: moved to column ${aItem.x + 1}:column:, row ${aItem.y + 1}:row:`;
  }

  /**
   * Puts a fetched arrangement on the canvas.
   *
   * The array is emptied and refilled rather than replaced, so the one array
   * this component owns keeps its identity.
   *
   * A document that cannot be interpreted is refused rather than partially
   * applied, and refusing it is what keeps it safe: it is reported as a failed
   * read, which offers a retry and permits no write at all, so the stored
   * arrangement survives. Reporting it as an empty one instead would open the
   * catalog as though this were a first visit, and the first module added
   * afterwards would be written out as the viewer's whole arrangement, destroying
   * the document that could not be read. The API refuses the same two shapes at
   * its own boundary; this check is what makes the canvas independent of that
   * rather than reliant on it.
   */
  private applyLayout(aLayout: UserDashboardLayout | null) {
    if (aLayout && !this.isReadableLayout(aLayout)) {
      this.hasLayoutError = true;
      this.isInitialized = true;

      this.changeDetectorRef.markForCheck();

      return;
    }

    // Recorded before the entries this viewer may not see are filtered out, so
    // that a permission granted later can still admit its module at the position
    // it was saved at. See `canonicalModules`.
    this.canonicalModules = this.createCanonicalModules(aLayout);

    const items = this.createLayoutItems(this.canonicalModules);

    // Restoring an arrangement is not placing a module, so the grid's own reveal
    // is withheld for the cells below - all of which report the same first paint a
    // placement does. Released again by `placeModule`, for the one cell the viewer
    // actually asks for.
    this.applyNewItemReveal(false);

    this.modules.length = 0;
    this.modules.push(...items);

    // The arrangement as fetched is what the server already holds, so it is
    // recorded as the last thing reported. Every trigger the grid fires while it
    // draws these cells then measures as unchanged and reaches no write - which
    // is what stops a returning viewer's load from being mistaken for an edit.
    this.lastReportedLayout = this.createLayoutFingerprint();

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
   * Re-screens the placed modules against the current viewer's permissions.
   *
   * Both directions have to be honoured, and they are handled separately
   * because they draw on different sources. A revocation is answered from the
   * live array, which keeps every surviving module's current geometry and its
   * render order; a grant is answered from the canonical arrangement, which is
   * the only place a module that has no cell still has a saved position. Newly
   * admitted modules are appended, so nothing already on screen moves.
   *
   * An admitted module is offered to the grid engine before it is appended, at
   * its own footprint, exactly as a module added from the catalog is. Its saved
   * cell may well be occupied by something the viewer has moved since it was
   * hidden, and appending it unscreened would put two modules in one place; the
   * engine either confirms the saved cell or finds the nearest one that fits, and
   * a module it can place nowhere at all is left in the canonical arrangement
   * rather than overlapped onto the canvas.
   *
   * Deduplication is by discriminator, matching `createLayoutItems`, because the
   * template keys its cells on it and a repeat would collide.
   *
   * Nothing is reported to the layout service. A change in what a viewer is
   * allowed to see is not a change the viewer made, and persisting it would
   * erase a module from their saved arrangement the moment a subscription
   * lapsed. The canonical arrangement is still refreshed at the end, because a
   * module that has just become visible now takes its geometry from the grid and
   * must stop being carried as a hidden entry.
   */
  private applyPermittedModules() {
    const retained = this.modules.filter((item) =>
      this.isModuleRenderable(item)
    );

    const retainedModuleTypes = new Set(
      retained.map(({ moduleType }) => moduleType)
    );

    const admitted = this.createLayoutItems(this.canonicalModules).filter(
      (item) => {
        return (
          !retainedModuleTypes.has(item.moduleType) &&
          this.settleItemPosition(item, { x: item.x, y: item.y })
        );
      }
    );

    // A module admitted because a permission arrived was not placed by the viewer
    // either, so the grid's own reveal is withheld here too - for the same reason
    // hydration withholds it.
    this.applyNewItemReveal(false);

    // Emptied and refilled rather than replaced, for the same reason
    // `applyLayout` does it: the array's identity is part of the contract with
    // the grid engine.
    this.modules.length = 0;
    this.modules.push(...retained, ...admitted);

    // Same rule as on hydration, and for the same reason: a viewer left with
    // nothing on the canvas needs the catalog to be their way back rather than a
    // blank screen.
    if (this.modules.length === 0) {
      this.isCatalogOpen = true;
    }

    this.canonicalModules = this.mergeCanonicalModules();

    // Recorded last, over the arrangement this re-screen actually produced, so
    // that the grid callbacks its own render and teardown fire measure as
    // unchanged and reach no write. This is the canvas correcting what it is
    // allowed to draw, not the viewer editing their arrangement, and persisting
    // it would delete a module the viewer may be entitled to again tomorrow.
    this.lastReportedLayout = this.createLayoutFingerprint();
  }

  /**
   * Pulls back a module the grid engine has just committed absurdly far down the
   * canvas, and reports whether it did.
   *
   * ## What this defends against
   *
   * Holding a dragged module against the bottom of the scrolling region starts the
   * engine's auto-scroll, which then repeats for as long as the pointer is held and
   * is bounded only by the grid's own scroll extent - `maxRows` rows deep. A hold
   * of a couple of seconds is enough to carry a module past row ninety. The engine
   * commits that as an ordinary drag result, and this canvas, which persists
   * exactly what the engine commits, would faithfully store a module ninety rows
   * below everything else: still present, still permitted, and effectively
   * unreachable.
   *
   * The runaway itself is the library's behaviour and not this component's to fix.
   * What *is* this component's is the commit: a placement no interaction could
   * have deliberately expressed does not get to become the saved arrangement.
   *
   * ## Why not the engine's own boundary control
   *
   * `enableBoundaryControl` looks like the obvious answer and is not. It filters
   * every drag position against the grid's outer edge and, in doing so, suppresses
   * the auto-scroll path entirely - which also removes legitimate downward
   * dragging on a canvas taller than its viewport. The guard here leaves dragging
   * exactly as it is and only vets the result.
   *
   * ## The bound
   *
   * One viewport of rows below the deepest point every *other* module reaches. That
   * is deliberately generous: it permits deliberately placing a module a whole
   * screen clear of the arrangement, which a pointer drag can genuinely express,
   * while a runaway overshoots it by an order of magnitude.
   *
   * It is additionally never allowed to pull a module *above* where it already sat.
   * A saved arrangement may legitimately be sparse - or may predate this guard -
   * and a module resting deep in one is not this method's business. Without that
   * floor, editing any module would silently drag every deep neighbour upwards, and
   * an unrequested rearrangement of somebody's dashboard is a worse defect than the
   * one being fixed. `canonicalModules` is the right source for it because it still
   * holds the *previously reported* arrangement at this point in the pass; it is
   * refreshed afterwards.
   *
   * A bound computed from a grid that has not been measured is meaningless, so an
   * unmeasured grid is left alone rather than guessed at.
   *
   * ## How the correction is applied
   *
   * Through {@link applyGeometryStep}, which is the same path a keyboard step
   * takes: the engine is asked to accept the new cell, judges it with its own
   * collision check, and on acceptance reports it through `itemChangeCallback` -
   * `notifyLayoutChange`, the one write origin Rule 4 permits. No second write
   * origin is created here, and nothing is validated twice.
   *
   * That report re-enters the method this one is called from, which is what the
   * re-entrancy flag is for: the inner pass sees the corrected arrangement, records
   * it and schedules the write, and the outer pass then has nothing left to say -
   * which is what the return value tells it. The correction cannot collide, because
   * the bound lies a full viewport below everything else; the floor case can, if a
   * neighbour has swapped into the cell during the very drag being corrected, and a
   * refusal there is reported as such so the caller persists what the engine
   * actually holds rather than leaving the stored arrangement disagreeing with the
   * canvas.
   *
   * One module is corrected per pass, which is all that is ever needed: a runaway
   * is produced by a drag, and only one module can be dragged at a time.
   */
  private clampRunawayPlacement(): boolean {
    if (this.isClampingPlacement || !this.gridster) {
      return false;
    }

    const { curHeight, curRowHeight } = this.gridster;

    if (!(curHeight > 0) || !(curRowHeight > 0)) {
      return false;
    }

    const viewportRows = Math.max(1, Math.floor(curHeight / curRowHeight));

    for (const item of this.modules) {
      const extentOfOthers = this.modules.reduce(
        (extent, other) =>
          other === item ? extent : Math.max(extent, other.y + other.rows),
        0
      );
      const reportedY = this.canonicalModules.find(
        ({ moduleType }) => moduleType === item.moduleType
      )?.y;
      const deepestReachableY = Math.max(
        extentOfOthers + viewportRows,
        reportedY ?? 0
      );

      if (item.y <= deepestReachableY) {
        continue;
      }

      this.isClampingPlacement = true;

      try {
        this.applyGeometryStep(item, {
          cols: item.cols,
          rows: item.rows,
          x: item.x,
          y: deepestReachableY
        });
      } finally {
        this.isClampingPlacement = false;
      }

      return item.y === deepestReachableY;
    }

    return false;
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
   *
   * `replaceUrl` is what makes this a removal rather than a second address. The
   * parameter carries a session token, so leaving the address that contains it
   * as its own history entry would keep the credential reachable by pressing
   * Back, by anything that reads session history, and by the browser's own
   * restore-tabs behaviour long after the token was spent. Replacing the entry
   * drops it. This is the address-bar half of a defence the API completes by
   * marking the redirect that produced this URL `no-store` and `no-referrer`;
   * neither half removes the token from a server access log that records
   * request targets, which only moving the hand-off out of the URL would.
   *
   * The guard is on the parameter being THERE, not on it carrying anything. Keyed
   * on truthiness instead, `?jwt=` survived: an empty value is falsy, so the method
   * returned having decided there was nothing to remove, while the address bar
   * still advertised a token parameter. That is a straightforward contradiction of
   * the contract stated above - which is that a spent `jwt` is always removed - and
   * it leaves a URL that reads as though a hand-off were in progress when none is.
   * Presence is also the only question worth asking, because the value is not this
   * method's business: whatever it held has already been dealt with by the guard,
   * so an empty one and a spent one are the same case.
   *
   * Absence still short-circuits, and that matters: every ordinary visit to the
   * root route reaches this method, and navigating unconditionally would replace
   * the history entry of a URL that never carried a token.
   */
  private clearJwtQueryParam() {
    if (!('jwt' in this.route.snapshot.queryParams)) {
      return;
    }

    void this.router.navigate([], {
      queryParams: { jwt: null },
      queryParamsHandling: 'merge',
      relativeTo: this.route,
      replaceUrl: true
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
  /**
   * A canonical, comparable rendering of the arrangement.
   *
   * Exactly the five persisted fields, in a fixed key order, per module and in
   * placement order - the same projection the wire carries, so two arrangements
   * compare equal precisely when they would be stored identically. Everything
   * else the grid keeps on an item is transient bookkeeping and is deliberately
   * outside the comparison; including it would make a pixel reflow look like a
   * change.
   *
   * Built from an explicit object literal rather than a spread or a key sort, so
   * the serialised order is fixed by this code instead of by property insertion
   * history.
   */
  private createLayoutFingerprint(): string {
    return JSON.stringify(
      this.modules.map(({ cols, moduleType, rows, x, y }) => ({
        cols,
        moduleType,
        rows,
        x,
        y
      }))
    );
  }

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
   * Reduces a fetched document to the arrangement this canvas will work with.
   *
   * Two entries are dropped in silence, and each of them has to be: a
   * discriminator the registry no longer knows, which is how an arrangement saved
   * before a module was renamed or withdrawn still loads; and a repeated
   * discriminator, which the template's own cell key could not tell apart from
   * the first. Permission is deliberately *not* considered - that is what
   * separates this from {@link createLayoutItems}, and the separation is the whole
   * point: an entry the viewer may not currently see has to stay in the
   * arrangement or the next edit would delete it from the server.
   *
   * Every surviving entry is normalized before it is admitted. The stored
   * geometry is whatever some earlier client wrote, and the checks below are the
   * only thing standing between it and the grid:
   *
   * - a coordinate that is not a whole number cannot describe a cell at all, so
   *   the entry is dropped;
   * - a footprint smaller than the module's own declared minimum is grown to it.
   *   The engine enforces that minimum for every resize and every drop through
   *   `itemValidateCallback`, but it is never consulted for an item that arrives
   *   already placed, so a document written before a minimum was raised - or by
   *   hand - would otherwise draw a module at a size no person could have resized
   *   it to;
   * - a footprint or an origin outside the grid is clamped back inside it, so an
   *   entry can never span past the twelfth column or the hundredth row.
   *
   * Normalizing rather than dropping is what keeps a module the viewer placed on
   * their canvas. Nothing is written as a result: `applyLayout` records the
   * normalized arrangement as the last one reported, so the correction reaches the
   * server only when the viewer next changes something themselves.
   *
   * The persisted discriminator is a plain string on purpose - the wire contract
   * has to tolerate a value written by an older client - and the registry lookup is
   * what narrows it, so nothing is asserted or cast on this path.
   */
  private createCanonicalModules(
    aLayout: UserDashboardLayout | null
  ): DashboardModuleLayoutItem[] {
    const definitions = this.getDefinitionsByModuleType();
    const modules: DashboardModuleLayoutItem[] = [];
    // Kept as a set of plain strings rather than checked by scanning the
    // accumulator, so the repeat test compares a persisted discriminator against
    // persisted discriminators and never against the registry's typed one.
    const placedModuleTypes = new Set<string>();

    for (const { cols, moduleType, rows, x, y } of aLayout?.modules ?? []) {
      const definition = definitions.get(moduleType);

      if (!definition || placedModuleTypes.has(moduleType)) {
        continue;
      }

      const geometry = this.normalizeGeometry(definition, {
        cols,
        rows,
        x,
        y
      });

      if (!geometry) {
        continue;
      }

      placedModuleTypes.add(moduleType);

      modules.push({ ...geometry, moduleType: definition.moduleType });
    }

    return modules;
  }

  /**
   * Turns the canonical arrangement into the grid items this viewer may see.
   *
   * The only filter applied here is permission, and every entry it lets through
   * has already been normalized by {@link createCanonicalModules}, so the
   * footprint carried onto the grid is one the engine's own minimum predicate
   * accepts.
   *
   * The registry is consulted again rather than trusted from the earlier pass,
   * because a module may have been withdrawn or a permission changed between a
   * hydration and a re-screen; an entry with no definition is dropped for the
   * same reason it was there.
   */
  private createLayoutItems(
    aModules: DashboardModuleLayoutItem[]
  ): DashboardLayoutItem[] {
    const definitions = this.getDefinitionsByModuleType();
    const items: DashboardLayoutItem[] = [];

    for (const { cols, moduleType, rows, x, y } of aModules ?? []) {
      const definition = definitions.get(moduleType);

      if (!definition || !this.isModulePermitted(definition)) {
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
   * Only the *cell* is taken from the item the grid hands over, never its size.
   * That item is the library's own drop candidate, minted inside
   * `getValidItemFromEvent` as the configured default footprint and screened at
   * that size, because the library cannot know which module is being dragged. The
   * module's real footprint comes from the registry and can be much larger - up to
   * the full width and ten rows - so the item that actually goes onto the canvas
   * has to be screened again, at its own size, before it is admitted.
   * {@link placeModule} does that; nothing here assumes the released cell will
   * accept it.
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
   * The grid has drawn a cell for the first time.
   *
   * Only the module the viewer just placed is brought into view, matched by
   * identity against the object this component put into the arrangement. Every
   * other first paint - and hydration produces one per saved module - is ignored,
   * which is precisely what the library's own scroll option could not do.
   */
  private handleItemInit(aItem: GridsterItemConfig) {
    if (!this.pendingRevealItem || aItem !== this.pendingRevealItem) {
      return;
    }

    const item = this.pendingRevealItem;

    this.pendingRevealItem = null;

    this.revealPlacedModule(item);
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
   * Whether two permission sets differ.
   *
   * Compared as sets rather than as sequences, because the store hands back a
   * fresh array on every emission and the order within it is not part of the
   * contract - comparing by reference would report a change on every settings
   * write, and comparing element by element would report one on a reordering
   * that means nothing. Both arguments are optional: a viewer resolved before
   * their permissions were known has none, and treating that as different from
   * an empty set would re-screen the canvas for no reason.
   */
  private hasPermissionsChanged(
    aPreviousPermissions: string[] = [],
    aPermissions: string[] = []
  ): boolean {
    if (aPreviousPermissions.length !== aPermissions.length) {
      return true;
    }

    const previous = new Set(aPreviousPermissions);

    return aPermissions.some((permission) => !previous.has(permission));
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
    const generation = ++this.hydrationGeneration;

    this.hasHydratedLayout = true;
    this.hasLayoutError = false;

    this.dashboardLayoutService
      .get(force)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        error: () => {
          if (generation !== this.hydrationGeneration) {
            return;
          }

          // A failed read is not an empty arrangement and is never reported as
          // one: that would open the catalog as though this were a first visit,
          // and the first module added afterwards would be written out as the
          // viewer's whole arrangement, erasing everything the read failed to
          // fetch. Its own state is entered instead - a notice and a retry - and
          // the canvas is marked ready so it does not hang on a blank frame.
          this.hasLayoutError = true;
          this.isInitialized = true;

          this.changeDetectorRef.markForCheck();
        },
        next: (layout) => {
          // A response for a read that is no longer the current one belongs to a
          // viewer who is no longer on screen. Applying it would replace the
          // present viewer's arrangement with somebody else's, so it is dropped.
          if (generation !== this.hydrationGeneration) {
            return;
          }

          this.applyLayout(layout);
        }
      });
  }

  /**
   * Absence of a declared permission means a module is unconditionally visible.
   * Nothing is special-cased by name: the registry metadata is the entire rule, and
   * the catalog applies the same check independently. Neither affects server-side
   * authorization, which gates the data regardless.
   */
  private isModulePermitted({
    permission
  }: DashboardModuleDefinition): boolean {
    return !permission || hasPermission(this.user?.permissions, permission);
  }

  /**
   * Whether a fetched document can be interpreted at all.
   *
   * Two things make it unreadable, and neither can be worked around by dropping
   * an entry. A `modules` member that is not an array cannot be iterated, and the
   * previous form did iterate it - inside the success handler of the read, which
   * is the one place a failure must not surface, because the canvas has already
   * concluded the read succeeded. And a version this build does not know describes
   * a shape it cannot claim to understand; treating it as readable would let this
   * client rewrite a document a newer one wrote, in an older shape, silently
   * discarding whatever the newer shape carried.
   *
   * An absent version is readable. It is how documents written before the
   * discriminator existed are spelled, and the shape they carry is this one.
   */
  private isReadableLayout({ modules, version }: UserDashboardLayout): boolean {
    return (
      Array.isArray(modules) &&
      (version === undefined || version === SUPPORTED_LAYOUT_VERSION)
    );
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
   * Whether a failure means the session has ended rather than that a request
   * went wrong.
   *
   * Only an unauthorized response does. Treating every failure as a sign-out
   * would put a signed-in viewer in front of the sign-in prompt because one
   * request timed out or one server returned a 500, and would strand them there
   * with credentials that were never actually rejected.
   *
   * A genuine 401 also does not depend on being recognised here: the response
   * interceptor signs out on that status, which reaches this component through
   * the viewer store as an explicit absence. Recognising it is what keeps the two
   * paths from disagreeing.
   */
  private isUnauthorizedError(aError: unknown): boolean {
    return (
      aError instanceof HttpErrorResponse &&
      aError.status === UNAUTHORIZED_STATUS
    );
  }

  /**
   * Rebuilds the whole arrangement from what is on the canvas plus what is
   * legitimately not.
   *
   * This is the projection that gets persisted, and it has to answer one question
   * exactly right: a module that is in the canonical arrangement but has no cell
   * is either a module the viewer *removed*, which must be forgotten, or a module
   * they are not *permitted* to see, which must be kept. Confusing the two costs
   * something either way - forget the second and a lapsed subscription silently
   * deletes modules from the stored arrangement; keep the first and a removed
   * module comes back on the next load. Permission is what tells them apart, and
   * it is the only thing that does, because both are simply absent from the grid.
   *
   * Visible modules come first and take their geometry from grid state, so the
   * grid remains the single authority for everything it draws (Rule 2). Retained
   * hidden modules keep the geometry they were saved with, which is the only
   * geometry they have.
   *
   * Nothing is written from here. This produces the value; `notifyLayoutChange`
   * decides whether a change is worth reporting at all.
   */
  private mergeCanonicalModules(): DashboardModuleLayoutItem[] {
    // Annotated rather than inferred, so `moduleType` widens to the plain string
    // the wire carries instead of staying the typed discriminator. Both halves of
    // this merge have to be comparable, and the canonical half is only ever a
    // string.
    const visible: DashboardModuleLayoutItem[] = this.modules.map(
      ({ cols, moduleType, rows, x, y }) => ({
        cols,
        moduleType,
        rows,
        x,
        y
      })
    );

    const visibleModuleTypes = new Set(
      visible.map(({ moduleType }) => moduleType)
    );

    // Reached through the string-keyed map rather than the registry's own typed
    // lookup, for the same reason every other path that starts from a persisted
    // discriminator does: what is held here is the plain string the wire carries,
    // and the map is what narrows it without a type assertion.
    const definitions = this.getDefinitionsByModuleType();

    const retainedHidden = this.canonicalModules.filter(({ moduleType }) => {
      if (visibleModuleTypes.has(moduleType)) {
        return false;
      }

      const definition = definitions.get(moduleType);

      // Kept only while it is the *permission* that is keeping it off the canvas.
      // A definition that has disappeared from the registry is dropped for the
      // same reason hydration drops it, and a permitted module with no cell is a
      // module the viewer removed.
      return !!definition && !this.isModulePermitted(definition);
    });

    return [...visible, ...retainedHidden];
  }

  /**
   * Records that the viewer is resolved and not signed in.
   *
   * Signing out ends an identity, so it is one, and the layout service is told
   * before anything else happens: that withdraws write authorisation and
   * discards whatever was still pending. Discarding it is the only correct
   * outcome rather than a compromise - the token is already gone by the time the
   * store reports the absence, so a pending write could only answer 401.
   *
   * The arrangement is then invalidated the same way every other transition
   * invalidates it, with writes refused first. Order is what makes that safe:
   * emptying the array destroys every `gridster-item`, each destruction invokes
   * the grid's item-removed callback, and a callback that was still able to
   * report would schedule a write of an empty arrangement and erase what the
   * viewer had saved. `notifyLayoutChange` refuses while signed out for the same
   * reason, so the guard is doubled deliberately.
   *
   * Suspending explicitly rather than leaning on the transition this method
   * announces is also deliberate: the viewer store is subscribed before the
   * transition stream is, so an absence reported by the store's very first
   * emission would arrive here while nothing is listening to that stream yet.
   */
  private markSignedOut() {
    this.dashboardLayoutService.beginIdentityTransition();

    this.hasViewerError = false;

    this.suspendCanvas();

    this.hasLayoutError = false;
    this.isSignedOut = true;
    this.user = null;

    this.changeDetectorRef.markForCheck();
  }

  /**
   * The one place a layout write is scheduled from, and nothing outside this
   * component can reach it.
   *
   * Reached from exactly one place: the `onLayoutChange` handler the grid
   * configuration is built with, which all four of the engine's change callbacks -
   * change, resize, init and remove - forward to. No other method in this component
   * calls it, which is what makes those four callbacks the entire set of write
   * origins rather than merely the usual ones. The canvas's own add and remove
   * paths reach it the same way as everything else: they mutate the array, the
   * engine settles the cells and reports it.
   *
   * Suppressed unless the arrangement is actually on screen. Destroying the
   * canvas - signing out, or following a shared link - destroys every grid item,
   * and every one of those destructions invokes the item-removed callback. Those
   * are teardown rather than intent, and reporting them would schedule a write
   * that reflects nothing the viewer did.
   *
   * Suppressed again unless the arrangement actually differs from the one last
   * reported. The grid does not only report intent: its init callback fires once
   * per cell while a saved arrangement is being drawn, and its resize callback
   * fires on pixel reflow, so merely opening the catalog drawer produces one
   * trigger per placed module. None of those changes where anything sits, and
   * each would otherwise schedule a write. Comparing the canonical projection is
   * what lets all four callbacks remain wired - which the persistence contract
   * requires - while only a real change reaches the write path.
   *
   * Nothing else happens here. The comparison is a projection of at most
   * twenty-one five-field objects, which is negligible beside the interaction it
   * follows, and the callbacks fire once per settled interaction rather than per
   * frame; anything genuinely expensive on this path would eat into the budget
   * the drag is measured against.
   */
  private notifyLayoutChange() {
    if (
      !this.isInitialized ||
      this.hasLayoutError ||
      this.isPublicPortfolio ||
      this.isSignedOut
    ) {
      return;
    }

    const fingerprint = this.createLayoutFingerprint();

    if (fingerprint === this.lastReportedLayout) {
      return;
    }

    this.lastReportedLayout = fingerprint;

    // Vetted before anything is recorded or scheduled. A held drag can leave the
    // engine's auto-scroll to carry a module tens of rows past the arrangement,
    // and the engine commits that like any other drag; persisting it would store
    // a module nobody can reach. A correction is pushed back through the engine
    // and reported through this very method, so when one happens the pass that
    // reported the runaway steps aside and lets the corrected pass have the last
    // word - which is what the return value says.
    if (this.clampRunawayPlacement()) {
      return;
    }

    // Refreshed here, and only here, so the arrangement that gets persisted is
    // always the current one. Holding the *fetched* document instead left it
    // stale from the first edit onwards, which mattered twice over: the snapshot
    // sent to the server would have described the canvas as it was loaded rather
    // than as it is, and a permission granted later would have re-admitted a
    // module at a position the viewer had long since moved away from. Recomputing
    // it from grid state on every reported change removes the possibility of
    // staleness rather than shortening its window - which also subsumes
    // refreshing it when a write is acknowledged, because the server echoes back
    // exactly the document it was sent.
    this.canonicalModules = this.mergeCanonicalModules();

    // Reached only once the engine has settled the cells, which is the earliest
    // point at which the grid's own view of what is placed agrees with the array
    // - and therefore the earliest point at which asking it what still fits gives
    // a true answer. Doing this where the array is mutated instead would probe a
    // grid that had not seen the change yet.
    //
    // Deliberately not a save trigger and not a second write origin: this reads
    // the arrangement and tells the catalog about it. The write below is
    // unaffected.
    if (this.isCatalogOpen) {
      this.refreshCatalogAvailability();
    }

    this.layoutChange$.next();
  }

  /**
   * Fits one stored geometry to the grid and to its module's declared minimum.
   *
   * Returns `null` for a geometry that cannot describe a cell - a coordinate that
   * is not a whole number - because there is nothing to clamp such a value to.
   * Everything else is brought inside the grid rather than rejected, so a stored
   * arrangement keeps its modules.
   *
   * The order of the clamping matters. The footprint is settled first, against the
   * module's declared minimum on one side and the grid's own extent on the other;
   * the origin is then settled against what that footprint leaves, so the result
   * always satisfies `x + cols <= 12` and `y + rows <= 100`. Doing it the other way
   * round would settle an origin the footprint then overflows.
   *
   * A module whose declared minimum exceeds the grid is not representable, and the
   * bound below resolves that in the grid's favour rather than silently producing
   * an item the engine would refuse: the registry is the thing at fault in that
   * case, and every entry in it is well within twelve columns.
   */
  private normalizeGeometry(
    aDefinition: DashboardModuleDefinition,
    aGeometry: { cols: number; rows: number; x: number; y: number }
  ): { cols: number; rows: number; x: number; y: number } | null {
    const { cols, rows, x, y } = aGeometry;

    if (
      !Number.isInteger(cols) ||
      !Number.isInteger(rows) ||
      !Number.isInteger(x) ||
      !Number.isInteger(y)
    ) {
      return null;
    }

    const normalizedCols = Math.min(
      GRID_COLUMNS,
      Math.max(cols, aDefinition.minItemCols)
    );
    const normalizedRows = Math.min(
      GRID_ROWS,
      Math.max(rows, aDefinition.minItemRows)
    );

    return {
      cols: normalizedCols,
      rows: normalizedRows,
      x: Math.min(Math.max(x, 0), GRID_COLUMNS - normalizedCols),
      y: Math.min(Math.max(y, 0), GRID_ROWS - normalizedRows)
    };
  }

  /**
   * Tells the grid engine to recompute its layout whenever its own host box
   * changes size.
   *
   * The engine binds a `window` resize listener and has no element observer of
   * its own, so it only ever learns about size changes that the viewport caused.
   * On this canvas that is not enough. The grid lives inside the drawer
   * container's content pane, and opening the catalog drawer resizes that pane by
   * changing its margin - the window never changes, so the engine never
   * recalculates, and it keeps positioning modules at the pitch of the wider box.
   * The visible result is a strip of the canvas that runs underneath the drawer,
   * with the right-hand modules clipped, and it does not correct itself when the
   * drawer closes either.
   *
   * `onResize` is the engine's own public entry point for exactly this - the same
   * one its window listener calls - so this adds no new layout policy, it only
   * supplies the trigger the engine is missing.
   *
   * @param aGridster the engine instance, taken from its init callback rather
   * than a view query, because that callback is the only point at which the
   * engine is guaranteed to have both an element and a measured size.
   */
  private observeGridsterViewport(aGridster: Gridster) {
    // Feature-detected rather than assumed. The observer is a browser API and
    // this component is also instantiated under a DOM shim in tests, where it is
    // absent; without the guard the grid would fail to initialize there. Nothing
    // is lost by its absence - the engine's own window listener still runs.
    if (typeof ResizeObserver === 'undefined' || !aGridster?.el) {
      return;
    }

    // Replaced rather than added to, so a re-initialized grid - a viewer change
    // tears the grid down and rebuilds it - never leaves an observer watching the
    // previous host. {@link releaseGridster} already severs it when the grid it
    // watches is destroyed; this covers the rebuild, where the incoming grid
    // initializes BEFORE the outgoing one is destroyed and the outgoing
    // destruction is therefore declined by that method's identity guard.
    this.gridsterResizeObserver?.disconnect();

    this.gridsterResizeObserver = new ResizeObserver(() => {
      const { clientHeight, clientWidth } = aGridster.el;

      // The guard that makes this safe against feedback. `onResize` re-measures
      // the host and writes the result back to `curWidth`/`curHeight`, and
      // laying out the items can itself change the host's box - so an
      // unconditional call would be observed as another change and recur.
      // Comparing against the size the engine has already accounted for means a
      // reflow the engine caused is recognised as settled and stops here.
      if (
        clientHeight === aGridster.curHeight &&
        clientWidth === aGridster.curWidth
      ) {
        return;
      }

      aGridster.onResize();
    });

    this.gridsterResizeObserver.observe(aGridster.el);
  }

  /**
   * Places a module that is not on the canvas yet, or brings the one that is
   * into view.
   *
   * Where it goes is settled by the grid engine, at the module's own declared
   * footprint, before the item is admitted - see {@link settleItemPosition}. An
   * item the engine will not accept anywhere is not added at all, because the
   * array this appends to is the authoritative one and is what gets persisted.
   *
   * @param aDefinition the registry definition; its declared footprint is the
   * only source of the item's size.
   * @param aPosition the cell a drop landed on. Omitted for click-to-add, where
   * the grid engine chooses.
   */
  private placeModule(
    aDefinition: DashboardModuleDefinition,
    aPosition?: { x: number; y: number }
  ) {
    // An unread arrangement must not be added to. The array is empty because the
    // read failed, not because the viewer has nothing placed, so appending here
    // would make the next write claim that one module is all they have.
    if (!this.isInitialized || this.hasLayoutError) {
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

    // A refusal here is the engine reporting that this module's footprint does
    // not fit anywhere left on the grid. It has to be surfaced: the item is
    // deliberately not added, so from the viewer's side an unreported refusal is
    // indistinguishable from a click that did nothing, and they would keep
    // clicking.
    if (!this.settleItemPosition(item, aPosition)) {
      this.hasCapacityError = true;

      this.canvasAnnouncement = $localize`There is no room left on the dashboard for ${aDefinition.name}:moduleName:. Remove or resize a module to make space.`;

      this.changeDetectorRef.markForCheck();

      return;
    }

    // Cleared on success, not on the next refusal: a viewer who freed space and
    // placed something has resolved the condition, and the notice must go with
    // it.
    this.hasCapacityError = false;

    // A drop whose released cell was already occupied is relocated to the next
    // free one, and that has to be said rather than done quietly: the module
    // appears somewhere other than where the pointer let go, which without a word
    // reads as the drop having missed. Click-to-add has no released cell to
    // differ from, so it only ever reports where the module landed.
    const isRelocated =
      !!aPosition && (item.x !== aPosition.x || item.y !== aPosition.y);

    this.canvasAnnouncement = isRelocated
      ? $localize`${aDefinition.name}:moduleName: did not fit where it was dropped and was added at column ${item.x + 1}:column:, row ${item.y + 1}:row:`
      : $localize`${aDefinition.name}:moduleName: added to the dashboard at column ${item.x + 1}:column:, row ${item.y + 1}:row:`;

    // Released before the cell is drawn, because the engine reads the option on
    // entry to the size computation that draws it. This is the one case the grid's
    // own reveal is meant for: a module the viewer asked for, which may well land
    // below the fold.
    this.applyNewItemReveal(true);

    this.modules.push(item);

    // Marked for reveal before the array is even seen by the template: the cell
    // does not exist yet, so the grid reporting its first paint is the earliest
    // moment it can be brought into view. Only this item is marked, which is why
    // hydration - whose cells report the very same first paint - scrolls nothing.
    //
    // Nothing is reported from here. The pushed item renders a new
    // `gridster-item` and the engine reports its initialization through
    // `itemInitCallback`, once the cell has actually been laid out, which is the
    // moment the arrangement is genuinely worth saving.
    this.pendingRevealItem = item;

    this.changeDetectorRef.markForCheck();
  }

  /**
   * Lets go of a grid engine that has been torn down.
   *
   * This canvas OUTLIVES its grid. Four of its states draw no grid at all - a
   * shared portfolio, a signed-out viewer, a failed viewer read and a failed
   * layout read - so entering any of them destroys the `gridster` child while the
   * canvas carries on. Everything the canvas had taken from that instance has to
   * be given back at that moment rather than at the canvas's own teardown:
   *
   * - the element observer, which is registered against the destroyed instance's
   *   host and would otherwise stay connected to a detached element, holding it
   *   and a closure over a dead engine, and would call `onResize` on that engine
   *   the next time the element was measured;
   * - the instance reference itself, because every one of its uses answers a
   *   question about the grid CURRENTLY on screen - is there room for this module,
   *   which cell does this item occupy - and a destroyed engine answers all of
   *   them from a layout nobody can see.
   *
   * Guarded on identity rather than clearing outright, and that is what makes it
   * safe: a rebuild initialises the incoming grid BEFORE destroying the outgoing
   * one, so an unconditional clear would discard the live instance and leave the
   * canvas with no engine while a grid was on screen.
   *
   * Every reader of {@link gridster} already treats its absence as "no grid yet",
   * which is the same answer as "no grid any more", so nothing downstream needs a
   * new branch.
   *
   * @param aGridster the instance the engine reports as destroyed.
   */
  private releaseGridster(aGridster: Gridster) {
    if (this.gridster !== aGridster) {
      return;
    }

    this.gridsterResizeObserver?.disconnect();
    this.gridsterResizeObserver = null;

    this.gridster = null;
  }

  /**
   * Works out which unplaced modules the grid has no room for, so the catalog can
   * say so before a viewer clicks a row that cannot succeed.
   *
   * Each candidate is offered to the engine exactly as click-to-add would offer
   * it - same footprint, same method, no position - so what the catalog shows and
   * what an add actually does can never disagree. The probe is answered against a
   * throwaway item, because the engine replies by writing the position it found
   * onto the item it is handed.
   *
   * Called only when the arrangement has settled or the drawer is opening, never
   * from a getter: the cost is one grid scan per unplaced module, which is fine
   * once per user action and ruinous once per change-detection pass.
   */
  private refreshCatalogAvailability() {
    // No grid means nothing is full. The engine has not initialized during
    // hydration, and `settleItemPosition` deliberately admits everything in that
    // state, so reporting anything as unavailable here would contradict it.
    if (!this.gridster) {
      this.unavailableModuleTypes = [];

      return;
    }

    const placedModuleTypes = new Set(
      this.modules.map(({ moduleType }) => moduleType)
    );

    this.unavailableModuleTypes = this.moduleRegistryService
      .getAll()
      .filter((definition) => {
        // A placed module is never unavailable: its row reveals what is already
        // on the canvas rather than adding anything, so it always has somewhere
        // to go.
        return (
          !placedModuleTypes.has(definition.moduleType) &&
          !this.settleItemPosition(this.createLayoutItem(definition))
        );
      })
      .map(({ moduleType }) => moduleType);
  }

  /**
   * Re-mounts every module currently on the canvas, so each re-reads its own data.
   *
   * Delegated to the chrome that owns the mounting rather than done here: the host
   * is the only thing that holds a resolved component, and re-creating it is how a
   * module is made to fetch again without this component knowing what any module
   * fetches. The arrangement is untouched - no cell is moved, resized, added or
   * removed - so no grid callback fires and nothing is written.
   *
   * Silent when nothing is placed, which is correct rather than a guard against a
   * crash: there is nothing to refresh, and the request is not an error.
   */
  private reloadPlacedModules() {
    this.moduleHosts?.forEach((host) => {
      host.reload();
    });
  }

  /**
   * Returns the canvas to its pre-load state because a different viewer has
   * arrived.
   *
   * The order is the behaviour. Clearing readiness first means the grid is torn
   * down while nothing is reportable, so the item-removed callback each
   * destroyed cell fires is recognised as teardown rather than as the outgoing
   * viewer deleting their modules. Clearing the reported fingerprint last means
   * the incoming arrangement is compared against nothing rather than against
   * somebody else's.
   *
   * The canonical arrangement goes with the rest, and it must: it is what a write
   * is built from, so an entry left behind from the outgoing viewer would be
   * persisted into the incoming viewer's account the first time they moved
   * anything.
   */
  private resetForViewerChange() {
    this.hasLayoutError = false;
    this.isInitialized = false;

    this.modules.length = 0;
    this.canonicalModules = [];

    this.lastReportedLayout = null;
    this.pendingRevealItem = null;
  }

  /**
   * Asks for the viewer, but only if nobody has answered yet.
   *
   * Three answers have to stay apart. A viewer already adopted and a viewer known
   * to be absent both leave `user` defined and neither needs asking again;
   * `undefined` means nothing has answered, and reading that as an absence is what
   * would open the catalog on somebody else's behalf.
   *
   * The store subscription in the constructor is established before this can
   * first run and delivers the store's current value the moment it is
   * subscribed, so by here `user` already reflects anything the store knew - the
   * route guard's own fetch included. That ordering is why this needs no reading
   * of the store, whose state accessor is not public anyway.
   *
   * Both channels of the answer are consumed, and consuming the successful one
   * is not redundant. The user service serves an already-fetched viewer straight
   * from its cache, and a cache hit does *not* dispatch through the store - so
   * for that answer the constructor's subscription never fires and this is the
   * only place the viewer arrives. It is the reachable case rather than an
   * exotic one: while a shared portfolio is being shown the store's emissions are
   * ignored on purpose, and the moment the share parameter is dropped from the
   * URL this method asks for a viewer the store has been holding all along.
   * Without the success channel the canvas would adopt nobody, hydrate nothing,
   * and match none of its four states.
   *
   * Routing the answer through the same interpreter as a store emission is what
   * keeps the two paths from disagreeing, and it is idempotent: a fetched viewer
   * arrives twice - once as the store dispatches, once here - and the second
   * arrival adopts the identity that is already held, which changes nothing.
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
        error: (error: unknown) => {
          // Only a rejected session means signed out. Everything else - a
          // timeout, a gateway error, a server fault - leaves credentials that
          // are still perfectly valid, and answering it with the sign-in prompt
          // would tell the viewer their session had ended when it had not, with
          // no way back but a reload.
          if (this.isUnauthorizedError(error)) {
            this.markSignedOut();

            return;
          }

          this.hasViewerError = true;

          this.changeDetectorRef.markForCheck();
        },
        next: (aUser: User) => {
          // The success channel is consumed as well as the failure one, and it has
          // to be: the user service answers from its own cache *without*
          // dispatching through the store, so a viewer that was already resolved -
          // by the route guard, before this canvas began observing - is announced
          // nowhere else. That is the case a dismissed share link lands in, because
          // store emissions are ignored for as long as the shared portfolio is on
          // screen, and consuming only the failure channel left it with no viewer,
          // no arrangement and none of its states matching: a blank screen.
          //
          // Routed through the same handler as a store emission so the shared
          // guard and the resolved/absent distinction live in one place, and
          // applied only while nothing has resolved yet so the ordinary path -
          // where the fetch dispatches and the store delivers - is not answered a
          // second time.
          if (this.user === undefined) {
            this.handleViewerState(aUser);
          }
        }
      });
  }

  /**
   * Moves keyboard focus onto the neighbour chosen before the removal, once the
   * canvas has actually redrawn without the removed module.
   *
   * Deferred to a task rather than run inline, and the delay is doing real work in
   * two directions. The removal is requested from a menu item, and the menu's own
   * trigger - which lives inside the module about to disappear - is re-focused
   * synchronously as the menu closes, right after this handler returns. And the
   * module is still on screen at that point: the array has been spliced but the
   * view has only been marked, so the cell is not gone until the next change
   * detection pass takes it. Focusing now would therefore be overwritten by the
   * menu a moment later, and then dropped to the document body when the element
   * holding it was removed - which is exactly the reported defect. A task runs
   * after both, so this is the last word on where focus sits.
   *
   * The target is not re-derived here on purpose: it was captured while the
   * removed module was still in the query, and the element it names stays in the
   * document throughout, so nothing about it goes stale.
   *
   * Every candidate reports whether focus landed, and the next one is tried when
   * it did not, because `focus()` on a detached or hidden element is a silent
   * no-op. The final fallback is the catalog trigger, which survives an emptied
   * canvas when no module handle does.
   */
  private restoreFocusAfterRemoval(
    aTarget: GfDashboardModuleHostComponent | null
  ) {
    // Cleared on teardown so a removal in the last moments of this component's
    // life cannot reach into a destroyed view.
    window.clearTimeout(this.focusRestorationHandle);

    this.focusRestorationHandle = window.setTimeout(() => {
      this.focusRestorationHandle = undefined;

      if (aTarget?.focusDragHandle()) {
        return;
      }

      this.catalogTrigger?.nativeElement.focus();
    });
  }

  /**
   * Chooses where keyboard focus should go once a module is removed.
   *
   * The next module in reading order, failing that the previous one, and failing
   * both of those nothing - which leaves the caller with the catalog trigger. The
   * next one first because that is where the eye already is: the modules after the
   * removed one shift up into the space it leaves, so the module that takes its
   * place is the one now under the cursor's former position.
   *
   * Located through the rendered chrome rather than through the placement array,
   * because the two are not the same list. A module whose type the registry no
   * longer knows, or whose permission the viewer no longer holds, keeps its saved
   * placement and is deliberately not drawn - so an index into the array can name
   * a module with no element to focus. The query only ever holds chrome that
   * exists.
   *
   * Definitions are compared by reference, which is sound because the registry
   * hands back one object per module type and the chrome is bound to that very
   * object.
   */
  private resolveFocusTargetAfterRemoval(
    aDefinition: DashboardModuleDefinition | undefined
  ): GfDashboardModuleHostComponent | null {
    const hosts = this.moduleHosts?.toArray() ?? [];

    if (hosts.length <= 1) {
      return null;
    }

    const index = aDefinition
      ? hosts.findIndex(({ definition }) => definition === aDefinition)
      : -1;

    if (index === -1) {
      // The removed module had no chrome of its own, so there is no "next" to
      // speak of. The first drawn module is as good an anchor as any, and is
      // certainly better than the document body.
      return hosts[0] ?? null;
    }

    return hosts[index + 1] ?? hosts[index - 1] ?? null;
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

  /**
   * The one place the catalog drawer is opened or closed.
   *
   * A funnel rather than three assignments, because opening has to answer a
   * question - which rows cannot be added right now - and every route in has to
   * answer it: the floating trigger, the empty-canvas affordance, and the drawer
   * closing itself on Escape. Anything that set the flag directly would show a
   * catalog whose rows described a previous arrangement.
   */
  private setCatalogOpen(aIsOpen: boolean) {
    this.isCatalogOpen = aIsOpen;

    // Only on the way open. Recomputing on close would be work whose result
    // nothing can see, and the next open recomputes anyway.
    if (aIsOpen) {
      this.refreshCatalogAvailability();
    }

    this.changeDetectorRef.markForCheck();
  }

  /**
   * Settles where an item goes, and reports whether it goes anywhere at all.
   *
   * The engine decides, at the item's own size, and it is asked about *this* item
   * rather than about a stand-in. That distinction is the whole reason this exists
   * separately from the drop handler. A drag out of the catalog is screened by the
   * library against a candidate it minted itself at the configured default
   * footprint, because it cannot know which module is on the pointer; the module's
   * declared footprint is frequently larger, so the fact that the preview fitted
   * says nothing about whether the real item does. Admitting it on the strength of
   * that preview is how an item wider than the grid, or one lying across a
   * neighbour, would reach the authoritative array and then be persisted.
   *
   * `checkCollision` is the engine's own single answer to "may this go here": it
   * consults the minimum-footprint predicate first, then the grid bounds and the
   * per-item limits, then every item already placed. A falsy answer means the
   * released cell accepts the item exactly as it is, and the cell the user chose
   * is kept.
   *
   * Otherwise the engine is asked for somewhere the item does fit.
   * `getNextPossiblePosition` writes the cell onto the item and reports whether
   * one existed, and it must be called on the component instance: the identically
   * named member of the `GridsterApi` surface returns `void`, so its answer could
   * neither be acted on nor asserted. For a drop, the scan starts at the released
   * row so the module lands at or below where it was let go rather than jumping to
   * the top of the canvas; for click-to-add there is no released row and the first
   * free cell is the right answer. `false` means there is nowhere at all, and the
   * correct response to that is to add nothing rather than to overlap something.
   *
   * With no instance - possible only before the grid has ever rendered, so never
   * on a drop - the item keeps the origin it was minted with and the engine's own
   * `addItem` settles it on init through this very routine, which is why nothing
   * is computed here in that case either.
   *
   * @param aItem the item that will actually be added; mutated in place with the
   * cell it ends up at, exactly as the engine mutates the items it owns.
   * @param aPosition the released cell, when there was one.
   */
  private settleItemPosition(
    aItem: DashboardLayoutItem,
    aPosition?: { x: number; y: number }
  ): boolean {
    if (!this.gridster) {
      return true;
    }

    if (aPosition && !this.gridster.checkCollision(aItem)) {
      return true;
    }

    return aPosition
      ? this.gridster.getNextPossiblePosition(aItem, { y: aPosition.y })
      : this.gridster.getNextPossiblePosition(aItem);
  }

  /**
   * Takes the canvas out of service until an arrangement is hydrated onto it
   * again.
   *
   * The barrier every identity change passes through. A read still on its way is
   * invalidated first and unconditionally, because it was started for the
   * identity being replaced and whether anything is currently on the canvas says
   * nothing about whether one is in flight.
   *
   * The clearing itself is delegated, and its ordering is what makes it safe:
   * clearing the readiness flag before emptying the array is what stops the
   * emptying being persisted. `notifyLayoutChange` refuses while that flag is
   * down, so the item-removed callback each destroyed cell fires reports nothing,
   * where an unguarded emptying would schedule a write of an empty arrangement
   * and erase what the previous viewer had saved. It also closes `placeModule`,
   * so an intent arriving mid-transition cannot put a module onto a canvas that
   * is about to be replaced.
   *
   * Idempotent, because it is reached both directly and through the transition
   * stream and neither caller should have to know whether the other has already
   * run. Nothing here re-arms the canvas - only `applyLayout` does, once an
   * arrangement has genuinely arrived.
   */
  private suspendCanvas() {
    this.hydrationGeneration += 1;

    if (!this.isInitialized && this.modules.length === 0) {
      return;
    }

    this.resetForViewerChange();
  }
}
