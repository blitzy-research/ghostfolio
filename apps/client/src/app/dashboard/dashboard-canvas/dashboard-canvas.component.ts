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

// Widened at declaration because `HttpErrorResponse.status` is a plain number,
// which keeps the comparison free of an enum-comparison lint report and a cast.
const UNAUTHORIZED_STATUS: number = StatusCodes.UNAUTHORIZED;

// The only document shape this build can interpret. Anything else is refused
// rather than rewritten in an older shape.
const SUPPORTED_LAYOUT_VERSION = 1;

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
    GfDashboardModuleHostComponent,
    GfDashboardToolbarComponent,
    GfEmptyCanvasStateComponent,
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
export class GfDashboardCanvasComponent implements OnDestroy, OnInit {
  @ViewChildren(GfDashboardModuleHostComponent)
  public moduleHosts: QueryList<GfDashboardModuleHostComponent>;

  // Read as an `ElementRef` explicitly: the reference names a Material button,
  // so the default read would hand back that component rather than its element.
  @ViewChild('catalogTrigger', { read: ElementRef })
  private catalogTrigger: ElementRef<HTMLElement>;

  @ViewChild('catalogDrawer', { read: ElementRef })
  private catalogDrawer: ElementRef<HTMLElement>;

  @ViewChild(GfModuleCatalogComponent)
  private moduleCatalog: GfModuleCatalogComponent;

  public hasCapacityError = false;

  // An unreadable arrangement is not an empty one. Reporting it as empty would
  // open the catalog as though this were a first visit and let the next module
  // added be written out as the viewer's complete arrangement. While this is
  // set the canvas permits no write of any kind.
  public hasLayoutError = false;

  public hasSaveError = false;

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

  private focusRestorationHandle: number | undefined;

  // Whether the current open was asked for by the viewer, which cannot be read
  // off the open flag. A requested open should pull focus into the panel; an
  // open the canvas offers unprompted must not, because it would take the caret
  // off a viewer who is reading. The unprompted sites set the open flag
  // directly.
  private hasCatalogFocusOrigin = false;

  private catalogFocusOrigin: HTMLElement | null = null;

  private hasHydratedLayout = false;

  // Raised only while a runaway placement is being corrected, because the
  // correction travels through the engine and is reported back through the
  // handler that requested it. See {@link clampRunawayPlacement}.
  private isClampingPlacement = false;

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
        this.reloadPlacedModules();
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

  public get placedModuleTypes(): DashboardModuleType[] {
    return this.modules.map(({ moduleType }) => moduleType);
  }

  public ngOnDestroy() {
    this.gridsterResizeObserver?.disconnect();
    this.gridsterResizeObserver = null;
    this.gridster = null;

    window.clearTimeout(this.focusRestorationHandle);
    this.focusRestorationHandle = undefined;
  }

  public ngOnInit() {
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
    this.applyDropPreviewFootprint(
      DEFAULT_DROP_PREVIEW_COLS,
      DEFAULT_DROP_PREVIEW_ROWS
    );
  }

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

  public onOpenCatalog() {
    this.captureCatalogFocusOrigin();

    this.setCatalogOpen(true);
  }

  public onRetryLayout() {
    this.hasLayoutError = false;
    this.isInitialized = false;

    this.modules.length = 0;
    this.canonicalModules = [];
    this.lastReportedLayout = null;

    this.changeDetectorRef.markForCheck();

    this.hydrateLayout();
  }

