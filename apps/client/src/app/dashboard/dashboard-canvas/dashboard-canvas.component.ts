import { GfPublicPortfolioComponent } from '@ghostfolio/client/components/public-portfolio/public-portfolio.component';
import { DashboardIntentService } from '@ghostfolio/client/core/dashboard-intent.service';
import { GfAppQueryParams } from '@ghostfolio/client/interfaces/interfaces';
import { UserService } from '@ghostfolio/client/services/user/user.service';
import { User, UserDashboardLayout } from '@ghostfolio/common/interfaces';
import { hasPermission } from '@ghostfolio/common/permissions';

import { HttpErrorResponse } from '@angular/common/http';
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
import { MatCardModule } from '@angular/material/card';
import { MatSidenavModule } from '@angular/material/sidenav';
import { ActivatedRoute, Router } from '@angular/router';
import { IonIcon } from '@ionic/angular/standalone';
import { Gridster, GridsterItem } from 'angular-gridster2';
import type { GridsterConfig, GridsterItemConfig } from 'angular-gridster2';
import { StatusCodes } from 'http-status-codes';
import { addIcons } from 'ionicons';
import { addOutline, closeOutline } from 'ionicons/icons';
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
import { createDashboardCanvasConfig } from './dashboard-canvas.config';
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
  // Both classes are functional rather than decorative. `gf-gridster` is the scope
  // the global grid stylesheet hangs every override off: gridster ships
  // unencapsulated styles with hardcoded colours at element-selector specificity
  // and Angular injects them after the application stylesheet, so an override
  // needs this extra class to outweigh them. `page` supplies the host's flex
  // column and its scrollport.
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
    MatCardModule,
    MatSidenavModule
  ],
  schemas: [CUSTOM_ELEMENTS_SCHEMA],
  selector: 'gf-dashboard-canvas',
  styleUrls: ['./dashboard-canvas.scss'],
  templateUrl: './dashboard-canvas.html'
})
export class GfDashboardCanvasComponent implements OnDestroy, OnInit {
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
   * Whether the module catalog drawer is open.
   *
   * Owned here rather than by the catalog, which renders no drawer of its own.
   * It is bound in both directions, because the drawer also closes itself on
   * Escape and this flag drives the trigger's glyph.
   */
  /**
   * The text of the canvas's polite live region: the outcome of the most recent
   * keyboard move or resize.
   *
   * Empty until a keyboard geometry command is issued, so nothing is announced on
   * load. It is a plain string rather than a queue because each announcement
   * supersedes the last - a user stepping a module across the grid wants where it
   * is now, not a recital of every cell it passed through.
   */
  public geometryAnnouncement = '';

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

  private gridster: Gridster;

  private hasHydratedLayout = false;

  /**
   * The arrangement exactly as it was last fetched, kept so that a module the
   * viewer was not entitled to see can be admitted later without a second
   * round trip.
   *
   * It is a record of what the server holds, never a second authority over what
   * is on the canvas: nothing reads it to decide a position, and grid state
   * remains the only source of truth for geometry. It is needed because
   * `applyLayout` deliberately drops entries this viewer may not see, so the
   * live array alone cannot answer "what would this arrangement look like with
   * one more permission".
   */
  private hydratedLayout: UserDashboardLayout | null = null;

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
    @Inject(DOCUMENT) private document: Document,
    private moduleRegistryService: GfModuleRegistryService,
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
        // it belongs to. What to send and when to send it is the layout
        // service's business, not this component's - but *whose* arrangement it
        // is can only be answered here, and it has to travel with the snapshot
        // because the write happens after a debounce, by which time the token
        // that authorises it may belong to somebody else.
        this.dashboardLayoutService.scheduleSave(this.user?.id, this.modules);
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
    this.lastReportedLayout = null;

    this.changeDetectorRef.markForCheck();

