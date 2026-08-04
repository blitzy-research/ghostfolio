import { CompactType, DisplayGrid, GridType } from 'angular-gridster2';
import type {
  Gridster,
  GridsterConfig,
  GridsterItemConfig
} from 'angular-gridster2';

export interface DashboardCanvasConfigHandlers {
  /**
   * Invoked when something is dropped onto an empty cell.
   *
   * Both arguments are forwarded untouched, because decoding the payload is
   * the canvas's job. The payload contract is frozen:
   * `GfModuleCatalogItemComponent` writes the raw kebab-case module type under
   * the `'text/plain'` key of `event.dataTransfer` - no JSON, no wrapper
   * object, no prefix and no custom MIME type - so the canvas reads it back
   * with `event.dataTransfer?.getData('text/plain')`.
   *
   * ⚠ `item` is the library's OWN drop candidate, not the item that will be
   * added. `getValidItemFromEvent` mints it as
   * `{ x, y, cols: defaultItemCols, rows: defaultItemRows }` and screens *that*
   * with `checkCollision` before calling this back, because the library has no
   * way of knowing which module is on the pointer. Only its `x` and `y` are
   * meaningful to the canvas: the module's real footprint comes from the
   * registry and is frequently larger than the default - up to the full twelve
   * columns and ten rows - so the fact that a 4x4 preview fitted at that cell
   * implies nothing about the item that follows it.
   *
   * The canvas therefore mints the definition-sized item itself and screens
   * that item, at its own size, through the live `Gridster` instance before
   * admitting it. Adding an item on the strength of this candidate alone is how
   * one wider than the grid, or one lying across a neighbour, would reach the
   * authoritative array and then be persisted.
   */
  onEmptyCellDrop: (event: DragEvent, item: GridsterItemConfig) => void;

  /**
   * Receives the live `Gridster` component instance once the grid has
   * initialised.
   *
   * The canvas needs the instance itself, not `options.api`: only the
   * instance's `getNextPossiblePosition` returns a `boolean` reporting whether
   * a free slot was found, which is what click-to-add depends on.
   */
  onGridsterInit: (gridster: Gridster) => void;

  /**
   * Reports that the grid has drawn a cell for the first time.
   *
   * Purely presentational, and deliberately not a persistence trigger: it is
   * how the canvas learns that a module it has just placed finally has an
   * element, which is the earliest moment that module can be brought into
   * view. Every first paint reaches it, hydration included, so the canvas
   * decides which one it was waiting for - the engine cannot tell a module the
   * viewer just added from one that was restored.
   *
   * This exists because the library's own `scrollToNewItems` cannot make that
   * distinction either: it fires from the same place, on the first size
   * computation of *every* item, so switching it on would scroll a returning
   * viewer's canvas on load. The option is therefore left off and the reveal is
   * driven from here instead.
   */
  onItemInit: (item: GridsterItemConfig) => void;

  /**
   * Signals that the grid mutated and the layout should be persisted.
   *
   * Intentionally argument-free: every trigger reports the same fact - the
   * layout changed - and the grid item array the canvas already owns is the
   * single source of truth for what it changed to. The canvas compares that
   * array against the last arrangement it reported, so a trigger that carries no
   * actual change - and the grid fires several, once per cell during hydration
   * and again on every pixel reflow - costs nothing.
   */
  onLayoutChange: () => void;
}

/**
 * The grid-wide floor, below which no module may be sized however it was placed.
 *
 * Handed to the engine as its `minItemCols` / `minItemRows` policy, and squared
 * into `minItemArea` so that the degenerate shapes which satisfy one dimension
 * while failing the other are ruled out too. It is a floor and nothing more:
 * {@link itemValidateCallback} measures every placement against the minimum its
 * own module declared in the registry, which may be stricter and never looser.
 */
const MINIMUM_ITEM_COLS = 2;

const MINIMUM_ITEM_ROWS = 2;

/**
 * The canvas extent, in cells.
 *
 * Exported because it is grid policy, and this file is the one place grid policy
 * is declared. The canvas needs the same two numbers to fit a *stored* geometry
 * back inside the grid as it hydrates — a document written by an earlier build, or
 * by hand, can name a cell the grid no longer has — and reading them from here is
 * what stops that normalization and the engine's own `minCols`/`maxCols` and
 * `maxRows` from ever describing different grids.
 */
export const GRID_COLUMNS = 12;

export const GRID_ROWS = 100;