  public onRetrySave() {
    this.dashboardLayoutService.retryFailedSave();
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

    const definition = this.getModuleDefinition(aItem.moduleType);
    const name = definition?.name ?? aItem.moduleType;

    // Resolved BEFORE the array is touched, while the removed module's chrome
    // is still in the query and its neighbours are still either side of it.
    const focusTarget = this.resolveFocusTargetAfterRemoval(definition);

    this.modules.splice(index, 1);

    this.hasCapacityError = false;

    this.canvasAnnouncement = $localize`${name}:moduleName: removed from the dashboard`;

    if (this.modules.length === 0) {
      this.isCatalogOpen = true;
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
    const isOpening = !this.isCatalogOpen;

    if (isOpening) {
      this.captureCatalogFocusOrigin();
    }

    this.setCatalogOpen(isOpening);
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

  private applyLayout(aLayout: UserDashboardLayout | null) {
    if (aLayout && !this.isReadableLayout(aLayout)) {
      this.hasLayoutError = true;
      this.isInitialized = true;

      this.changeDetectorRef.markForCheck();

      return;
    }

    this.canonicalModules = this.createCanonicalModules(aLayout);

    const items = this.createLayoutItems(this.canonicalModules);

    this.applyNewItemReveal(false);

    this.modules.length = 0;
    this.modules.push(...items);

    this.lastReportedLayout = this.createLayoutFingerprint();

    if (this.modules.length === 0) {
      this.isCatalogOpen = true;
    }

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
      this.isCatalogOpen = true;
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
   * A discriminator the registry no longer knows and a repeated discriminator
   * are both dropped in silence - the template's cell key could not tell the
   * latter apart from the first. Permission is deliberately not considered,
   * which is what separates this from {@link createLayoutItems}: an entry the
   * viewer may not currently see has to stay or the next edit would delete it.
   *
   * Every surviving entry is normalized, because the stored geometry is
   * whatever some earlier client wrote and the engine is never consulted for an
   * item that arrives already placed. Nothing is written as a result, so a
   * correction reaches the server only when the viewer next changes something
   * themselves.
   */
  private createCanonicalModules(
    aLayout: UserDashboardLayout | null
  ): DashboardModuleLayoutItem[] {
    const definitions = this.getDefinitionsByModuleType();
    const modules: DashboardModuleLayoutItem[] = [];

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
    if (!this.pendingRevealItem || aItem !== this.pendingRevealItem) {
      return;
    }

    const item = this.pendingRevealItem;

    this.pendingRevealItem = null;

    this.revealPlacedModule(item);
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
        error: () => {
          if (generation !== this.hydrationGeneration) {
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

  // `accessId` is not exclusively a share-link parameter: the account access
  // module produces
  // `?accessId=<id>&dialogModule=account-access&editDialog=true` against this
  // very route to reopen its own edit dialog. Matching on `accessId` alone
  // would replace a signed-in viewer's canvas with a stranger's portfolio the
  // moment they edited one of their own access grants.
  private isSharedPortfolioRequest({
    accessId,
    editDialog
  }: GfAppQueryParams): boolean {
    return !!accessId && !editDialog;
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
   * *removed*, which must be forgotten, or one they are not *permitted* to see,
   * which must be kept. Forget the second and a lapsed subscription silently
   * deletes modules; keep the first and a removed module comes back on the next
   * load.
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

      return !!definition && !this.isModulePermitted(definition);
    });

    return [...visible, ...retainedHidden];
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
    if (this.isCatalogOpen) {
      this.refreshCatalogAvailability();
    }

    this.layoutChange$.next();
  }

  // `null` only for a geometry that cannot describe a cell, because there is
  // nothing to clamp such a value to; everything else is brought inside the
  // grid rather than rejected, so a stored arrangement keeps its modules. The
  // footprint is settled before the origin, because the other way round would
  // settle an origin the footprint then overflows.
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

    this.gridsterResizeObserver = new ResizeObserver(() => {
      const { clientHeight, clientWidth } = aGridster.el;

      if (
        // The guard against feedback: `onResize` re-measures the host and
        // writes the result back, and laying out the items can itself change
        // the host's box, so an unconditional call would be observed as another
        // change and recur.
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

    const placed = this.modules.find(({ moduleType }) => {
      return moduleType === aDefinition.moduleType;
    });

    if (placed) {
      this.revealPlacedModule(placed);

      return;
    }

    const item = this.createLayoutItem(aDefinition, aPosition);

    // A refusal is the engine reporting that this footprint fits nowhere left
    // on the grid. It has to be surfaced, because the item is deliberately not
    // added and an unreported refusal is indistinguishable from a click that
    // did nothing.
    if (!this.settleItemPosition(item, aPosition)) {
      this.hasCapacityError = true;

      this.canvasAnnouncement = $localize`There is no room left on the dashboard for ${aDefinition.name}:moduleName:. Remove or resize a module to make space.`;

      this.changeDetectorRef.markForCheck();

      return;
    }

    this.hasCapacityError = false;

    const isRelocated =
      !!aPosition && (item.x !== aPosition.x || item.y !== aPosition.y);

    this.canvasAnnouncement = isRelocated
      ? $localize`${aDefinition.name}:moduleName: did not fit where it was dropped and was added at column ${item.x + 1}:column:, row ${item.y + 1}:row:`
      : $localize`${aDefinition.name}:moduleName: added to the dashboard at column ${item.x + 1}:column:, row ${item.y + 1}:row:`;

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
          !this.settleItemPosition(this.createLayoutItem(definition))
        );
      })
      .map(({ moduleType }) => moduleType);
  }

  // Delegated to the chrome that owns the mounting, so a module is made to
  // fetch again without this component knowing what any module fetches. The
  // arrangement is untouched, so no grid callback fires and nothing is written.
  private reloadPlacedModules() {
    this.moduleHosts?.forEach((host) => {
      host.reload();
    });
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
    this.hasCatalogFocusOrigin = true;

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

  private moveFocusIntoCatalog() {
    if (!this.hasCatalogFocusOrigin) {
      return;
    }

    if (!this.moduleCatalog?.focusSearchField()) {
      this.hasCatalogFocusOrigin = false;
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

    this.hasCatalogFocusOrigin = false;
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

  // A funnel rather than three assignments, because opening has to answer which
  // rows cannot be added right now and every route in has to answer it: the
  // floating trigger, the empty-canvas affordance, and the drawer closing
  // itself on Escape.
  private setCatalogOpen(aIsOpen: boolean) {
    this.isCatalogOpen = aIsOpen;

    if (aIsOpen) {
      this.refreshCatalogAvailability();
    }

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