    this.hydrateLayout();
  }

  /**
   * Sends the arrangement whose write failed again.
   *
   * Delegated in full: the layout service still owns the snapshot, the debounce
   * and the request, so this adds no second write origin.
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

    this.modules.splice(index, 1);

    this.changeDetectorRef.markForCheck();
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
    this.isCatalogOpen = !this.isCatalogOpen;

    this.changeDetectorRef.markForCheck();
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
      this.geometryAnnouncement = aIsResize
        ? $localize`${name}:moduleName: cannot be resized any further`
        : $localize`${name}:moduleName: cannot be moved any further`;

      return;
    }

    this.geometryAnnouncement = aIsResize
      ? $localize`${name}:moduleName: resized to ${aItem.cols}:columns: columns by ${aItem.rows}:rows: rows`
      : $localize`${name}:moduleName: moved to column ${aItem.x + 1}:column:, row ${aItem.y + 1}:row:`;
  }

  /**
   * Puts a fetched arrangement on the canvas.
   *
   * The array is emptied and refilled rather than replaced, so the one array
   * this component owns keeps its identity.
   */
  private applyLayout(aLayout: UserDashboardLayout | null) {
    const items = this.createLayoutItems(aLayout);

    // Recorded before the entries this viewer may not see are dropped, so that a
    // permission granted later can still admit its module at the position it was
    // saved at. See `hydratedLayout`.
    this.hydratedLayout = aLayout ?? null;

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
   * render order; a grant is answered from the last fetched arrangement, which
   * is the only place a module that was never placed still has a saved position.
   * Newly admitted modules are appended, so nothing already on screen moves.
   *
   * Deduplication is by discriminator, matching `createLayoutItems`, because the
   * template keys its cells on it and a repeat would collide.
   *
   * Nothing is reported to the layout service. A change in what a viewer is
   * allowed to see is not a change the viewer made, and persisting it would
   * erase a module from their saved arrangement the moment a subscription
   * lapsed.
   */
  private applyPermittedModules() {
    const retained = this.modules.filter((item) =>
      this.isModuleRenderable(item)
    );

    const retainedModuleTypes = new Set(
      retained.map(({ moduleType }) => moduleType)
    );

    const admitted = this.createLayoutItems(this.hydratedLayout).filter(
      ({ moduleType }) => {
        return !retainedModuleTypes.has(moduleType);
      }
    );

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

    // Recorded last, over the arrangement this re-screen actually produced, so
    // that the grid callbacks its own render and teardown fire measure as
    // unchanged and reach no write. This is the canvas correcting what it is
    // allowed to draw, not the viewer editing their arrangement, and persisting
    // it would delete a module the viewer may be entitled to again tomorrow.
    this.lastReportedLayout = this.createLayoutFingerprint();
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
   */
  private clearJwtQueryParam() {
    const { jwt }: GfAppQueryParams = this.route.snapshot.queryParams;

    if (!jwt) {
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
   * Turns a saved arrangement into grid items, dropping everything it cannot
   * honour.
   *
   * Three entries are dropped in silence, and each of them has to be: a
   * discriminator the registry no longer knows, which is how an arrangement saved
   * before a module was renamed or withdrawn still loads; one whose module declares
   * a permission this viewer does not hold; and a repeated discriminator, which the
   * template's own cell key could not tell apart from the first.
   *
   * The persisted discriminator is a plain string on purpose - the wire contract
   * has to tolerate a value written by an older client - and the registry lookup is
   * what narrows it, so nothing is asserted or cast on this path.
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
   * The one place a layout write is scheduled from. The grid's change, resize, init
   * and remove callbacks all arrive here, and so do the canvas's own add and remove
   * paths; nothing outside this component can reach it.
   *
   * Reached from exactly one place: the `onLayoutChange` handler the grid
   * configuration is built with, which all four of the engine's change callbacks
   * forward to. No other method in this component calls it.
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

    this.layoutChange$.next();
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

    if (!this.settleItemPosition(item, aPosition)) {
      return;
    }

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
   * Returns the canvas to its pre-load state because a different viewer has
   * arrived.
   *
   * The order is the behaviour. Clearing readiness first means the grid is torn
   * down while nothing is reportable, so the item-removed callback each
   * destroyed cell fires is recognised as teardown rather than as the outgoing
   * viewer deleting their modules. Clearing the reported fingerprint last means
   * the incoming arrangement is compared against nothing rather than against
   * somebody else's.
   */
  private resetForViewerChange() {
    this.hasLayoutError = false;
    this.isInitialized = false;

    this.modules.length = 0;

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