/**
 * Rejects any placement whose footprint is smaller than the minimum its module
 * declared in the registry.
 *
 * Gridster consults this predicate before committing a resize and before
 * admitting an item onto the grid, which is what turns a declared minimum into
 * an enforced one: returning `false` genuinely *rejects* the configuration
 * instead of merely reporting it. The global floors in
 * `createDashboardCanvasConfig` (`minItemCols: 2`, `minItemRows: 2`,
 * `minItemArea: 4`) are enforced separately by the library's own
 * `checkGridCollision`, so this predicate is free to be about one thing only:
 * the footprint the module itself declared.
 *
 * The comparison is deliberately strict: it reads `item.minItemCols` and
 * `item.minItemRows` directly and substitutes nothing for them. Both members are
 * optional on `GridsterItemConfig`, so an item that carries no minimum is
 * rejected outright - `4 >= undefined` is `false` - and that is the intended
 * answer rather than a gap. A candidate with no declared minimum is a candidate
 * whose registry contract is unknown, and admitting it on the grid's own floor
 * would let a module whose registry entry asks for more than 2x2 slip in below
 * what it declared. The canvas therefore copies the registry minimums onto every
 * item it mints, on all three paths that mint one - hydrating a saved
 * arrangement, catalog click-to-add and the item appended on drop - so a genuine
 * module always presents its own contract here.
 *
 * The one candidate that cannot present a contract is the library's, and it is
 * kept away from this predicate rather than accommodated by it. Inside
 * `getValidItemFromEvent` the library mints a drag-over candidate as exactly
 * `{ x, y, cols: defaultItemCols, rows: defaultItemRows }`, carrying no per-item
 * minimums because they are the application's to attach, and then screens it
 * with `checkCollision` - which consults this predicate first. That is why
 * `createDashboardCanvasConfig` sets `enableOccupiedCellDrop: true`: the library
 * guards that screen with `!$options.enableOccupiedCellDrop`, so enabling it
 * skips the screen entirely, `emptyCellDropCallback` stays reachable, and the
 * item the canvas appends in response - which does carry its minimums - is then
 * validated by this predicate through `addItem` in the ordinary way. See the
 * note on that option for why nothing is lost by skipping the screen.
 *
 * ⚠ Clearing that candidate is NOT what admits a module. It is the library's
 * preview, sized from `defaultItemCols` / `defaultItemRows`, and the item the
 * canvas actually adds carries the registry's declared footprint instead - which
 * may be as large as the full twelve columns and ten rows. The canvas therefore
 * screens the real item, at its own size and with its own minimums attached,
 * through `Gridster.checkCollision` before appending it, and relocates or
 * refuses it through `Gridster.getNextPossiblePosition` when the released cell
 * will not take it. This predicate is consulted on that pass too, so declared
 * minimums are enforced against the item that is really added and not only
 * against the shape that was previewed. See `settleItemPosition` in
 * `dashboard-canvas.component.ts`, and {@link
 * DashboardCanvasConfigHandlers.onEmptyCellDrop}.
 *
 * Exported independently of the configuration factory so it can be asserted
 * directly, with no fixture and no rendering.
 *
 * @example
 * const item = { minItemCols: 2, minItemRows: 2, rows: 4, x: 0, y: 0 };
 *
 * itemValidateCallback({ ...item, cols: 2 }); // true, exactly at the floor
 * itemValidateCallback({ ...item, cols: 1 }); // false, one column too narrow
 * itemValidateCallback({ cols: 4, rows: 4, x: 0, y: 0 }); // false, declares no
 * // minimum at all, so there is no contract to hold it to
 */
export const itemValidateCallback = (item: GridsterItemConfig): boolean =>
  item.cols >= item.minItemCols && item.rows >= item.minItemRows;

/**
 * Builds the `GridsterConfig` for the dashboard canvas — the one declaration site
 * for grid policy, kept out of `GfDashboardCanvasComponent` so
 * {@link itemValidateCallback} stays assertable as a pure function with no
 * `TestBed`, DOM or injection.
 *
 * Returns a new object on every call. That is not defensive style: gridster
 * writes runtime bookkeeping straight onto the configuration it receives, so
 * sharing one literal across canvas instances - or across specs - would leak
 * that bookkeeping.
 *
 * Nothing here injects, looks a module up or persists anything: the change
 * callbacks forward to one canvas-owned handler, and debouncing, projection and
 * the HTTP write all belong to `GfDashboardLayoutService`.
 *
 * @param handlers canvas-owned callbacks; see
 * {@link DashboardCanvasConfigHandlers}.
 */
