import { GfPublicPortfolioComponent } from '@ghostfolio/client/components/public-portfolio/public-portfolio.component';
import { DashboardIntentService } from '@ghostfolio/client/core/dashboard-intent.service';
import { LayoutService } from '@ghostfolio/client/core/layout.service';
import { GfAppQueryParams } from '@ghostfolio/client/interfaces/interfaces';
import { UserService } from '@ghostfolio/client/services/user/user.service';
import { getQualifiedDashboardModuleName } from '@ghostfolio/common/dashboard';
import { ConfirmationDialogType } from '@ghostfolio/common/enums';
import { reportSanitizedError } from '@ghostfolio/common/helper';
import {
  DashboardModuleLayoutItem,
  User,
  UserDashboardLayout
} from '@ghostfolio/common/interfaces';
import { hasPermission } from '@ghostfolio/common/permissions';
import { GfLogoComponent } from '@ghostfolio/ui/logo';
import { NotificationService } from '@ghostfolio/ui/notifications';

import { CdkScrollable } from '@angular/cdk/scrolling';
import { HttpErrorResponse } from '@angular/common/http';
import {
  AfterViewInit,
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  CUSTOM_ELEMENTS_SCHEMA,
  DestroyRef,
  ElementRef,
  NgZone,
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
import { alertCircleOutline, closeOutline, gridOutline } from 'ionicons/icons';
import { NgxSkeletonLoaderModule } from 'ngx-skeleton-loader';
import { Subject } from 'rxjs';

import { DashboardModuleType } from '../enums/dashboard-module-type';
import type {
  DashboardLayoutItem,
  DashboardModuleDefinition,
  DashboardModuleGeometry,
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
  GRID_ROWS,
  MODULE_CONTENT_CLASS
} from './dashboard-canvas.config';
import { GfDashboardModuleHostComponent } from './dashboard-module-host/dashboard-module-host.component';
import { GfDashboardToolbarComponent } from './dashboard-toolbar/dashboard-toolbar.component';
import { GfEmptyCanvasStateComponent } from './empty-canvas-state/empty-canvas-state.component';
import { GfSignInPromptComponent } from './sign-in-prompt/sign-in-prompt.component';

// Widened at declaration because `HttpErrorResponse.status` is a plain number,
// which keeps the comparison free of an enum-comparison lint report and a cast.
const CONFLICT_STATUS: number = StatusCodes.CONFLICT;
const UNAUTHORIZED_STATUS: number = StatusCodes.UNAUTHORIZED;

// The only document shape this build can interpret. Anything else is refused
// rather than rewritten in an older shape.
const SUPPORTED_LAYOUT_VERSION = 1;

// A one-pixel slack for the canvas edge marks, because `scrollHeight`,
// `clientHeight` and `scrollTop` are rounded independently and a fractional
// layout otherwise reports a permanent overflow of well under a pixel. The same
// value the module chrome uses for the same measurement.
const CANVAS_OVERFLOW_TOLERANCE = 1;

// The floor every module shares, and the bound a stored entry is brought inside
// when this build has no definition to measure it against - see
// {@link GfDashboardCanvasComponent.createCanonicalModules}. Stated as a
// definition-shaped value so the one normalizer serves both cases.
const GLOBAL_MODULE_MINIMUM = {
  minItemCols: 2,
  minItemRows: 2
} as Pick<DashboardModuleDefinition, 'minItemCols' | 'minItemRows'>;

// Reported when a stored arrangement names more modules than the canvas could
// resolve. Spelled to match the server's own event for the same situation on the
// read path, so one search finds both halves of the round trip.
const LAYOUT_ITEMS_DROPPED_EVENT = 'GF-DASHBOARD-LAYOUT-ITEMS-DROPPED';

/**
 * The single canvas the root route resolves to.
 *
 * It owns the one array of grid items that says where every module sits and how
 * large it is; no module component holds any part of that and there is no
 * second copy. It also owns when an arrangement is worth saving: every trigger
 * converges on one subject here, while the debounce, the wire projection and
 * the HTTP write belong to `GfDashboardLayoutService`.
 *
 * It imports no module component. The only handle on a module class is a lazy
 * thunk held by `GfModuleRegistryService`, which preserves the code-splitting
 * boundary and makes it impossible to place a component without registering it.
 */
@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  // Couples this host to the global grid stylesheet by literal class name.
  // Gridster ships unencapsulated styles with hardcoded colours at
  // element-selector specificity, injected after the application stylesheet, so
  // the overrides need this extra class to outweigh them.
  host: { class: 'gf-gridster' },
  imports: [
    // Registers the grid's own scrolling element with the CDK's `ScrollDispatcher`.
    // Nothing here scrolls differently as a result; what changes is that overlays
    // are told about it. Material positions a menu, tooltip or autocomplete once
    // and then repositions it on scroll events the dispatcher reports - and the
    // dispatcher only knows about ancestors that opted in. The document itself no
    // longer scrolls on this screen, so without this the dispatcher had nothing to
    // report and every overlay stayed pinned to the coordinate its trigger
    // occupied at the moment it opened, while the trigger itself travelled away.
    CdkScrollable,
    GfDashboardModuleHostComponent,
    GfDashboardToolbarComponent,
    GfEmptyCanvasStateComponent,
    GfLogoComponent,
    GfModuleCatalogComponent,

    // Referenced ONLY inside the template's `@defer` block, which is what lets
    // Angular emit it - and the charting and map libraries it reaches - as its
    // own chunk.
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
export class GfDashboardCanvasComponent
  implements AfterViewInit, OnDestroy, OnInit
{
  @ViewChildren(GfDashboardModuleHostComponent)
  public moduleHosts: QueryList<GfDashboardModuleHostComponent>;

  // Read as an `ElementRef` explicitly: the reference names a Material button,
  // so the default read would hand back that component rather than its element.
  @ViewChild('catalogTrigger', { read: ElementRef })
  private catalogTrigger: ElementRef<HTMLElement>;

  @ViewChild('catalogDrawer', { read: ElementRef })
  private catalogDrawer: ElementRef<HTMLElement>;

  // Present only while the capacity notice is, so every read of it is guarded.
  // Referenced solely to answer whether it is holding focus at the moment it is
  // dismissed, which decides whether focus has to be handed on.
  @ViewChild('capacityNoticeDismiss', { read: ElementRef })
  private capacityNoticeDismiss: ElementRef<HTMLElement>;

  // The drawer container's content pane, which is the canvas's INLINE-axis
  // scrollport - a different element from the engine's host, which is the
  // block-axis one.
  @ViewChild('canvasPane', { read: ElementRef })
  private canvasPane: ElementRef<HTMLElement>;

  @ViewChild(GfModuleCatalogComponent)
  private moduleCatalog: GfModuleCatalogComponent;

  // Whether the canvas is scrolled away from, or continues past, its own top and
  // bottom edge. User placement is never auto-compacted, so an arrangement whose
  // upper modules have been removed leaves a tall empty band with the remainder
  // below the fold - and this platform paints overlay scrollbars, so nothing else
  // says so.
  public hasCanvasOverflowAbove = false;

  public hasCanvasOverflowBelow = false;

  public hasCapacityError = false;

  // Set when a write was REFUSED rather than failed: another client of the same
  // account saved while this one was editing. Distinct from a save error because
  // the recovery is a choice rather than a retry - see the notice this drives in
  // `dashboard-canvas.html`.
  public hasConflict = false;

  // An unreadable arrangement is not an empty one. Reporting it as empty would
  // open the catalog as though this were a first visit and let the next module
  // added be written out as the viewer's complete arrangement. While this is
  // set the canvas permits no write of any kind.
  public hasLayoutError = false;

  public hasSaveError = false;

  // Whether the failed read was a document this build cannot interpret, as
  // opposed to a request that did not land. Only the former is worth offering a
  // discard for, and only the latter is worth offering a retry for - so the two
  // are tracked apart even though they draw the same card.
  public isLayoutUnreadable = false;

  // Raised while a discard is in flight, so the control cannot be pressed twice
  // and reports that it is working.
  public isDiscardingLayout = false;

  /**
   * Whether a catalog row is being dragged right now.
   *
   * Held so the empty-canvas notice can be made transparent to the drag. That
   * notice is laid over the grid and its controls sit in the centre of it, which is
   * exactly where a row is dropped onto an empty canvas - so without this the
   * controls swallowed the `dragover` and `drop` the grid needed, and drag-to-add
   * failed on precisely the first visit it is most likely to be tried on.
   *
   * Raised and lowered by the catalog's own drag events, which the canvas already
   * receives in order to size the drop indicator. The end event is raised
   * unconditionally - including for a drag cancelled or released off the grid - so
   * this cannot be left stuck raised.
   */
  public isCatalogDragInProgress = false;

  /**
   * Whether the visitor arrived back from a federated sign-in that produced no
   * identity.
   *
   * Latched from the address once on initialization rather than derived from it,
   * because the parameter is removed immediately afterwards - a value read from the
   * URL would disappear along with it. It survives until the visitor navigates
   * away or signs in, which is exactly as long as the sentence is true.
   */
  public hasSignInError = false;

  public hasViewerError = false;

  // The single polite live region on this surface. Two on one surface are
  // interleaved by a screen reader in an order neither controls, so every
  // outcome shares this one and each announcement supersedes the last.
  public canvasAnnouncement = '';

  public isCatalogOpen = false;

  // Gates the paint of the authenticated canvas until the viewer and their
  // saved arrangement have both resolved, so no state is shown speculatively.
  public isInitialized = false;

  public isPublicPortfolio = false;

  public isSignedOut = false;

  // The single source of truth for every module's position and size. `readonly`
  // is the point: one array lives for the lifetime of this component and is
  // mutated in place, because gridster writes coordinates straight onto the
  // objects inside it during a drag. Replacing, mirroring or cloning it would
  // lose those writes.
  public readonly modules: DashboardLayoutItem[] = [];

  // Assigned in the constructor because `options` is a *required* signal input
  // the engine reads during its own initialization.
  public options: GridsterConfig;

  // Types only, so no coordinate and no size crosses into the catalog.
  // Recomputed at the two moments it can change rather than derived on read,
  // because the answer costs one engine probe per unplaced module.
  public unavailableModuleTypes: DashboardModuleType[] = [];

  private gridster: Gridster;

  // Released with the instance it watches in {@link releaseGridster}: it holds
  // that instance's host element and a closure over it, and this canvas
  // outlives its grid.
  private gridsterResizeObserver: ResizeObserver | null = null;

  // The engine's own host, which is the canvas scrollport. Held so the scroll
  // listener can be removed from the exact element it was added to, since this
  // canvas outlives its grid.
  private gridsterScrollElement: HTMLElement | null = null;

  // The host box the grid observer last asked the engine to lay out at.
  //
  // Held here rather than read back off the engine because the engine's own
  // `curWidth`/`curHeight` are a measurement cache that any caller of
  // `setGridDimensions()` refreshes without laying anything out - see the long
  // note in {@link observeGridsterViewport}. `null` means this observer has not
  // acted yet, so its first notification always does.
  private lastObservedGridsterHeight: number | null = null;

  private lastObservedGridsterWidth: number | null = null;

  private isCanvasOverflowCheckScheduled = false;

  private focusRestorationHandle: number | undefined;

  // Where focus was when the panel opened, so it can be handed back when the
  // panel closes. `null` is a real answer and not an absence: it is what an open
  // the canvas offered unprompted records, because nothing was focused, and the
  // close path answers it with the floating trigger.
  //
  // There used to be a companion flag distinguishing a viewer-requested open
  // from an unprompted one, and only the requested one moved focus into the
  // panel. That made the panel behave differently depending on how it had opened
  // - auto-opened, it appeared with its search field unfocused and unringed;
  // opened from the trigger, focused and ringed - which is the same control
  // giving two different accounts of itself. Every open now moves focus the same
  // way. It is not a theft in the unprompted case either: that case is a canvas
  // with nothing on it, so the search field is the only thing there is to do, and
  // the control bar remains one Shift+Tab behind.

  // A refill of the live region that has not landed yet - see {@link announce}.
  private announcementHandle: number | undefined;

  /**
   * The geometry each module was last known to hold, keyed by module type.
   *
   * It exists to answer two questions the grid engine's change callback cannot: what
   * KIND of change just happened, since the engine reports a move and a resize
   * through the same hook and carries no before-state; and whether this is a change
   * at all rather than a module's first arrival, since an item being placed reports
   * a change before it reports its first paint.
   *
   * Announcement bookkeeping only. Nothing reads it to decide what to draw, what to
   * persist or where anything sits - grid state remains the sole authority on
   * geometry - and it is written in exactly two places: a module's first paint, and
   * the change that follows one.
   */
  private readonly announcedGeometry = new Map<string, string>();

  /**
   * Set for the remainder of the current task once a pointer-driven geometry change
   * has been announced.
   *
   * One gesture can settle more than one module: dragging a card onto an occupied
   * cell swaps the two, and the engine reports both. It reports the module the
   * viewer was dragging FIRST and the one it displaced second - `makeDrag` commits
   * its own item before it commits the swapped one - so keeping the first
   * announcement of each task keeps the one about the module the viewer actually
   * had hold of, rather than replacing it with news about a module they never
   * touched.
   *
   * Cleared on a microtask, which is enough: the engine's follow-up reports are
   * raised synchronously from the same commit, and the next gesture cannot begin
   * before the current task ends.
   */
  private hasAnnouncedGeometryChange = false;

  // Set only while a keyboard step is being pushed through the engine, so the
  // engine's own report of that step is not announced ahead of - and then again
  // by - the step itself. See {@link applyGeometryStep}.
  private isApplyingGeometryStep = false;

  // The one module region currently held still for a resize gesture, kept so the
  // hold can be undone on exactly the element it was taken on - the engine
  // reports the end of a gesture with the same component it reported the start
  // with, but the element is what the hold was written to. Null whenever no
  // resize is in flight, which is the normal state.
  private resizingContentElement: HTMLElement | null = null;

  /**
   * Set for exactly as long as a refresh of every placed module is in progress.
   *
   * Bound into the control bar, which owns the control that starts a refresh but
   * cannot see when it ends - the request travels one way, over the shared reload
   * bus. Without it the control gave no sign it had been received: every module on
   * the canvas dropped its content and re-fetched, which for a viewer is the whole
   * screen blinking, and the control itself looked untouched and pressable
   * throughout.
   */
  public isRefreshing = false;

  private catalogFocusOrigin: HTMLElement | null = null;

  private hasHydratedLayout = false;

  // Raised only while a runaway placement is being corrected, because the
  // correction travels through the engine and is reported back through the
  // handler that requested it. See {@link clampRunawayPlacement}.
  private isClampingPlacement = false;

  /**
   * Raised while the engine settles a freshly applied arrangement, during which a
   * reported change is recorded but never written. See
   * {@link beginHydrationSettle} for why that window has to exist.
   */
  private isHydrationSettling = false;

  private hydrationSettleHandle: number | undefined;

  // The arrangement in full, including modules with no cell because they are
  // not currently permitted. `applyLayout` places only what the viewer may see,
  // so without this the next ordinary edit would report the visible subset as
  // the whole arrangement and the server would delete every module a lapsed
  // subscription had hidden. It is not a second authority over geometry: every
  // module that *is* on the canvas has its entry overwritten from grid state on
  // each reported change.
  private canonicalModules: DashboardModuleLayoutItem[] = [];

  private hasRequestedViewer = false;

  // Incremented before every read, so a response belonging to a previous viewer
  // or attempt is discarded. The layout service's write queue cannot cover
  // this: it orders writes, while each read is a separate subscription made
  // from here.
  private hydrationGeneration = 0;

  // Required rather than an optimisation: the engine invokes its init callback
  // once per cell while a saved arrangement is drawn and its resize callback on
  // every pixel reflow, so a change-free trigger is the common case. Comparing
  // the canonical projection is what lets all four callbacks stay wired while
  // only a genuine change reaches the write path.
  private lastReportedLayout: string = null;

  // The one place a layout change is reported, fed only by the engine's four
  // callbacks and subscribed exactly once. This component never reports a
  // change of its own accord, not even where it mutates the array itself: an
  // added item renders a cell reported through `itemInitCallback` and a removed
  // one destroys a cell reported through `itemRemovedCallback`.
  private layoutChange$ = new Subject<void>();

  private pendingRevealItem: DashboardLayoutItem = null;

  // `undefined` means not resolved yet and `null` means resolved and absent;
  // the two are never conflated. Read for permissions and identity, never for
  // layout.
  private user: User | null | undefined;

  public constructor(
    private changeDetectorRef: ChangeDetectorRef,
    private dashboardIntentService: DashboardIntentService,
    private dashboardLayoutService: GfDashboardLayoutService,
    private destroyRef: DestroyRef,

    private layoutService: LayoutService,
    private moduleRegistryService: GfModuleRegistryService,
    private notificationService: NotificationService,
    private route: ActivatedRoute,
    private router: Router,
    private userService: UserService,
    private zone: NgZone
  ) {
    addIcons({ alertCircleOutline, closeOutline, gridOutline });

    this.options = createDashboardCanvasConfig({
      onEmptyCellDrop: (event, item) => this.handleEmptyCellDrop(event, item),
      onGridsterDestroy: (gridster) => this.releaseGridster(gridster),
      onGridsterInit: (gridster) => {
        this.gridster = gridster;

        this.observeGridsterViewport(gridster);

        // The first moment the question can be answered at all. Availability is a
        // question for the ENGINE - which footprints still fit - so before this
        // there is nobody to ask, and the arrangement it is being asked about has
        // not changed since it was read, so the change path does not ask either.
        // Without this the flags stayed empty from hydration until the panel
        // happened to open, which meant a saturated canvas described itself as
        // having room for everything for as long as nobody looked.
        this.refreshCatalogAvailability();
      },
      onDragGestureStart: () => this.handleDragGestureStart(),
      onItemGeometryChange: (item) => this.handleItemGeometryChange(item),
      onItemInit: (item) => this.handleItemInit(item),
      onLayoutChange: () => this.notifyLayoutChange(),
      onResizeGestureEnd: () => this.handleResizeGestureEnd(),
      onResizeGestureStart: (itemComponent) =>
        this.handleResizeGestureStart(itemComponent)
    });

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

    this.layoutService.shouldReloadContent$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => {
        // Every module on the canvas discards its content and fetches it again,
        // which for a viewer is the whole screen blinking through skeletons and
        // for a reader was nothing at all: the control that started it reports
        // only its own name, and the arrangement it acts on is elsewhere. Said
        // once for the canvas rather than once per module, because one gesture
        // happened - and said BEFORE the work starts, with the companion
        // completion message coming from the refresh itself once it is over.
        this.announce($localize`Refreshing the dashboard`);

        // Deliberately not awaited: the bus has no caller to answer, and the
        // refresh reports its own beginning and end through the busy flag and the
        // live region rather than through this subscription.
        void this.reloadPlacedModules();
      });

    this.dashboardLayoutService.identityTransition$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => {
        this.suspendCanvas();
      });

    this.dashboardLayoutService
      .getHasSaveError()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((hasSaveError) => {
        this.hasSaveError = hasSaveError;

        this.changeDetectorRef.markForCheck();
      });

    this.dashboardLayoutService
      .getHasConflict()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((hasConflict) => {
        this.hasConflict = hasConflict;

        this.changeDetectorRef.markForCheck();
      });

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
        // The complete arrangement, every time, stamped with the viewer it
        // belongs to. `canonicalModules` rather than `modules`, because sending
        // only what has a cell would erase the modules this viewer is not
        // entitled to see. The identity travels with the snapshot because the
        // write happens after a debounce.
        this.dashboardLayoutService.scheduleSave(
          this.user?.id,
          this.canonicalModules
        );
      });
  }

  /**
   * Whether there is a viewer to draw the authenticated surface for.
   *
   * Derived rather than stored, so it cannot fall out of step with the viewer it
   * describes. The distinction it draws is between the two things the canvas
   * waits for: `undefined` is "nobody has answered yet", which is the only state
   * with nothing at all to draw, while a viewer in hand means the control bar and
   * everything else independent of the arrangement can be drawn immediately -
   * whether or not the arrangement itself has arrived, which {@link
   * isInitialized} is what reports.
   *
   * A signed-out answer nulls the viewer and a shared portfolio never asks for
   * one, so both of those states are excluded by this alone; a failed viewer read
   * leaves the previous viewer in place and is excluded by its own branch, which
   * the template puts first.
   */
  public get hasResolvedViewer(): boolean {
    return !!this.user;
  }

  public get placedModuleTypes(): DashboardModuleType[] {
    return this.modules.map(({ moduleType }) => moduleType);
  }

  public ngAfterViewInit() {
    // The first point at which the pane's element exists to be observed; the grid
    // initializes before this. See {@link observeCanvasPane}.
    this.observeCanvasPane();
  }

  /**
   * Whether the stored arrangement holds entries this canvas is not drawing.
   *
   * Two things put an entry in that position and both are retained on purpose: a
   * module the viewer is not currently permitted to see, and a module type this
   * build does not recognise. Retaining them is what stops a lapsed subscription or
   * a renamed module from deleting a saved module - but it also means the stored
   * document can hold entries the viewer can neither see nor reach, and an
   * arrangement nobody can act on is not one they own.
   *
   * This is what the discard control keys on, so that "start over" is offered
   * exactly where there is something invisible to start over from and nowhere else.
   */
  public get hasUnrenderableModules(): boolean {
    const definitions = this.getDefinitionsByModuleType();

    return this.canonicalModules.some(({ moduleType }) => {
      const definition = definitions.get(moduleType);

      return !definition || !this.isModulePermitted(definition);
    });
  }

  public ngOnDestroy() {
    this.gridsterResizeObserver?.disconnect();
    this.gridsterResizeObserver = null;

    this.lastObservedGridsterHeight = null;
    this.lastObservedGridsterWidth = null;

    this.gridster = null;

    this.releaseGridsterScroll();

    // Dropped rather than released: a canvas torn down mid-gesture takes the
    // element with it, so there is nothing left to hand sizing back to and only
    // the reference to let go of.
    this.resizingContentElement = null;

    window.clearTimeout(this.focusRestorationHandle);
    this.focusRestorationHandle = undefined;

    window.clearTimeout(this.announcementHandle);
    this.announcementHandle = undefined;
  }

  public ngOnInit() {
    this.adoptSignInError();

    this.clearJwtQueryParam();

    this.resolveViewer();
  }

  // The registry's own definition object rather than a copy: the module host
  // compares successive definitions by reference to decide whether to fetch a
  // component.
  public getModuleDefinition(
    aModuleType: DashboardModuleType
  ): DashboardModuleDefinition | undefined {
    return this.moduleRegistryService.get(aModuleType);
  }

  public isModuleRenderable({ moduleType }: DashboardLayoutItem): boolean {
    const definition = this.moduleRegistryService.get(moduleType);

    return !!definition && this.isModulePermitted(definition);
  }

  public onAddModule(aModuleType: DashboardModuleType) {
    this.revealOrPlaceModule(aModuleType);
  }

  // The engine reads its default footprint once per hovered cell, so an
  // override left behind would size the next module's indicator from the one
  // dragged before it. A drag cancelled or released outside the grid is the
  // common case, which is why the catalog raises its end event unconditionally.
  public onCatalogDragEnd() {
    this.isCatalogDragInProgress = false;

    this.applyDropPreviewFootprint(
      DEFAULT_DROP_PREVIEW_COLS,
      DEFAULT_DROP_PREVIEW_ROWS
    );

    this.changeDetectorRef.markForCheck();
  }

  public onCatalogDragStart(aModuleType: DashboardModuleType) {
    // Raised before the registry is consulted, and deliberately so: the notice has
    // to stop intercepting the drag even for a type this build cannot size a preview
    // for, or the drop would be swallowed for exactly the entries that already
    // behave least well.
    this.isCatalogDragInProgress = true;

    this.changeDetectorRef.markForCheck();

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
   * Where keyboard focus enters and leaves the catalog.
   *
   * Focus has to be managed at all because a Material drawer in `side` mode
   * moves it in neither direction: its `autoFocus` resolves to `'dialog'`, for
   * which both the take-focus and restore-focus paths return immediately.
   * `side` is not negotiable - an `over` or `push` drawer lays down a backdrop
   * that swallows the native drag events the grid needs.
   *
   * It has to be managed *here* because this is the drawer reporting that its
   * transition has finished; before that the panel is hidden and `focus()` on a
   * hidden element is a silent no-op.
   */
  public onCatalogOpenedChange(aIsOpened: boolean) {
    this.setCatalogOpen(aIsOpened);

    if (aIsOpened) {
      this.moveFocusIntoCatalog();
    } else {
      this.restoreFocusFromCatalog();
    }
  }

  // Clears the notice and nothing else. It writes no layout, touches no module
  // and does not close the catalog: the refusal it reported has already happened,
  // and dismissing a message about it is not an instruction to do anything about
  // it. The live-region sentence is cleared with it so a screen reader is not
  // left able to re-read an answer the viewer has retired.
  /**
   * Dismissing the notice removes the button that dismissed it, so the focus it
   * was holding has to be handed somewhere before the element carrying it goes
   * away. Left alone the browser drops focus to the document body, and the next
   * Tab then restarts from the top of the page - not a trap, since focus can
   * still be moved, but it costs a keyboard viewer their position for no reason,
   * and this is the one control here that can only be reached deliberately.
   *
   * Read BEFORE the flag is cleared, because that is the only moment the button
   * is still connected and still the active element; afterwards the `@if`
   * removes it and the answer is always no. Moved synchronously rather than
   * deferred for the same reason - the destination is already in the document,
   * so it can take focus while the notice is still standing, which is what stops
   * the drop happening at all rather than repairing it afterwards.
   *
   * The floating trigger is the destination on the same grounds it is the
   * fallback everywhere else in this component: it is the one control nothing the
   * viewer does to the arrangement can remove, and it is what raised the
   * add-a-module intent this notice is answering, so focus lands back where the
   * interaction began.
   */
  public onDismissCapacityNotice() {
    const dismiss = this.capacityNoticeDismiss?.nativeElement;

    const hadFocus =
      !!dismiss && dismiss.ownerDocument?.activeElement === dismiss;

    this.hasCapacityError = false;

    this.canvasAnnouncement = '';

    this.changeDetectorRef.markForCheck();

    if (hadFocus) {
      this.catalogTrigger?.nativeElement.focus();
    }
  }

  public onOpenCatalog() {
    this.setCatalogOpen(true);
  }

  /**
   * Discards the stored arrangement and starts again from an empty canvas.
   *
   * The escape from a document this build cannot interpret, and the only way to
   * clear entries the canvas is holding but cannot draw. It is deliberately NOT a
   * layout write: nothing is stored, so this cannot invent an arrangement, and the
   * single-write-origin rule - a layout is written only as the result of a grid
   * state change - is untouched. That distinction is the whole reason the endpoint
   * behind it is a DELETE.
   *
   * Behind a confirmation because it is irreversible and destructive, and the
   * viewer is the only one who can weigh that: the stored document may be perfectly
   * good and merely newer than this build.
   */
  public onDiscardLayout() {
    if (this.isDiscardingLayout) {
      return;
    }

    this.notificationService.confirm({
      confirmFn: () => {
        this.discardLayout();
      },
      confirmLabel: $localize`Discard`,
      confirmType: ConfirmationDialogType.Warn,
      message: $localize`Your saved dashboard will be permanently deleted and you will start with a blank one. This cannot be undone.`,
      title: $localize`Start over with a blank dashboard?`
    });
  }

  /**
   * Takes the arrangement another client of this account saved, discarding the one
   * this canvas is holding.
   *
   * A re-read rather than a merge: a layout is a whole document, and the two
   * candidates differ in ways only the viewer can adjudicate. The retained snapshot
   * is dropped first, so nothing later flushes the arrangement just abandoned.
   */
  public onReloadLayoutAfterConflict() {
    this.dashboardLayoutService.dismissConflict();

    this.hasConflict = false;

    this.onRetryLayout();
  }

  public onRetryLayout() {
    this.hasLayoutError = false;
    this.isLayoutUnreadable = false;
    this.isInitialized = false;

    this.modules.length = 0;
    this.canonicalModules = [];
    this.lastReportedLayout = null;

    this.changeDetectorRef.markForCheck();

    this.hydrateLayout();
  }

  // Keeps what is on screen and writes it over the newer document, which the
  // layout service expresses by dropping the revision this arrangement was built
  // on. The canvas neither rebuilds nor re-projects the arrangement: the snapshot
  // the service is already holding is the one the viewer is looking at.
  public onOverwriteLayoutAfterConflict() {
    this.dashboardLayoutService.overwriteAfterConflict();
  }

  public onRetrySave() {
    this.dashboardLayoutService.retryFailedSave();
  }

  /**
   * The way OUT of a failed write: abandon the arrangement that could not be
   * stored and put the stored one back on screen.
   *
   * Without it the failure had no terminal state. The banner offered a retry and
   * nothing else, so a write the server will refuse every time - a document it
   * cannot accept, an account whose session has moved on - left the viewer holding
   * an arrangement that was not saved, being told so, and pressing the only
   * control there indefinitely. And because what is on screen is the arrangement
   * that failed, the screen and the server disagreed for as long as that lasted,
   * which is the whole of what {@link onRetrySave} cannot resolve on its own.
   *
   * It performs no write, and that matters: dropping the retained snapshot is what
   * makes it safe, because nothing is then left to flush the abandoned arrangement
   * later. The re-read is an ordinary hydration, forced rather than served from
   * cache, so the canvas ends up showing exactly what the server holds - which is
   * the reconciliation the failure state was missing.
   *
   * The flag is lowered here as well as by the service's own emission, so the
   * banner goes with the arrangement it was describing rather than one frame after
   * it.
   */
  public onDiscardFailedSave() {
    this.dashboardLayoutService.discardFailedSave();

    this.hasSaveError = false;

    this.onRetryLayout();
  }

  /**
   * Leaves a failed read behind and gives the viewer an empty canvas to arrange.
   *
   * The state this recovers from is reachable and is not always transient. A
   * stored document the server refuses - an envelope it cannot read, or a version
   * discriminator from a build ahead of this one, which is precisely what the
   * version field exists to allow - fails identically on every attempt, so a
   * retry is not a way out of it. Without this the arrangement, the catalog and
   * the catalog trigger are all withheld, and the only remedies left are signing
   * out or having somebody repair the row: the write that would fix it succeeds
   * at the endpoint and was simply unreachable from the screen.
   *
   * **It performs no write, and that is the whole design.** A layout may be
   * persisted only as the consequence of a grid state change, so an action here
   * that emptied the arrangement and sent it would be a second write origin - and
   * the one origin able to destroy a document this component never managed to
   * read. Instead it resets what this component holds and hands the canvas back:
   * the stored document survives untouched until the viewer places their first
   * module, and it is that placement - an ordinary engine callback - that reports
   * the new arrangement through the one write path. So the destruction is the
   * viewer's own act, taken after being told what happened, rather than a
   * side-effect of pressing a button labelled recovery.
   *
   * `lastReportedLayout` is seeded with the fingerprint of the empty arrangement
   * for the same reason: leaving it stale would let the next incidental engine
   * notification - a viewport measurement, say - read as a change and write an
   * empty document before the viewer had placed anything.
   *
   * The catalog is opened because an empty canvas with the panel shut offers
   * nothing to do, which is the same reason a first visit opens it. `hasSaveError`
   * is cleared as well: a failure surface belonging to a previous arrangement has
   * nothing to say about this one, and its retry would offer a snapshot for an
   * arrangement that is no longer on screen.
   */
  public onStartBlankDashboard() {
    this.hasLayoutError = false;
    this.hasCapacityError = false;

    this.canonicalModules = [];
    this.modules.length = 0;

    this.lastReportedLayout = this.createLayoutFingerprint();

    this.dashboardLayoutService.discardFailedSave();

    this.isCatalogOpen = true;
    this.isInitialized = true;

    this.changeDetectorRef.markForCheck();
  }

  public onRetryViewer() {
    this.hasViewerError = false;
    this.hasRequestedViewer = false;

    this.changeDetectorRef.markForCheck();

    this.resolveViewer();
  }

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

  // Nothing is reported from here: splicing the array destroys that module's
  // `gridster-item` and the engine reports it through `itemRemovedCallback`.
  // Reporting here as well would give removal a second origin and would queue a
  // snapshot before the engine had settled the cells that shift into the gap.
  public onRemoveModule(aItem: DashboardLayoutItem) {
    const index = this.modules.indexOf(aItem);

    if (index === -1) {
      return;
    }

    this.endHydrationSettle();

    const definition = this.getModuleDefinition(aItem.moduleType);
    const name = this.getQualifiedModuleName(aItem.moduleType);

    // Resolved BEFORE the array is touched, while the removed module's chrome
    // is still in the query and its neighbours are still either side of it.
    const focusTarget = this.resolveFocusTargetAfterRemoval(definition);

    this.modules.splice(index, 1);

    this.hasCapacityError = false;

    this.announce($localize`${name}:moduleName: removed from the dashboard`);

    // The module is gone, so what the grid last reported about it describes
    // nothing. Left behind, it would make the same module - added again later at a
    // different size - look like a module that had been resized.
    this.announcedGeometry.delete(aItem.moduleType);

    if (this.modules.length === 0) {
      // Through the funnel rather than by assignment, so an arrangement that went
      // empty opens the panel by exactly the same route the trigger does - which
      // is what makes the panel record a focus origin, move focus into the panel
      // and answer which rows can be added, in this case as well. The origin the
      // funnel records here is the removed module's own menu, which is about to be
      // detached; the close path checks connectivity and falls back to the
      // floating trigger, so nothing is stranded.
      this.setCatalogOpen(true);
    }

    this.changeDetectorRef.markForCheck();

    this.restoreFocusAfterRemoval(focusTarget);
  }

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

  // A switch of account is handled in this order: the canvas is suspended
  // *before* the new viewer is recorded, so no removal it causes can report
  // itself; the layout service is then told which identity writes are
  // authorised for, which also discards anything pending; and only then is the
  // new arrangement read. Reversing any two of those steps reopens the window
  // the order exists to close.
  private adoptViewer(aUser: User) {
    const isDifferentViewer = aUser.id !== this.user?.id;
    const previousPermissions = this.user?.permissions;

    this.hasViewerError = false;
    this.isSignedOut = false;
    this.user = aUser;

    this.dashboardLayoutService.adoptIdentity(aUser.id);

    // The second disjunct recovers a suspended canvas, because a transition
    // begun elsewhere may be followed by the same viewer resolving again. A
    // failed read raises `isInitialized` precisely so the canvas is not treated
    // as suspended.
    if (isDifferentViewer || !this.isInitialized) {
      this.resetForViewerChange();
      this.hydrateLayout();

      this.changeDetectorRef.markForCheck();

      return;
    }

    // The paths that screen visibility only run when an arrangement is fetched
    // or a module is added, so without this a permission revoked mid-session
    // would leave the module it gated on screen. Re-screening rather than
    // refetching is deliberate: a refetch would discard positions moved since.
    if (this.hasPermissionsChanged(previousPermissions, aUser?.permissions)) {
      this.applyPermittedModules();
    }

    this.changeDetectorRef.markForCheck();
  }

  // A NEW configuration object, spread from the current one, and both halves
  // are deliberate: the engine derives the options it reads through a
  // `computed` over a required signal input, so a new identity is what re-runs
  // that derivation, and spreading forward preserves the runtime bookkeeping
  // the engine wrote onto it.
  private applyDropPreviewFootprint(aCols: number, aRows: number) {
    this.options = {
      ...this.options,
      defaultItemCols: aCols,
      defaultItemRows: aRows
    };

    this.changeDetectorRef.markForCheck();
  }

  /**
   * Takes the engine's edge auto-scroll away for the duration of a RESIZE, and
   * gives it back for a DRAG.
   *
   * One grid-wide pair of options, and the two gestures need opposite answers
   * from it. Dragging a module to a part of a canvas taller than its viewport
   * needs the scroll. Resizing against the bottom edge must not have it, because
   * there it compounds: each frame scrolls the region, which moves the edge away
   * from the pointer, which grows the item, which lengthens the grid, which
   * leaves the pointer at the edge again. Bounded only by the scroll extent it is
   * itself creating, a hold of about two seconds committed a module ninety-five
   * rows tall, and each update on that path cost far more than the hundred
   * milliseconds a gesture is meant to answer within.
   *
   * It takes effect for the gesture that raises it. `resizable.start` is invoked
   * from the pointer handler INSIDE the Angular zone - the engine only leaves the
   * zone afterwards, to bind the moves - so the configuration re-issued here
   * reaches the engine's `options` input in the change-detection pass that ends
   * that task, and the engine reads its derived options afresh on every move.
   *
   * `enableBoundaryControl` is not the alternative: it suppresses the auto-scroll
   * for BOTH gestures, which also removes legitimate downward dragging.
   *
   * A new configuration object spread from the current one, for the reason given
   * on {@link applyDropPreviewFootprint}. The early return keeps a gesture that
   * changes nothing from churning that identity.
   */
  private applyGestureScrolling(aIsEnabled: boolean) {
    if (this.options.disableScrollVertical === !aIsEnabled) {
      return;
    }

    this.options = {
      ...this.options,
      disableScrollHorizontal: !aIsEnabled,
      disableScrollVertical: !aIsEnabled
    };

    this.changeDetectorRef.markForCheck();
  }

  /**
   * The engine applies `scrollToNewItems` from the first size computation of
   * *every* item, the same moment `itemInitCallback` fires, so it cannot itself
   * tell a module the viewer just placed from one being restored.
   *
   * ⚠ Called BEFORE the cells in question are drawn, never from inside a
   * callback the engine raises while drawing one: the engine reads `$options`
   * on entry to its own size computation, and re-issuing a parent-bound input
   * during that pass is what an `ExpressionChangedAfterItHasBeenChecked` is
   * made of.
   */
  private applyNewItemReveal(aIsEnabled: boolean) {
    if (this.options.scrollToNewItems === aIsEnabled) {
      return;
    }

    this.options = { ...this.options, scrollToNewItems: aIsEnabled };

    this.changeDetectorRef.markForCheck();
  }

  // The engine is asked in exactly the way a pointer drag asks it, so a
  // keyboard step is subject to the identical rules: `checkItemChanges` runs
  // the engine's own collision check and on acceptance invokes
  // `itemChangeCallback` - {@link notifyLayoutChange}. So this adds no second
  // persistence path and no validation of its own. Acceptance is read from the
  // item afterwards because the engine's method returns nothing.
  private applyGeometryStep(
    aItem: DashboardLayoutItem,
    aGeometry: Pick<DashboardLayoutItem, 'cols' | 'rows' | 'x' | 'y'>
  ) {
    // Viewer intent, so any settle window still open belongs to an arrangement
    // that has already been drawn and must not swallow this.
    this.endHydrationSettle();

    const itemComponent = this.gridster?.getItemComponent(aItem);

    if (!itemComponent) {
      return;
    }

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

    // The engine reports an accepted change through `itemChangeCallback` from
    // inside the call below, and that report is announced on its own account so
    // that a pointer drag is not silent. Here it would be an announcement of the
    // same change one step before this method makes a better one - it knows only
    // the outcome, while this knows what was ASKED for, which is the whole of the
    // difference between "moved to column 1" and "cannot be moved left". The flag
    // stands the engine's report down for exactly the duration of the call.
    this.isApplyingGeometryStep = true;

    try {
      itemComponent.setSize();
      itemComponent.checkItemChanges(workingItem, previousGeometry);
    } finally {
      this.isApplyingGeometryStep = false;
    }

    const isAccepted =
      aItem.cols === aGeometry.cols &&
      aItem.rows === aGeometry.rows &&
      aItem.x === aGeometry.x &&
      aItem.y === aGeometry.y;

    this.announceGeometry(aItem, previousGeometry, aGeometry, isAccepted);

    this.changeDetectorRef.markForCheck();
  }

  /**
   * Writes one sentence to the canvas's live region, and is the only thing that
   * writes to it.
   *
   * A live region is announced when its contents CHANGE, so writing the same
   * sentence twice says nothing the second time - and the sentence a viewer is most
   * likely to hear twice is the one that reports a refusal, because holding an arrow
   * key against the edge of the grid produces it on every press. Measured before
   * this existed: 11 announcements across 19 presses, so 9 presses were silent, and
   * each of those was a press the viewer had no way of knowing had been received.
   *
   * A repeat is therefore emptied first and refilled a task later, which turns one
   * message into two changes. The refill has to be a separate task: both halves
   * inside one task are coalesced into whatever the DOM holds when it next paints,
   * and the accessibility tree only ever sees that final value - so the clear would
   * be invisible and nothing would have changed after all.
   *
   * A message that DIFFERS from the standing one is written straight through, with
   * no clear and no deferral. That keeps the common case immediate, keeps the region
   * from flickering through empty on every announcement, and keeps this method
   * synchronous from the caller's point of view wherever it can be.
   *
   * A pending refill is cancelled by the next call, so the last message wins and two
   * of them can never arrive out of order.
   */
  private announce(aMessage: string) {
    window.clearTimeout(this.announcementHandle);
    this.announcementHandle = undefined;

    if (this.canvasAnnouncement !== aMessage) {
      this.canvasAnnouncement = aMessage;

      this.changeDetectorRef.markForCheck();

      return;
    }

    this.canvasAnnouncement = '';

    this.changeDetectorRef.markForCheck();

    this.announcementHandle = window.setTimeout(() => {
      this.announcementHandle = undefined;

      this.canvasAnnouncement = aMessage;

      this.changeDetectorRef.markForCheck();
    });
  }

  /**
   * Reports what happened to one module's geometry, in the terms the viewer asked
   * in rather than the terms the engine answered in.
   *
   * Both the requested geometry and the one it started from are taken, because
   * neither the engine's report nor the resulting item can say what was WANTED -
   * and a refusal is only useful if it names the direction that was refused. `cannot
   * be moved any further` was the same sentence for all four arrow keys and all four
   * resize gestures, which is both uninformative and, said twice in a row, inaudible.
   */
  private announceGeometry(
    aItem: DashboardLayoutItem,
    aPreviousGeometry: DashboardModuleGeometry,
    aRequestedGeometry: DashboardModuleGeometry,
    aIsAccepted: boolean
  ) {
    const name = this.getQualifiedModuleName(aItem.moduleType);

    const deltaCols = aRequestedGeometry.cols - aPreviousGeometry.cols;
    const deltaRows = aRequestedGeometry.rows - aPreviousGeometry.rows;
    const isResize = deltaCols !== 0 || deltaRows !== 0;

    if (aIsAccepted) {
      this.announce(
        isResize
          ? $localize`${name}:moduleName: resized to ${aItem.cols}:columns: columns by ${aItem.rows}:rows: rows`
          : $localize`${name}:moduleName: moved to column ${aItem.x + 1}:column:, row ${aItem.y + 1}:row:`
      );

      return;
    }

    this.announce(
      isResize
        ? this.describeRefusedResize(name, deltaCols, deltaRows)
        : this.describeRefusedMove(
            name,
            aRequestedGeometry.x - aPreviousGeometry.x,
            aRequestedGeometry.y - aPreviousGeometry.y
          )
    );
  }

  /**
   * The four directions an arrow key can be refused in, each saying so.
   *
   * `there is no room` rather than naming an edge, because a refusal has two causes
   * that a viewer cannot tell apart and does not need to: the module is against the
   * boundary of the grid, or another module is already in the cells it asked for.
   * Both mean the same thing to the person pressing the key, and claiming an edge
   * that was really a neighbour would be wrong half the time - the arrangement this
   * was measured against refuses a rightward step on a module sitting in column 1.
   */
  private describeRefusedMove(
    aName: string,
    aDeltaX: number,
    aDeltaY: number
  ): string {
    if (aDeltaX < 0) {
      return $localize`${aName}:moduleName: cannot be moved left: there is no room`;
    }

    if (aDeltaX > 0) {
      return $localize`${aName}:moduleName: cannot be moved right: there is no room`;
    }

    if (aDeltaY < 0) {
      return $localize`${aName}:moduleName: cannot be moved up: there is no room`;
    }

    return $localize`${aName}:moduleName: cannot be moved down: there is no room`;
  }

  /**
   * The four ways a resize can be refused.
   *
   * A shrink and a growth are refused for different reasons and are told apart here.
   * Shrinking can only ever be stopped by the module's own declared minimum -
   * nothing collides on the way in - so that refusal names the minimum, which is the
   * one fact the viewer needs and cannot see. Growing can be stopped by the width of
   * the grid or by a neighbour, so it says what a refused move says.
   */
  private describeRefusedResize(
    aName: string,
    aDeltaCols: number,
    aDeltaRows: number
  ): string {
    if (aDeltaCols < 0) {
      return $localize`${aName}:moduleName: is already as narrow as it goes`;
    }

    if (aDeltaCols > 0) {
      return $localize`${aName}:moduleName: cannot be made wider: there is no room`;
    }

    if (aDeltaRows < 0) {
      return $localize`${aName}:moduleName: is already as short as it goes`;
    }

    return $localize`${aName}:moduleName: cannot be made taller: there is no room`;
  }

  // The qualified form the module chrome and the catalog rows show, because an
  // announcement that names a module has to name the one the viewer can see: two
  // registry entries are titled `Settings` and two are titled `Markets`, so a
  // message saying only `Settings` names either of them. Falls back to the stored
  // discriminator for a module type this build does not know, which is the only
  // name such a module has.
  private getQualifiedModuleName(aModuleType: DashboardModuleType): string {
    return (
      getQualifiedDashboardModuleName(this.getModuleDefinition(aModuleType)) ??
      aModuleType
    );
  }

  // The same thing for a definition already in hand, which the placement path has
  // and which is not necessarily in the registry's own map - a definition can reach
  // that path from a catalog emission.
  private qualifyDefinitionName(
    aDefinition: DashboardModuleDefinition
  ): string {
    return (
      getQualifiedDashboardModuleName(aDefinition) ?? aDefinition.moduleType
    );
  }

  private applyLayout(aLayout: UserDashboardLayout | null) {
    if (aLayout && !this.isReadableLayout(aLayout)) {
      this.markLayoutUnreadable();

      return;
    }

    this.canonicalModules = this.createCanonicalModules(aLayout);

    const items = this.createLayoutItems(this.canonicalModules);

    this.applyNewItemReveal(false);

    // Opened BEFORE the items reach the template, because the engine settles them
    // during the very change-detection pass that draws them.
    this.beginHydrationSettle();

    this.modules.length = 0;
    this.modules.push(...items);

    this.lastReportedLayout = this.createLayoutFingerprint();

    if (this.modules.length === 0) {
      // Through the funnel rather than by assignment, so an arrangement that went
      // empty opens the panel by exactly the same route the trigger does - which
      // is what makes the panel record a focus origin and answer which rows can
      // be added, in this case as well.
      this.setCatalogOpen(true);
    }

    this.isInitialized = true;

    this.changeDetectorRef.markForCheck();
  }

  /**
   * Suppresses layout WRITES - and only writes - while the grid engine settles an
   * arrangement this component has just applied.
   *
   * A stored arrangement is normalized on the way in, but normalization cannot
   * resolve collisions: an entry whose coordinate was out of range is clamped, and
   * a clamped entry can land on top of a neighbour. The engine notices that as it
   * admits each cell - `addItem` runs its collision check and auto-positions the
   * loser - and reports the correction through the same change callback a drag
   * reports through. So the arrangement genuinely differs from the one recorded a
   * moment earlier, and the write path, working exactly as designed, wrote it back.
   *
   * The consequence was severe and completely silent: merely OPENING a dashboard
   * that needed normalizing issued a PATCH as the last request of the page load,
   * with no interaction of any kind - and that PATCH carried the arrangement this
   * client had made of the document rather than the document itself. Every entry it
   * had dropped as a duplicate was dropped from storage too, permanently.
   *
   * Retaining unrecognised entries (see {@link createCanonicalModules}) fixes what
   * such a write would DESTROY; this fixes the write happening at all. Both are
   * needed: hydration must not write, and a write must not lose entries.
   *
   * The window closes on the next macrotask, which is after the change-detection
   * pass that mounts the cells and after the engine's own debounced layout pass. It
   * also closes eagerly at the first thing the viewer does - see
   * {@link endHydrationSettle} - so no genuine intent can ever be inside it, however
   * the scheduling turns out.
   *
   * A change reported while the window is open is still RECORDED: the fingerprint
   * and the canonical arrangement are both brought up to date, so the correction is
   * what the next genuine edit persists. That matches how normalization already
   * behaved - a correction reaches the server when the viewer next changes
   * something themselves, and not before.
   */
  private beginHydrationSettle() {
    window.clearTimeout(this.hydrationSettleHandle);

    this.isHydrationSettling = true;

    this.hydrationSettleHandle = window.setTimeout(() => {
      this.hydrationSettleHandle = undefined;
      this.isHydrationSettling = false;
    });
  }

  // Called at the start of every path that expresses viewer intent, so an
  // interaction can never be swallowed by a settle window that has outlived the
  // arrangement it was opened for.
  private endHydrationSettle() {
    if (!this.isHydrationSettling) {
      return;
    }

    window.clearTimeout(this.hydrationSettleHandle);

    this.hydrationSettleHandle = undefined;
    this.isHydrationSettling = false;
  }

  /**
   * Records that the stored arrangement cannot be interpreted at all, as distinct
   * from a read that merely failed.
   *
   * The two states share a card but not their affordances, and that is the whole
   * point: a failed read is worth asking again, while a document this build does
   * not understand will be the same document on the next request - so offering only
   * a retry left the viewer pressing a control that provably could not succeed. The
   * server states which it is, with a 409 for the unreadable case, and the client
   * keeps that distinction rather than flattening both into "something went wrong".
   */
  private markLayoutUnreadable() {
    this.hasLayoutError = true;
    this.isLayoutUnreadable = true;
    this.isInitialized = true;

    this.changeDetectorRef.markForCheck();
  }

  /**
   * A revocation is answered from the live array, which holds every surviving
   * module's current geometry; a grant is answered from the canonical
   * arrangement, the only place a module with no cell still has a saved
   * position. An admitted module is offered to the engine at its own footprint
   * first, because its saved cell may be occupied by something moved since.
   *
   * Nothing is reported to the layout service: a change in what a viewer is
   * allowed to see is not a change the viewer made, and persisting it would
   * erase a module the moment a subscription lapsed.
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

    this.applyNewItemReveal(false);

    this.modules.length = 0;
    this.modules.push(...retained, ...admitted);

    if (this.modules.length === 0) {
      // Through the funnel rather than by assignment, so an arrangement that went
      // empty opens the panel by exactly the same route the trigger does - which
      // is what makes the panel record a focus origin and answer which rows can
      // be added, in this case as well.
      this.setCatalogOpen(true);
    }

    this.canonicalModules = this.mergeCanonicalModules();

    this.lastReportedLayout = this.createLayoutFingerprint();
  }

  /**
   * Pulls back a module the engine has just committed absurdly far down the
   * canvas.
   *
   * Holding a dragged module against the bottom of the scrolling region starts
   * the engine's auto-scroll, which repeats for as long as the pointer is held
   * and is bounded only by the grid's scroll extent, so a hold of a couple of
   * seconds carries a module past row ninety. The engine commits that as an
   * ordinary drag result, and a placement no interaction could have
   * deliberately expressed does not get to become the saved arrangement.
   * `enableBoundaryControl` is not the answer: it suppresses the auto-scroll
   * path entirely, which also removes legitimate downward dragging on a canvas
   * taller than its viewport.
   *
   * The bound is one viewport of rows below the deepest point every *other*
   * module reaches, and it never pulls a module *above* where it already sat,
   * because a sparse arrangement is legitimate. `canonicalModules` is the right
   * source for that floor because it still holds the last reported arrangement
   * at this point in the pass.
   *
   * The correction goes through {@link applyGeometryStep}, so the engine judges
   * it and reports it through {@link notifyLayoutChange} - which re-enters the
   * caller. Hence {@link isClampingPlacement}: the inner pass records and
   * schedules the corrected arrangement, and the return value tells the outer
   * pass to stand down.
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

      const itemModuleType: string = item.moduleType;
      const reportedY = this.canonicalModules.find(
        ({ moduleType }) => moduleType === itemModuleType
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
   * The token was already adopted by the route guard, which owns that half
   * because navigating from inside `canActivate` risks cancelling the
   * navigation in progress.
   *
   * `replaceUrl` is what makes this a removal rather than a second address: the
   * parameter carries a session token, so leaving that address as its own
   * history entry would keep the credential reachable by pressing Back, by
   * anything that reads session history and by restore-tabs behaviour. Merging
   * preserves every other parameter. The guard is on presence, not on the
   * value: a spent token and an empty one are the same case.
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
   * Takes up the failure the API's federated callbacks report, and removes it from
   * the address.
   *
   * Compared against the one value the contract defines rather than tested for
   * presence, and never rendered: this arrives in a URL anybody can write, so
   * displaying what it said would let a link put an arbitrary sentence on the
   * sign-in card. Anything else is treated as absent, which makes a forged or
   * mistyped parameter inert rather than merely harmless.
   *
   * Cleared the same way the token is - merged, so sibling parameters survive, and
   * with `replaceUrl` so the failure does not become its own history entry that
   * Back or a restored tab would replay as a fresh one. The flag is latched first,
   * because the removal is what makes reading the URL again impossible.
   */
  private adoptSignInError() {
    const { signInError }: GfAppQueryParams = this.route.snapshot.queryParams;

    if (signInError !== 'provider') {
      return;
    }

    this.hasSignInError = true;

    void this.router.navigate([], {
      queryParams: { signInError: null },
      queryParamsHandling: 'merge',
      relativeTo: this.route,
      replaceUrl: true
    });
  }

  // Exactly the five persisted fields, in a fixed key order, per module and in
  // placement order - the same projection the wire carries, so two arrangements
  // compare equal precisely when they would be stored identically. The explicit
  // object literal is what fixes that order in code rather than in insertion
  // history.
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

  /**
   * The minimum footprint is copied onto every item, on all three paths that
   * mint one, and that is required rather than tidy: `itemValidateCallback`
   * measures a placement against these two members, they are optional on
   * `GridsterItemConfig`, and an absent minimum would be compared against with
   * no value to compare to.
   *
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
   * A repeated discriminator is dropped in silence, because the template's cell
   * key could not tell a second copy apart from the first and two entries for one
   * module type cannot both be drawn.
   *
   * A discriminator the registry does not know is KEPT. That is the opposite of
   * dropping it, and the difference is a data-integrity one: this build not
   * recognising a module type says nothing about whether the type exists. A
   * renamed module, a client rolled back, a build that has not shipped a module
   * yet - each produces a stored entry this canvas cannot draw and another client
   * can, so discarding it here would make merely OPENING the dashboard delete a
   * module from the saved document, irreversibly and without a word. The server
   * already takes this position deliberately: its per-item validation defers on an
   * unknown discriminator precisely so a retired module survives the round trip.
   *
   * A kept entry is still brought inside the wire contract, against the GLOBAL
   * floor rather than a declared minimum, because there is no definition to read
   * one from. Without that a stored `cols: 99` would be retained verbatim and the
   * next ordinary edit would be rejected by the server's own bounds - turning a
   * harmless unrecognised entry into a dashboard that cannot be saved at all.
   *
   * Permission is deliberately not considered, which is what separates this from
   * {@link createLayoutItems}: an entry the viewer may not currently see has to
   * stay or the next edit would delete it.
   *
   * Every surviving entry is normalized, because the stored geometry is
   * whatever some earlier client wrote and the engine is never consulted for an
   * item that arrives already placed. Nothing is written as a result, so a
   * correction reaches the server only when the viewer next changes something
   * themselves.
   *
   * A discard is reported, once per hydration, because it is not free. What can
   * still be discarded here is a repeated discriminator and an entry whose stored
   * geometry describes no cell at all, and the next grid change the viewer makes
   * persists this arrangement without it - so the loss becomes permanent on the
   * very next drag. Nothing can be decided about that from here, and silence was
   * the only part that was avoidable: the report is what lets somebody reading a
   * console see that an arrangement arrived larger than it was drawn, rather than
   * inferring it from modules that stopped appearing.
   *
   * What it emits is a fixed identifier and a count, deliberately mirroring the
   * server's own `GF-USER-DASHBOARD-LAYOUT-ITEMS-DROPPED` so both halves of the
   * round trip are searchable the same way. Not the discriminators: they come out
   * of a stored document and can carry anything the owner's client wrote, and the
   * console is readable by every script on the page.
   */
  private createCanonicalModules(
    aLayout: UserDashboardLayout | null
  ): DashboardModuleLayoutItem[] {
    const definitions = this.getDefinitionsByModuleType();
    const modules: DashboardModuleLayoutItem[] = [];

    const placedModuleTypes = new Set<string>();

    const storedModules = aLayout?.modules ?? [];

    for (const { cols, moduleType, rows, x, y } of storedModules) {
      if (placedModuleTypes.has(moduleType)) {
        continue;
      }

      const definition = definitions.get(moduleType);

      const geometry = this.normalizeGeometry(
        definition ?? GLOBAL_MODULE_MINIMUM,
        {
          cols,
          rows,
          x,
          y
        }
      );

      if (!geometry) {
        continue;
      }

      placedModuleTypes.add(moduleType);

      modules.push({
        ...geometry,
        moduleType: definition?.moduleType ?? moduleType
      });
    }

    // Counted by difference rather than incremented at each `continue`, so a
    // discard reason added later cannot be left out of the tally.
    const droppedCount = storedModules.length - modules.length;

    if (droppedCount > 0) {
      console.warn(`${LAYOUT_ITEMS_DROPPED_EVENT} (count ${droppedCount})`);
    }

    return modules;
  }

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

  // A saved arrangement and a drag payload both carry a plain string, because
  // the persisted contract has to tolerate a value an older client wrote, while
  // the registry's own lookup takes the typed discriminator. This map keeps
  // every such path free of a type assertion.
  private getDefinitionsByModuleType(): Map<string, DashboardModuleDefinition> {
    return new Map<string, DashboardModuleDefinition>(
      this.moduleRegistryService.getAll().map((definition) => {
        return [definition.moduleType, definition];
      })
    );
  }

  /**
   * The native drag payload contract, frozen by the catalog row that starts the
   * drag: the raw kebab-case discriminator under the `text/plain` key, with no
   * JSON, no wrapper object, no prefix and no custom MIME type. `dataTransfer`
   * is optional on the event and a drag carrying nothing must not throw.
   *
   * Only the *cell* is taken from the item the grid hands over, never its size:
   * that item is the library's own drop candidate, minted and screened at the
   * configured default footprint because the library cannot know which module
   * is being dragged. {@link placeModule} screens the real item at its own
   * size.
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

  // Only the module the viewer just placed is brought into view, matched by
  // identity; every other first paint - and hydration produces one per saved
  // module - is ignored.
  private handleItemInit(aItem: GridsterItemConfig) {
    // Recorded for every module's first paint, not only for a revealed one: an
    // entry in the map is what distinguishes a module being MOVED from a module
    // arriving, and the engine reports an auto-positioned arrival as a change
    // before it reports the paint. Without the entry the arrival would be
    // announced twice, once as a placement and once as a move.
    this.recordAnnouncedGeometry(aItem);

    if (!this.pendingRevealItem || aItem !== this.pendingRevealItem) {
      return;
    }

    const item = this.pendingRevealItem;

    this.pendingRevealItem = null;

    this.revealPlacedModule(item);
  }

  /**
   * The engine reporting that one module's geometry changed.
   *
   * This is the only path a POINTER drag or resize has to an announcement: the
   * keyboard path speaks for itself, and before this a viewer using a mouse got
   * silence - worse, the region kept whatever it had last been told, so a reader
   * checking it was told about something that was no longer true.
   *
   * The engine offers one hook for both kinds of change and hands over no
   * before-state, so the kind is derived from what this module was last seen
   * holding. A module with nothing recorded has just arrived, and an arrival is
   * announced by the code that placed it; a module whose recorded geometry is
   * unchanged has been reported without moving, which the engine does while it
   * settles an arrangement.
   *
   * Nothing here writes, persists or positions anything.
   */
  private handleItemGeometryChange(aItem: GridsterItemConfig) {
    const item = this.modules.find((module) => {
      return module === aItem;
    });

    if (!item) {
      return;
    }

    const previous = this.announcedGeometry.get(item.moduleType);

    this.recordAnnouncedGeometry(item);

    if (
      this.hasAnnouncedGeometryChange ||
      this.isApplyingGeometryStep ||
      this.isHydrationSettling ||
      previous === undefined ||
      previous === this.createGeometryFingerprint(item)
    ) {
      return;
    }

    this.hasAnnouncedGeometryChange = true;

    // Deliberately not awaited: this exists only to reopen the gate on the next
    // microtask, once the engine has finished reporting the rest of the change it
    // is part way through, and nothing downstream waits for it.
    void Promise.resolve().then(() => {
      this.hasAnnouncedGeometryChange = false;
    });

    const [cols, rows, x, y] = previous.split(':').map(Number);

    this.announceGeometry(item, { cols, rows, x, y }, item, true);
  }

  /**
   * A pointer DRAG has begun, which is the one gesture that legitimately wants
   * the engine's edge auto-scroll - a module cannot be carried to a part of a
   * canvas taller than its viewport without it.
   *
   * Restoring here rather than only at the end of a resize is what makes the pair
   * self-correcting: a resize that ends in a way the engine does not report -
   * a window blur mid-gesture, say - would otherwise leave the bound raised for
   * every drag that followed. See {@link applyGestureScrolling}.
   */
  private handleDragGestureStart() {
    this.applyGestureScrolling(true);
  }

  /**
   * Lets the resized module's content find its new size again, in one pass.
   *
   * Deliberately clears the three properties rather than restoring whatever was
   * there before: all three are stylesheet declarations on that region, so
   * removing the inline copies hands sizing back to the stylesheet instead of
   * pinning a snapshot of it into the element for good.
   */
  private handleResizeGestureEnd() {
    // Before the early return, because the two holds are independent: a gesture
    // on a module with no measurable content box pins nothing but still took the
    // auto-scroll away, and leaving it away would remove it from every later
    // drag. See {@link applyGestureScrolling}.
    this.applyGestureScrolling(true);

    const content = this.resizingContentElement;

    if (!content) {
      return;
    }

    this.resizingContentElement = null;

    content.style.removeProperty('flex-grow');
    content.style.removeProperty('flex-shrink');
    content.style.removeProperty('height');
    content.style.removeProperty('width');
  }

  /**
   * Holds the resized module's content box still for the duration of the
   * gesture, so the module inside re-lays-out once on release instead of on
   * every pointer move.
   *
   * The engine writes the CELL's width and height on each move, and the content
   * region fills that cell - so every move otherwise reflows the whole module
   * subtree, wakes the resize observers a charting library installs on its own
   * container, and paints the module at a size it was never meant to be seen at.
   * Pinning the region's own box breaks that chain at its source: the cell still
   * follows the pointer exactly as before, while everything inside keeps the
   * geometry it already had.
   *
   * All four properties are needed and none is redundant. The region is a flex
   * item that grows and shrinks with its line, so `width` and `height` alone
   * would be overruled by the flex algorithm in one axis and by the default
   * cross-axis stretch in the other; taking its grow and shrink factors to zero
   * is what removes it from that negotiation, and the `auto` basis the
   * stylesheet already gives it then resolves to the width set here. The
   * measurements are border-box values, read from an element the stylesheet
   * gives `box-sizing: border-box`, so they describe the same box the
   * properties then set.
   *
   * The two flex factors are written as longhands rather than as a `flex: none`
   * shorthand, for one reason: removing a shorthand is specified to remove every
   * longhand it set, and implementations disagree about honouring that, so a
   * shorthand risks a hold that cannot be fully released. Longhands are removed
   * by the same names they were set with, everywhere.
   *
   * @param aItemComponent the cell being resized, as reported by the engine's
   * own `resizable.start` hook.
   */
  private handleResizeGestureStart(aItemComponent: GridsterItem) {
    // A second gesture cannot begin before the first has ended, but releasing
    // first costs nothing and is what guarantees no element is ever left pinned
    // by a hold whose counterpart went to a different one.
    this.handleResizeGestureEnd();

    // Taken away for this gesture, and before anything is measured: the release
    // above restored it, and the engine's first pointer move must already see it
    // gone. See {@link applyGestureScrolling} for why a resize must not have it.
    this.applyGestureScrolling(false);

    const content = aItemComponent?.el?.querySelector<HTMLElement>(
      `.${MODULE_CONTENT_CLASS}`
    );

    // Both measurements are taken BEFORE anything is written, and that ordering
    // is load-bearing rather than tidy: `flex: none` restores an `auto` basis,
    // which resizes the region to its own content in the same layout pass, so a
    // measurement taken afterwards would describe the box the hold created
    // instead of the box it was meant to preserve.
    const height = content?.offsetHeight;
    const width = content?.offsetWidth;

    // Nothing to hold still, and nothing is lost by declining: a region with no
    // measurable box is one that is not laid out, so there is no reflow to
    // avoid.
    if (!height || !width) {
      return;
    }

    this.resizingContentElement = content;

    content.style.setProperty('flex-grow', '0');
    content.style.setProperty('flex-shrink', '0');
    content.style.setProperty('height', `${height}px`);
    content.style.setProperty('width', `${width}px`);
  }

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

  // Compared as sets: the store hands back a fresh array on every emission and
  // the order within it is not part of the contract.
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

  // Every fetch after the first bypasses the cache. The layout store caches on
  // its slice being defined rather than truthy, so a cached absence belonging
  // to the previous viewer would otherwise be served to whoever just signed in
  // - as "no saved arrangement", which is the state that opens the catalog.
  private hydrateLayout() {
    const force = this.hasHydratedLayout;
    const generation = ++this.hydrationGeneration;

    this.hasHydratedLayout = true;
    this.hasLayoutError = false;

    this.dashboardLayoutService
      .get(force)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        error: (error: unknown) => {
          if (generation !== this.hydrationGeneration) {
            return;
          }

          // A conflict is the server saying the stored document cannot be
          // interpreted at all, which no retry can change. Every other failure is a
          // request that did not land, which a retry can.
          if (this.isConflictError(error)) {
            this.markLayoutUnreadable();

            return;
          }

          this.hasLayoutError = true;
          this.isInitialized = true;

          this.changeDetectorRef.markForCheck();
        },
        next: (layout) => {
          if (generation !== this.hydrationGeneration) {
            return;
          }

          this.applyLayout(layout);
        }
      });
  }

  // Absence of a declared permission means unconditionally visible, and nothing
  // is special-cased by name: the registry metadata is the entire rule, and the
  // catalog applies the same check independently. Neither affects server-side
  // authorization.
  private isModulePermitted({
    permission
  }: DashboardModuleDefinition): boolean {
    return !permission || hasPermission(this.user?.permissions, permission);
  }

  // A `modules` member that is not an array cannot be iterated, and a version
  // this build does not know describes a shape it cannot claim to understand -
  // treating that as readable would let this client rewrite a newer client's
  // document in an older shape. An absent version is readable: that is how
  // documents written before the discriminator existed are spelled.
  private isReadableLayout({ modules, version }: UserDashboardLayout): boolean {
    return (
      Array.isArray(modules) &&
      (version === undefined || version === SUPPORTED_LAYOUT_VERSION)
    );
  }

  /**
   * `accessId` alone, and that simplicity is the fix rather than a simplification.
   *
   * This used to read `!!accessId && !editDialog`, because the account access
   * module reopened its own edit dialog with `?accessId=<id>&editDialog=true` on
   * this very route - so the root host had to ignore an `accessId` that was
   * accompanied by that flag. The consequence was that which of the root's three
   * states got drawn depended on a *generic* dialog flag, one every module sets
   * and clears. Two ways that went wrong, both reachable from an ordinary address:
   *
   * - a share link carrying another module's flag -
   *   `?accessId=<valid>&editDialog=true&dialogModule=accounts` - was not treated
   *   as a share at all, so an anonymous visitor was shown the sign-in prompt
   *   instead of the portfolio somebody had shared with them;
   * - a signed-in viewer editing one of their own grants held both parameters, and
   *   the moment an unrelated module merged `editDialog: null` into the address the
   *   share activated, tearing down their canvas and replacing it with a
   *   stranger's portfolio.
   *
   * The access module now addresses its dialog with `accessDialogId`, leaving
   * `accessId` to mean exactly one thing. So the root discriminator reads only the
   * parameter that owns the decision, and no dialog flag can move it.
   */
  private isSharedPortfolioRequest({ accessId }: GfAppQueryParams): boolean {
    return !!accessId;
  }

  /**
   * Sends the discard and rebuilds the canvas as a genuinely empty one.
   *
   * The order matters. Nothing is reset before the server confirms, because a
   * failed discard must leave the viewer exactly where they were rather than
   * showing them an empty dashboard their account does not have. Once it is
   * confirmed the arrangement is cleared, the error state is dropped, and the
   * catalog opens - which is precisely the first-visit state, and correct: after a
   * discard there really is nothing saved.
   *
   * The array is emptied while the canvas is still in its error state and therefore
   * still refuses writes, so the grid destroying its cells cannot report a removal
   * as an intent to save an empty arrangement.
   */
  private discardLayout() {
    this.isDiscardingLayout = true;

    this.changeDetectorRef.markForCheck();

    this.dashboardLayoutService
      .discard()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        error: () => {
          this.isDiscardingLayout = false;

          this.notificationService.alert({
            message: $localize`Please try again later.`,
            title: $localize`Oops! Something went wrong.`
          });

          this.changeDetectorRef.markForCheck();
        },
        next: () => {
          this.modules.length = 0;
          this.canonicalModules = [];
          this.lastReportedLayout = null;

          this.hasConflict = false;
          this.hasLayoutError = false;
          this.isDiscardingLayout = false;
          this.isLayoutUnreadable = false;

          // Focus is moved into the panel for the same reason it is after the last
          // module is removed: the control that was pressed lives in the error card
          // this very assignment takes off the screen, so leaving focus where it was
          // leaves it on a detached element and hands the document body back to the
          // viewer. The panel this opens is the only thing there is to do next, and
          // it is opened through the one funnel so this route behaves like every
          // other open.
          //
          // The origin is dropped straight afterwards so that closing the panel
          // again falls back to the floating trigger rather than to a button that no
          // longer exists.
          this.setCatalogOpen(true);

          this.catalogFocusOrigin = null;
          this.isInitialized = true;

          this.changeDetectorRef.markForCheck();
        }
      });
  }

  // The one status that distinguishes a stored document this build cannot
  // interpret from a request that failed to land. Narrowed on the response type as
  // well as the status so a plain object carrying a `status` member cannot be
  // mistaken for one.
  private isConflictError(aError: unknown): boolean {
    return (
      aError instanceof HttpErrorResponse && aError.status === CONFLICT_STATUS
    );
  }

  // Only an unauthorized response means the session has ended. Treating every
  // failure as a sign-out would front the sign-in prompt because one request
  // timed out.
  private isUnauthorizedError(aError: unknown): boolean {
    return (
      aError instanceof HttpErrorResponse &&
      aError.status === UNAUTHORIZED_STATUS
    );
  }

  /**
   * The projection that gets persisted, and it has to answer one question
   * exactly right: a canonical entry with no cell is either a module the viewer
   * *removed*, which must be forgotten, or one this client cannot currently draw,
   * which must be kept. Forget the second and a lapsed subscription - or a module
   * type this build does not know - silently deletes modules; keep the first and a
   * removed module comes back on the next load.
   *
   * Two kinds of entry are kept, for the same reason expressed twice: an entry the
   * viewer is not PERMITTED to see, and an entry whose module type this build does
   * not RECOGNISE. Neither absence is evidence that the viewer wanted the module
   * gone; both are properties of this client at this moment, and a subscription
   * renewed or a build deployed makes them drawable again. A removal, by contrast,
   * is something the viewer did, and it is distinguishable precisely because it
   * takes the entry out of the canonical arrangement rather than out of the grid.
   *
   * Visible modules take their geometry from grid state, so the grid remains
   * the single authority for everything it draws.
   */
  private mergeCanonicalModules(): DashboardModuleLayoutItem[] {
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

    const definitions = this.getDefinitionsByModuleType();

    const retainedHidden = this.canonicalModules.filter(({ moduleType }) => {
      if (visibleModuleTypes.has(moduleType)) {
        return false;
      }

      const definition = definitions.get(moduleType);

      return !definition || !this.isModulePermitted(definition);
    });

    return [
      ...visible,
      ...this.relocateReservedModules(visible, retainedHidden)
    ];
  }

  // Half-open on both axes, which is what makes two footprints that merely touch
  // - one ending on the row the next begins - count as neighbours rather than as
  // an overlap.
  private hasFootprintOverlap(
    aFootprint: { cols: number; rows: number; x: number; y: number },
    aOther: { cols: number; rows: number; x: number; y: number }
  ): boolean {
    return (
      aFootprint.x < aOther.x + aOther.cols &&
      aOther.x < aFootprint.x + aFootprint.cols &&
      aFootprint.y < aOther.y + aOther.rows &&
      aOther.y < aFootprint.y + aFootprint.rows
    );
  }

  /**
   * Moves a reserved module out from under whatever now occupies its cells, and
   * leaves every other one exactly where it was saved.
   *
   * This is what makes the stored arrangement free of overlaps at all times, not
   * merely free of the ones the grid engine can see. Nothing else was going to
   * notice: a module the viewer is not entitled to see, or one whose type this
   * build does not recognise, holds a saved cell and draws no card, so to the
   * engine those cells are empty and it will place - or let a viewer drag -
   * something straight onto them. The overlap then sits in the stored document,
   * durable and silent, and surfaces only when the entitlement returns and two
   * modules claim the same cells, at which point which one moves is whichever the
   * engine happened to relocate.
   *
   * Every reported change funnels through {@link mergeCanonicalModules}, so this
   * covers the drag, the drop, the click-to-add and a document already stored with
   * an overlap in it - all by the same rule: the module the viewer can see keeps
   * the cells they put it on, and the one they cannot see is the one that moves.
   *
   * Deterministic by construction - reserved entries are considered in the order
   * the arrangement holds them, and each is offered the first free footprint in
   * row-major order - so the same arrangement always relocates to the same place,
   * on every client and on every pass.
   *
   * It writes nothing. The corrected geometry becomes part of the canonical
   * arrangement, which is what the next reported grid change carries to the server
   * through the one write path, exactly as a normalization correction already does.
   */
  private relocateReservedModules(
    aPlaced: DashboardModuleLayoutItem[],
    aReserved: DashboardModuleLayoutItem[]
  ): DashboardModuleLayoutItem[] {
    if (aReserved.length === 0) {
      return aReserved;
    }

    const occupied = [...aPlaced];
    const settled: DashboardModuleLayoutItem[] = [];

    for (const reserved of aReserved) {
      const isFree = !occupied.some((other) =>
        this.hasFootprintOverlap(reserved, other)
      );

      const module = isFree
        ? reserved
        : { ...reserved, ...this.findFreeFootprint(reserved, occupied) };

      occupied.push(module);
      settled.push(module);
    }

    return settled;
  }

  /**
   * The first cell, scanning left to right and then down, at which the given
   * footprint fits between the ones already taken.
   *
   * The scan reaches one row past everything taken, and that last row is why it
   * always answers: an empty row admits any footprint the grid's twelve columns
   * can hold. Bounding it by the arrangement's own extent rather than by the
   * grid's hundred-row ceiling is what keeps the cost proportional to the
   * dashboard in front of the viewer.
   */
  private findFreeFootprint(
    aFootprint: DashboardModuleLayoutItem,
    aOccupied: DashboardModuleLayoutItem[]
  ): { x: number; y: number } {
    const extent = aOccupied.reduce(
      (rowsUsed, { rows, y }) => Math.max(rowsUsed, y + rows),
      0
    );

    for (let y = 0; y <= extent; y += 1) {
      for (let x = 0; x + aFootprint.cols <= GRID_COLUMNS; x += 1) {
        const candidate = { ...aFootprint, x, y };

        const isFree = !aOccupied.some((other) =>
          this.hasFootprintOverlap(candidate, other)
        );

        if (isFree) {
          return { x, y };
        }
      }
    }

    // Unreachable for a normalized footprint, which is never wider than the grid.
    // Answering with the row below everything keeps the routine total rather than
    // letting a value the type system cannot rule out fall through as `undefined`.
    return { x: 0, y: extent };
  }

  /**
   * The layout service is told first: that withdraws write authorisation and
   * discards whatever was pending, which is the only correct outcome because
   * the token is already gone by the time the store reports the absence.
   *
   * The arrangement is then invalidated with writes already refused, and that
   * order is what makes it safe: emptying the array destroys every
   * `gridster-item`, each destruction invokes the item-removed callback, and a
   * callback still able to report would schedule a write of an empty
   * arrangement.
   *
   * Suspending explicitly rather than leaning on the transition this method
   * announces is also deliberate: the viewer store is subscribed before the
   * transition stream is, so the store's first emission would arrive here with
   * nothing listening yet.
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
   * component can reach it. It is called from exactly one place - the
   * `onLayoutChange` handler the grid configuration is built with, which all
   * four of the engine's change callbacks forward to - which is what makes
   * those four the entire set of write origins rather than merely the usual
   * ones.
   *
   * Suppressed unless the arrangement is on screen, because destroying the
   * canvas destroys every grid item and each destruction invokes the
   * item-removed callback; those are teardown rather than intent. Suppressed
   * again unless the arrangement differs from the one last reported - see
   * {@link lastReportedLayout}.
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

    if (this.clampRunawayPlacement()) {
      return;
    }

    // Refreshed here, and only here, so what gets persisted is always the
    // current arrangement. This also subsumes refreshing it on acknowledgement,
    // because the server echoes back exactly the document it was sent.
    this.canonicalModules = this.mergeCanonicalModules();

    // Reached only once the engine has settled the cells, which is the earliest
    // point at which asking it what still fits gives a true answer. This is not
    // a save trigger.
    //
    // Unconditional, where it used to run only while the panel was open. The
    // flags describe the ARRANGEMENT, not the panel, and gating them on the panel
    // meant that between a change and the next open they described an arrangement
    // that no longer existed - so anything reading the rows in that interval, a
    // test included, read a stale answer, and the correctness of the visible list
    // rested on the open path happening to recompute first. The cost is one grid
    // scan per unplaced module on a settle, and a settle is a drag, a resize, an
    // add or a removal - viewer-paced events, not frames.
    this.refreshCatalogAvailability();

    // Everything above has run - the arrangement is recorded and the catalog knows
    // what still fits - and only the WRITE is withheld. See
    // {@link beginHydrationSettle}: this change is the engine settling an
    // arrangement that was just read, not the viewer changing one.
    if (this.isHydrationSettling) {
      return;
    }

    this.layoutChange$.next();
  }

  // `null` only for a geometry that cannot describe a cell, because there is
  // nothing to clamp such a value to; everything else is brought inside the
  // grid rather than rejected, so a stored arrangement keeps its modules. The
  // footprint is settled before the origin, because the other way round would
  // settle an origin the footprint then overflows.
  private normalizeGeometry(
    aDefinition: Pick<DashboardModuleDefinition, 'minItemCols' | 'minItemRows'>,
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
   * The engine binds a `window` resize listener and has no element observer of
   * its own, so it only learns about size changes the viewport caused. This
   * grid lives inside the drawer container's content pane, and opening the
   * catalog resizes that pane by changing its margin - the window never
   * changes, so the engine keeps positioning modules at the pitch of the wider
   * box and the right-hand modules run underneath the drawer. `onResize` is the
   * engine's own public entry point for exactly this, so this adds no layout
   * policy, only the missing trigger.
   *
   * @param aGridster the engine instance, taken from its init callback because
   * that is the only point at which it has both an element and a measured size.
   */
  private observeGridsterViewport(aGridster: Gridster) {
    // Feature-detected because this component is also instantiated under a DOM
    // shim in tests. Nothing is lost by its absence: the engine's window
    // listener still runs.
    if (typeof ResizeObserver === 'undefined' || !aGridster?.el) {
      return;
    }

    // Replaced rather than added to, so a rebuilt grid never leaves an observer
    // watching the previous host. This covers the rebuild specifically, where
    // the incoming grid initializes BEFORE the outgoing one is destroyed and
    // {@link releaseGridster} therefore declines the outgoing destruction.
    this.gridsterResizeObserver?.disconnect();

    // A fresh observer answers for a fresh grid, so what this one has acted on is
    // nothing yet - a rebuilt grid must not be judged against the previous host's
    // dimensions and skip its first layout.
    this.lastObservedGridsterHeight = null;
    this.lastObservedGridsterWidth = null;

    this.gridsterResizeObserver = new ResizeObserver(() => {
      const { clientHeight, clientWidth } = aGridster.el;

      if (
        // The brake against feedback: laying the items out can itself change the
        // host's box, so an unconditional call could be observed as another
        // change and recur. The comparison is against the box THIS observer last
        // acted on, deliberately, and NOT against the engine's own
        // `curWidth`/`curHeight` - which is what it used to be, and which was the
        // bug.
        //
        // Those two fields are not a record of the size the current layout was
        // computed at; they are a measurement cache that ANY caller of
        // `setGridDimensions()` refreshes, laying nothing out. The engine's
        // `getNextPossiblePosition()` is exactly such a caller - it looks like a
        // read-only query and is called once per unplaced module every time the
        // catalog's availability is recomputed, which happens as the panel opens -
        // see {@link settleItemPosition} and {@link refreshCatalogAvailability}.
        // So on a panel open the sequence measured in the browser was: the pane's
        // margin is applied, the probe reads the new 1088px host and writes it
        // into `curWidth` at dt 11-16ms while every item is still sized for
        // 1440px, and the observer's notification arrives at dt 16-21ms, finds
        // the two already equal, and returns without laying anything out.
        //
        // With the drawer animating, 24 further notifications followed and the
        // next one corrected it, so the fault was invisible. Under
        // `prefers-reduced-motion: reduce` the width changes exactly ONCE, so
        // losing that notification lost everything: the grid stayed laid out for
        // a 1440px container inside an 1088px box, four of six modules kept a
        // 342px strip underneath the drawer, and the state was terminal -
        // `calculateLayout()` never ran, so the engine's own
        // `resize$ -> timer(100) -> resize()` fallback was never armed, and
        // neither a keypress nor a minute of waiting recovered it. Only a window
        // resize did, because the engine's own window listener calls `onResize`
        // unguarded.
        clientHeight === this.lastObservedGridsterHeight &&
        clientWidth === this.lastObservedGridsterWidth
      ) {
        // A resize the engine does not need to act on can still change whether
        // the canvas overflows - the pane narrowing on a window too small to give
        // the grid its width back is exactly that case - so the marks are
        // re-measured either way.
        this.scheduleCanvasOverflowCheck();

        return;
      }

      this.lastObservedGridsterHeight = clientHeight;
      this.lastObservedGridsterWidth = clientWidth;

      aGridster.onResize();

      this.scheduleCanvasOverflowCheck();
    });

    this.gridsterResizeObserver.observe(aGridster.el);

    this.observeCanvasPane();

    this.observeGridsterScroll(aGridster.el);
  }

  /**
   * Adds the drawer's content pane to the grid observer.
   *
   * Separate from {@link observeGridsterViewport}, and called again from
   * {@link ngAfterViewInit}, because of an ordering that made it silently never
   * happen: the engine invokes its init callback from its own `ngOnInit`, and a
   * child directive's `ngOnInit` runs BEFORE the parent's view queries resolve, so
   * `canvasPane` was still undefined at the only point this used to be attempted.
   * Instrumenting the browser's own observer callbacks showed the pane's element
   * never appearing among the observed targets at all.
   *
   * It has to be observed because on a window too narrow to pay for both the panel
   * and the canvas the grid's own box does NOT change when the panel opens - its
   * width floor holds it and the pane clips onto it instead - so the grid alone
   * reports nothing and the edge marks would keep describing the pane size that
   * applied before the panel opened.
   *
   * Observing an element twice is a no-op, so being called from both places costs
   * nothing.
   */
  private observeCanvasPane() {
    if (!this.gridsterResizeObserver || !this.canvasPane?.nativeElement) {
      return;
    }

    this.gridsterResizeObserver.observe(this.canvasPane.nativeElement);
  }

  // The engine's host is the canvas block-axis scrollport, so its scroll position
  // is what decides whether either edge mark is shown.
  //
  // Registered outside Angular, because a scroll listener on the canvas would
  // otherwise schedule a change-detection pass for every frame of every scroll.
  // Re-entry is deliberately narrow: only {@link applyCanvasOverflowState} steps
  // back in, and only when an edge has actually changed.
  private observeGridsterScroll(aElement: HTMLElement) {
    this.releaseGridsterScroll();

    this.gridsterScrollElement = aElement;

    this.zone.runOutsideAngular(() => {
      aElement.addEventListener('scroll', this.scheduleCanvasOverflowCheck, {
        passive: true
      });

      this.scheduleCanvasOverflowCheck();
    });
  }

  // Compared before anything is written, so a scroll that does not cross an edge
  // costs no change detection at all - which is what makes it safe to run this
  // from a per-frame scroll handler.
  private applyCanvasOverflowState() {
    const element = this.gridsterScrollElement;

    const hasCanvasOverflowAbove = element
      ? element.scrollTop > CANVAS_OVERFLOW_TOLERANCE
      : false;
    const hasCanvasOverflowBelow = element
      ? element.scrollHeight - element.clientHeight - element.scrollTop >
        CANVAS_OVERFLOW_TOLERANCE
      : false;

    if (
      hasCanvasOverflowAbove === this.hasCanvasOverflowAbove &&
      hasCanvasOverflowBelow === this.hasCanvasOverflowBelow
    ) {
      return;
    }

    // The one re-entry into Angular, taken only for an actual change.
    this.zone.run(() => {
      this.hasCanvasOverflowAbove = hasCanvasOverflowAbove;
      this.hasCanvasOverflowBelow = hasCanvasOverflowBelow;

      this.changeDetectorRef.markForCheck();
    });
  }

  // Held as a field so the same reference can be added and removed as an event
  // listener, and coalesced to one measurement per frame because the scroll
  // listener and the size observer can both fire within a single frame.
  private scheduleCanvasOverflowCheck = () => {
    if (this.isCanvasOverflowCheckScheduled) {
      return;
    }

    this.isCanvasOverflowCheckScheduled = true;

    // `requestAnimationFrame` is feature-detected because this component is also
    // instantiated under a DOM shim in tests, where the measurement is taken
    // straight away instead.
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => {
        this.isCanvasOverflowCheckScheduled = false;

        this.applyCanvasOverflowState();
      });

      return;
    }

    this.isCanvasOverflowCheckScheduled = false;

    this.applyCanvasOverflowState();
  };

  // Paired with {@link observeGridsterScroll}. The marks are cleared with the
  // listener rather than left standing, because a canvas with no scrollport
  // cannot be continuing past an edge.
  private releaseGridsterScroll() {
    this.gridsterScrollElement?.removeEventListener(
      'scroll',
      this.scheduleCanvasOverflowCheck
    );

    this.gridsterScrollElement = null;

    this.hasCanvasOverflowAbove = false;
    this.hasCanvasOverflowBelow = false;
  }

  /**
   * Where a module goes is settled by the engine, at the module's own declared
   * footprint, before the item is admitted - see {@link settleItemPosition}. An
   * item the engine will not accept anywhere is not added at all, because the
   * array this appends to is the authoritative one and is what gets persisted.
   *
   * @param aPosition the cell a drop landed on. Omitted for click-to-add, where
   * the grid engine chooses.
   */
  private placeModule(
    aDefinition: DashboardModuleDefinition,
    aPosition?: { x: number; y: number }
  ) {
    // An unread arrangement must not be added to: the array is empty because
    // the read failed, not because the viewer has nothing placed, so appending
    // here would make the next write claim that one module is all they have.
    if (!this.isInitialized || this.hasLayoutError) {
      return;
    }

    this.endHydrationSettle();

    const placed = this.modules.find(({ moduleType }) => {
      return moduleType === aDefinition.moduleType;
    });

    if (placed) {
      this.revealExistingModule(placed);

      return;
    }

    const item = this.settleModuleFootprint(aDefinition, aPosition);

    // A refusal is the engine reporting that this module fits nowhere left on
    // the grid at either of the footprints it declares. It has to be surfaced,
    // because the item is deliberately not added and an unreported refusal is
    // indistinguishable from a click that did nothing.
    if (!item) {
      this.hasCapacityError = true;

      this.announce(
        $localize`There is no room left on the dashboard for ${this.qualifyDefinitionName(aDefinition)}:moduleName:. Remove or resize a module to make space.`
      );

      this.changeDetectorRef.markForCheck();

      return;
    }

    this.hasCapacityError = false;

    const isRelocated =
      !!aPosition && (item.x !== aPosition.x || item.y !== aPosition.y);

    const name = this.qualifyDefinitionName(aDefinition);

    this.announce(
      isRelocated
        ? $localize`${name}:moduleName: did not fit where it was dropped and was added at column ${item.x + 1}:column:, row ${item.y + 1}:row:`
        : $localize`${name}:moduleName: added to the dashboard at column ${item.x + 1}:column:, row ${item.y + 1}:row:`
    );

    // Released before the cell is drawn, because the engine reads the option on
    // entry to the size computation that draws it. This is the one case the
    // engine's own reveal is meant for: a module the viewer asked for, which
    // may land below the fold.
    this.applyNewItemReveal(true);

    this.modules.push(item);

    // Marked before the array is even seen by the template: the cell does not
    // exist yet, so the engine reporting its first paint is the earliest moment
    // it can be brought into view. Nothing is reported from here.
    this.pendingRevealItem = item;

    this.changeDetectorRef.markForCheck();
  }

  /**
   * This canvas OUTLIVES its grid: every state that draws no grid destroys the
   * `gridster` child while the canvas carries on, so the element observer and
   * the instance reference both have to be given back at that moment rather
   * than at the canvas's own teardown.
   *
   * Guarded on identity rather than clearing outright, and that is what makes
   * it safe: a rebuild initialises the incoming grid BEFORE destroying the
   * outgoing one, so an unconditional clear would discard the live instance.
   *
   * @param aGridster the instance the engine reports as destroyed.
   */
  private releaseGridster(aGridster: Gridster) {
    if (this.gridster !== aGridster) {
      return;
    }

    this.gridsterResizeObserver?.disconnect();
    this.gridsterResizeObserver = null;

    this.lastObservedGridsterHeight = null;
    this.lastObservedGridsterWidth = null;

    this.releaseGridsterScroll();

    this.gridster = null;
  }

  // Each candidate is offered to the engine exactly as click-to-add would offer
  // it, so what the catalog shows and what an add actually does cannot
  // disagree. The probe uses a throwaway item, because the engine replies by
  // writing the position it found onto the item it is handed. Called only when
  // the arrangement has settled or the drawer is opening, never from a getter:
  // one grid scan per unplaced module.
  private refreshCatalogAvailability() {
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
        return (
          !placedModuleTypes.has(definition.moduleType) &&
          !this.settleModuleFootprint(definition)
        );
      })
      .map(({ moduleType }) => moduleType);
  }

  /**
   * Offers a module to the engine at its declared DEFAULT footprint and, if that
   * is refused, again at its declared MINIMUM one - answering with whichever item
   * the engine accepted, or `null` when neither fits anywhere.
   *
   * The second attempt is the correctness of it. A default footprint is a
   * preference - the size a module is worth having when there is room for it -
   * while the minimum is the contract: the size below which the module stops
   * being usable, declared per module and enforced by grid policy. Judging
   * capacity on the preference alone understated it, and did so visibly: a
   * twelve-by-seven job queue was reported as having no room while a
   * six-wide-by-seven-tall hole sat open on the grid, which its own six-by-four
   * minimum fits twice over - proven when a different module took that exact hole
   * moments later. A viewer was told the dashboard was full while it was not.
   *
   * It never goes below the minimum, so Rule 6's floor is untouched, and it never
   * shrinks a module that fits at its default. The skip when the two footprints
   * are equal is not an optimisation - it is what keeps a module that declares no
   * headroom from being scanned for twice and reported on identically.
   *
   * Used by BOTH the add path and the catalog's availability scan, from one
   * routine, because those two answers must not be able to disagree: a row
   * offering to add would otherwise be refused on the click, or a row marked
   * out of room would add when pressed.
   *
   * @param aPosition the cell a drop landed on; omitted for click-to-add, where
   * the engine chooses.
   */
  private settleModuleFootprint(
    aDefinition: DashboardModuleDefinition,
    aPosition?: { x: number; y: number }
  ): DashboardLayoutItem | null {
    const item = this.createLayoutItem(aDefinition, aPosition);

    if (this.settleItemPosition(item, aPosition)) {
      return item;
    }

    if (
      aDefinition.defaultItemCols === aDefinition.minItemCols &&
      aDefinition.defaultItemRows === aDefinition.minItemRows
    ) {
      return null;
    }

    // A fresh item rather than the one above: the engine writes the cells it
    // scanned onto the item it is handed even when it ends up refusing, so
    // reusing it would start the second scan from wherever the first gave up.
    const minimumItem: DashboardLayoutItem = {
      ...this.createLayoutItem(aDefinition, aPosition),
      cols: aDefinition.minItemCols,
      rows: aDefinition.minItemRows
    };

    return this.settleItemPosition(minimumItem, aPosition) ? minimumItem : null;
  }

  // Delegated to the chrome that owns the mounting, so a module is made to
  // fetch again without this component knowing what any module fetches. The
  // arrangement is untouched, so no grid callback fires and nothing is written.
  /**
   * Refreshes every placed module and reports when that has finished.
   *
   * Awaiting all of them is what makes the refresh a bounded operation rather than
   * an unacknowledged one: the busy state is raised before the first module drops
   * its content and lowered when the last has been re-resolved, and only then is
   * completion announced. A viewer who cannot see the screen previously heard that
   * a refresh had started and never heard that it had ended.
   *
   * `allSettled` rather than `all`, because a module whose chunk fails to resolve
   * must not leave the canvas permanently busy - the module reports its own failure
   * in its own card, and the refresh as a whole is still over.
   */
  private async reloadPlacedModules() {
    const hosts = this.moduleHosts?.toArray() ?? [];

    if (hosts.length === 0) {
      return;
    }

    this.isRefreshing = true;

    this.changeDetectorRef.markForCheck();

    try {
      await Promise.allSettled(hosts.map((host) => host.reload()));
    } finally {
      this.isRefreshing = false;

      this.changeDetectorRef.markForCheck();
    }

    this.announce($localize`The dashboard has been refreshed`);
  }

  /**
   * The order is the behaviour. Clearing readiness first means the grid is torn
   * down while nothing is reportable, so the item-removed callback each
   * destroyed cell fires is recognised as teardown rather than as the outgoing
   * viewer deleting their modules. Clearing the reported fingerprint last means
   * the incoming arrangement is compared against nothing rather than somebody
   * else's.
   *
   * The canonical arrangement goes with the rest, and it must: it is what a
   * write is built from, so an entry left behind would be persisted into the
   * incoming viewer's account the first time they moved anything.
   */
  private resetForViewerChange() {
    this.hasLayoutError = false;
    this.isInitialized = false;

    this.modules.length = 0;
    this.canonicalModules = [];

    this.lastReportedLayout = null;
    this.pendingRevealItem = null;
  }

  // Both channels of the answer are consumed, and consuming the successful one
  // is not redundant: the user service serves an already-fetched viewer from
  // its cache, and a cache hit does *not* dispatch through the store, so for
  // that answer the constructor's subscription never fires. That is the
  // reachable case - store emissions are ignored while a shared portfolio is
  // shown, and dropping the share parameter asks for a viewer the store has
  // been holding all along.
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
          if (this.isUnauthorizedError(error)) {
            this.markSignedOut();

            return;
          }

          // The most severe failure this surface has was also the only one that
          // left no trace: an unreadable ARRANGEMENT reports
          // `GF-DASHBOARD-LAYOUT-FETCH-FAILED` while an unreadable VIEWER - which
          // costs the whole canvas rather than one arrangement - said nothing at
          // all, so an operator had no breadcrumb for the worse of the two. Same
          // sanitized reporter as every other diagnostic on this surface, so the
          // status travels and nothing about the response body does.
          reportSanitizedError('GF-DASHBOARD-VIEWER-FETCH-FAILED', error);

          this.hasViewerError = true;

          this.changeDetectorRef.markForCheck();
        },
        next: (aUser: User) => {
          if (this.user === undefined) {
            this.handleViewerState(aUser);
          }
        }
      });
  }

  // The flag is what matters and is set unconditionally; the element is a
  // preference and may legitimately come out `null`, because a browser is not
  // obliged to focus a button that was clicked. The body is excluded because it
  // is what `activeElement` reports when nothing is focused.
  private captureCatalogFocusOrigin() {
    const trigger = this.catalogTrigger?.nativeElement;
    const activeElement = trigger?.ownerDocument?.activeElement;

    this.catalogFocusOrigin =
      activeElement instanceof HTMLElement &&
      activeElement !== trigger?.ownerDocument?.body
        ? activeElement
        : null;
  }

  // The guard that keeps the restoration from becoming a theft: a drawer can
  // close while focus is somewhere else entirely, and only focus about to be
  // orphaned by the closing panel is worth rescuing.
  private isFocusInsideCatalog(): boolean {
    const drawer = this.catalogDrawer?.nativeElement;
    const activeElement = drawer?.ownerDocument?.activeElement;

    return !!activeElement && drawer.contains(activeElement);
  }

  // Unconditional: however the panel came to be open, it takes focus the same
  // way. The origin is only dropped when the move did not land, because a return
  // journey to somewhere focus never left is worse than none.
  private moveFocusIntoCatalog() {
    if (!this.moduleCatalog?.focusSearchField()) {
      this.catalogFocusOrigin = null;
    }
  }

  /**
   * One condition gates the move, and it is containment rather than ownership:
   * focus inside the closing panel is about to be orphaned to the document
   * body, which ejects a keyboard-only viewer from the application, and that
   * harm does not depend on whether this canvas put focus there. Focus anywhere
   * else is being used.
   *
   * The floating trigger is the fallback destination because it is the one
   * control nothing the viewer does can remove, whereas the empty canvas's
   * affordance stops being drawn the moment a module lands. The connectivity
   * check and the read-back are both load-bearing: `focus()` on a detached or
   * hidden element is a no-op.
   */
  private restoreFocusFromCatalog() {
    const origin = this.catalogFocusOrigin;

    this.catalogFocusOrigin = null;

    if (!this.isFocusInsideCatalog()) {
      return;
    }

    if (origin?.isConnected) {
      origin.focus();

      if (origin.ownerDocument?.activeElement === origin) {
        return;
      }
    }

    this.catalogTrigger?.nativeElement.focus();
  }

  /**
   * Deferred to a task rather than run inline, and the delay is doing real work
   * in two directions. The removal is requested from a menu item whose trigger
   * lives inside the module about to disappear, and that trigger is re-focused
   * synchronously as the menu closes, right after this handler returns. The
   * module is also still on screen at that point, because the array has been
   * spliced but the view has only been marked. Focusing now would be
   * overwritten by the menu and then dropped to the document body when the
   * element holding it was removed.
   *
   * Every candidate reports whether focus landed, because `focus()` on a
   * detached or hidden element is a silent no-op. The catalog trigger is the
   * final fallback because it survives an emptied canvas when no module handle
   * does.
   */
  // Deliberately not the layout fingerprint used for persistence: that one covers
  // the whole arrangement and exists to decide whether to WRITE. This covers one
  // module and exists only to decide what to say about it.
  private createGeometryFingerprint(
    aGeometry: DashboardModuleGeometry
  ): string {
    return `${aGeometry.cols}:${aGeometry.rows}:${aGeometry.x}:${aGeometry.y}`;
  }

  private recordAnnouncedGeometry(aItem: GridsterItemConfig) {
    const item = this.modules.find((module) => {
      return module === aItem;
    });

    if (!item) {
      return;
    }

    this.announcedGeometry.set(
      item.moduleType,
      this.createGeometryFingerprint(item)
    );
  }

  private restoreFocusAfterRemoval(
    aTarget: GfDashboardModuleHostComponent | null
  ) {
    window.clearTimeout(this.focusRestorationHandle);

    this.focusRestorationHandle = window.setTimeout(() => {
      this.focusRestorationHandle = undefined;

      if (aTarget?.focusDragHandle()) {
        return;
      }

      this.catalogTrigger?.nativeElement.focus();
    });
  }

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
      return hosts[0] ?? null;
    }

    return hosts[index + 1] ?? hosts[index - 1] ?? null;
  }

  private revealOrPlaceModule(aModuleType: DashboardModuleType) {
    const definition = this.moduleRegistryService.get(aModuleType);

    if (!definition || !this.isModulePermitted(definition)) {
      return;
    }

    this.placeModule(definition);
  }

  private revealPlacedModule(aItem: DashboardLayoutItem) {
    const element = this.gridster?.getItemComponent(aItem)?.el;

    element?.scrollIntoView?.({ behavior: 'smooth', block: 'nearest' });
  }

  /**
   * A module the viewer asked for that is already on the canvas.
   *
   * Nothing is added, which is why this needs to do more than scroll. The module
   * is often already fully in view, and `scrollIntoView` with `nearest` is by
   * definition a no-op when it is - so the request reads as a control that did
   * nothing at all. Worse for a keyboard viewer: the assistant that issued it
   * closes its own panel without restoring focus, which is how it has always
   * behaved and was harmless while the same selection was a navigation, because
   * the router placed focus. On one canvas nothing navigates, so focus is simply
   * dropped to the document body and the only way back is to Tab from the top.
   *
   * Focus therefore lands on the module's own drag handle: the one element every
   * module always has, positioned first in its chrome, and the one that puts the
   * arrow keys straight under the reader's fingers on the module they just asked
   * for. It doubles as the confirmation that the request was heard.
   */
  private revealExistingModule(aItem: DashboardLayoutItem) {
    this.revealPlacedModule(aItem);

    this.focusModule(aItem);

    // Said as well as done, because focus and a scroll are both invisible to a
    // reader who has neither: the assistant closes its own panel on selection, so
    // without this the request produced no message, no visible change a reader could
    // be told about, and - when the module was on screen already - no scroll either.
    //
    // One sentence for every outcome, deliberately. Whether focus landed is not the
    // viewer's concern, and a module that reached this point is always one this build
    // renders: an unknown or unpermitted entry never becomes a grid item, so it is
    // never found here in the first place.
    this.announce(
      $localize`${this.getQualifiedModuleName(aItem.moduleType)}:moduleName: is already on the dashboard`
    );
  }

  // Matched by module type rather than by position: the grid owns the order of
  // its own children, so the query list is not reliably the array's order. Reports
  // whether focus landed, because `focus()` on a hidden or detached element is a
  // silent no-op.
  private focusModule(aItem: DashboardLayoutItem): boolean {
    const host = (this.moduleHosts?.toArray() ?? []).find(({ definition }) => {
      return definition?.moduleType === aItem.moduleType;
    });

    return host?.focusDragHandle() ?? false;
  }

  // A funnel rather than three assignments, because opening has to answer which
  // rows cannot be added right now and every route in has to answer it: the
  // floating trigger, the empty-canvas affordance, and the drawer closing
  // itself on Escape.
  //
  // Recording where focus was is part of opening rather than something each
  // caller remembers to do first, which is what makes every route in behave the
  // same - including the two that open the panel because the arrangement went
  // empty, where the recorded origin is legitimately `null`. Captured before the
  // flag flips only for legibility; flipping a boolean moves no focus.
  private setCatalogOpen(aIsOpen: boolean) {
    if (aIsOpen) {
      this.captureCatalogFocusOrigin();

      this.refreshCatalogAvailability();
    }

    this.isCatalogOpen = aIsOpen;

    this.changeDetectorRef.markForCheck();
  }

  /**
   * The engine decides, at the item's own size, and it is asked about *this*
   * item rather than a stand-in: a drag out of the catalog is screened by the
   * library against a candidate it minted itself at the configured default
   * footprint, so the fact that the preview fitted says nothing about whether
   * the real item does.
   *
   * `getNextPossiblePosition` must be called on the component instance: the
   * identically named member of the `GridsterApi` surface returns `void`, so
   * its answer could neither be acted on nor asserted. For a drop the scan
   * starts at the released row so the module lands at or below where it was let
   * go. `false` means there is nowhere at all, and the correct response is to
   * add nothing.
   *
   * With no instance - possible only before the grid has ever rendered, so
   * never on a drop - the item keeps the origin it was minted with and the
   * engine's own `addItem` settles it on init through this very routine.
   *
   * @param aItem the item that will actually be added; mutated in place with
   * the cell it ends up at, exactly as the engine mutates the items it owns.
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

    // Deliberately unaware of the cells a module with no card has saved. Reserving
    // those here would be the other way to answer the overlap problem, and it was
    // measured against this one and rejected: a viewer whose subscription has
    // lapsed has several saved-but-undrawn modules, so every module they then add
    // would be pushed below all of them - a canvas showing two cards with eleven
    // empty rows above the second. The arrangement the viewer can see stays the
    // engine's to arrange; the overlap is resolved by moving the module they cannot
    // see, in {@link relocateReservedModules}.
    return aPosition
      ? this.gridster.getNextPossiblePosition(aItem, { y: aPosition.y })
      : this.gridster.getNextPossiblePosition(aItem);
  }

  // The barrier every identity change passes through. A read still on its way
  // is invalidated first and unconditionally, because it was started for the
  // identity being replaced. The clearing is delegated - see {@link
  // resetForViewerChange} - and it also closes {@link placeModule}, so an
  // intent arriving mid-transition cannot put a module onto a canvas that is
  // about to be replaced.
  private suspendCanvas() {
    this.hydrationGeneration += 1;

    if (!this.isInitialized && this.modules.length === 0) {
      return;
    }

    this.resetForViewerChange();
  }
}