export function createDashboardCanvasConfig(
  handlers: DashboardCanvasConfigHandlers
): GridsterConfig {
  return {
    compactType: CompactType.None,
    defaultItemCols: 4,
    defaultItemRows: 4,
    displayGrid: DisplayGrid.OnDragAndResize,
    draggable: {
      // Frozen contract with `gf-dashboard-module-host`, whose handle element
      // carries this class, and with the global `styles/gridster.scss`, which
      // paints it. Renaming it here silently disables dragging.
      dragHandleClass: 'gf-dashboard-module-drag-handle',
      enabled: true,
      // A drag may start from the handle alone, so inputs, tables, menus and
      // charts inside a module stay usable. The module host renders the
      // lazily loaded component inside `.gridster-item-content` for exactly
      // this reason.
      ignoreContent: true,
      ignoreContentClass: 'gridster-item-content'
    },
    emptyCellDropCallback: (event: DragEvent, item: GridsterItemConfig) =>
      handlers.onEmptyCellDrop(event, item),
    // Required for the catalog's native HTML5 drag-to-add path. Angular CDK
    // drag and drop would never reach it, because gridster listens for the
    // browser's own `dragover` and `drop` events.
    enableEmptyCellDrop: true,
    // Enabled so that the strict `itemValidateCallback` above stays strict.
    // `getValidItemFromEvent` screens its own drag-over candidate with
    // `if (!$options.enableOccupiedCellDrop && checkCollision(item))`, and that
    // candidate carries no per-item minimums, so the screen would reject it, the
    // browser would be told `dropEffect = 'none'`, and drag-to-add would be
    // unreachable in every browser. Enabling the option removes the screen from
    // the drop path instead of removing the strictness from the predicate.
    //
    // Nothing is lost by removing it, because it was never the authority. The
    // canvas responds to the drop by appending an item that does carry its
    // registry minimums, and `addItem` then puts that item through the full
    // `checkCollision` - this predicate, plus `checkGridCollision` for the grid
    // floor, the column bounds and `minItemArea`, plus `findItemWithItem` for
    // overlap - and auto-positions it if the cell released over is already taken.
    // So a drop onto an occupied cell now places the module in the nearest free
    // slot rather than being silently discarded, and a placement can still never
    // land below the minimum its module declared.
    enableOccupiedCellDrop: true,
    // A constant pixel row height, so a two-row module is a predictable size
    // rather than a fraction of the viewport.
    fixedRowHeight: 80,
    gridType: GridType.VerticalFixed,
    // Forward the `Gridster` component instance, never `options.api`: the
    // instance's `getNextPossiblePosition` returns `boolean`, whereas the
    // identically named member of the `GridsterApi` surface returns `void`.
    // Click-to-add needs that boolean to know whether a free slot exists, so
    // this must not be "simplified" to the api object. Gridster also passes a
    // second `gridsterApi` argument, left undeclared here because
    // `noUnusedParameters` makes an unused parameter a build error.
    initCallback: (gridster: Gridster) => handlers.onGridsterInit(gridster),
    // The four callbacks below are the complete and exclusive set of layout
    // persistence triggers - drag, resize, add and remove - and they all feed
    // the same handler. There is no per-event handler, no per-event subject
    // and no fifth trigger, so no module component can reach a save path.
    // Their `(item, itemComponent)` arguments are deliberately undeclared,
    // with one exception: this file reports that the layout changed, never
    // what it changed to.
    //
    // That exception is `itemInitCallback`, which additionally forwards the item
    // to `onItemInit`. Both obligations belong to the same moment and the engine
    // offers no second hook for it. The forward is NOT a fifth persistence
    // trigger - it carries no write - and the persistence handler it sits beside
    // is still invoked exactly as the other three invoke it.
    itemChangeCallback: () => handlers.onLayoutChange(),
    itemInitCallback: (item: GridsterItemConfig) => {
      handlers.onLayoutChange();
      handlers.onItemInit(item);
    },
    itemRemovedCallback: () => handlers.onLayoutChange(),
    itemResizeCallback: () => handlers.onLayoutChange(),
    itemValidateCallback,
    margin: 10,
    maxCols: GRID_COLUMNS,
    maxRows: GRID_ROWS,
    minCols: GRID_COLUMNS,
    // 2x2 is the smallest usable module footprint, and the column and row floors
    // below are what impose it. The area floor is derived from them so it can
    // never contradict them; on its own it excludes no shape they allow.
    minItemArea: MINIMUM_ITEM_COLS * MINIMUM_ITEM_ROWS,
    minItemCols: MINIMUM_ITEM_COLS,
    minItemRows: MINIMUM_ITEM_ROWS,
    minRows: 1,
    // Permanently disables gridster's mobile stacking path, which is the
    // technical enforcement of the "no mobile or responsive layout" exclusion.
    // The library enters mobile mode only while `mobileBreakpoint > curWidth`,
    // and no viewport is narrower than zero. There is no CSS substitute for
    // this, and no media query belongs in the dashboard stylesheets.
    mobileBreakpoint: 0,
    outerMargin: true,
    pushItems: false,
    resizable: {
      enabled: true,
      // Bottom and right only, so a module always grows away from its origin
      // and its top-left corner stays put. The remaining five handles are
      // stated explicitly rather than omitted, because the library enables all
      // eight by default.
      handles: {
        e: true,
        n: false,
        ne: false,
        nw: false,
        s: true,
        se: true,
        sw: false,
        w: false
      }
    },
    // Left OFF, and the canvas reveals a newly placed module itself through
    // `onItemInit` instead. The library applies this option from the first size
    // computation of every item - the same place `itemInitCallback` fires - so it
    // cannot tell a module the viewer just added from one being restored, and
    // switching it on would scroll a returning viewer's canvas as it loads. The
    // intent it expresses, that a module added below the fold is brought into
    // view rather than appearing to have been swallowed, is preserved exactly;
    // only the decision of *which* module that applies to moves to the canvas,
    // which is the only layer that knows.
    scrollToNewItems: false,
    // Dragging one module onto another exchanges their places, which keeps a
    // rearrangement local to the two modules involved.
    swap: true,
    // Position with CSS transforms so a drag stays on the compositor.
    // Together with the library's own `transition: 0s` while moving or
    // resizing - which must never be overridden - this is what keeps the
    // interaction frame-synchronous.
    useTransformPositioning: true
  };
}
