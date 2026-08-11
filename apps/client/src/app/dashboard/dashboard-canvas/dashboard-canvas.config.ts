import { CompactType, DisplayGrid, GridType } from 'angular-gridster2';
import type {
  Gridster,
  GridsterConfig,
  GridsterItem,
  GridsterItemConfig
} from 'angular-gridster2';

export interface DashboardCanvasConfigHandlers {
  /**
   * ⚠ `item` is the library's OWN drop candidate, not the item that will be
   * added. `getValidItemFromEvent` mints it as `{ x, y, cols: defaultItemCols,
   * rows: defaultItemRows }` and screens *that*, because the library has no way
   * of knowing which module is on the pointer. Only its `x` and `y` are
   * meaningful: the module's real footprint comes from the registry and is
   * frequently larger, so the canvas mints and screens the definition-sized
   * item itself before admitting it.
   */
  onEmptyCellDrop: (event: DragEvent, item: GridsterItemConfig) => void;

  /**
   * The counterpart of {@link onGridsterInit}, and it exists because the canvas
   * OUTLIVES the grid: every canvas state that draws no grid destroys the
   * `gridster` child while the canvas itself carries on. The instance is
   * forwarded so the canvas can compare it against the one it holds - a rebuild
   * destroys the outgoing grid AFTER initialising the incoming one, so clearing
   * unconditionally would discard the live instance.
   *
   * Carries no write and is not a persistence trigger; the engine reports each
   * destroyed cell separately through `itemRemovedCallback`.
   */
  onGridsterDestroy: (gridster: Gridster) => void;

  // The instance itself, not `options.api`: only the instance's
  // `getNextPossiblePosition` returns a `boolean` reporting whether a free slot
  // was found, which is what click-to-add depends on.
  onGridsterInit: (gridster: Gridster) => void;

  // How the canvas learns that a module it has just placed finally has an
  // element. Every first paint reaches it, hydration included, so the canvas
  // decides which one it was waiting for - the engine cannot tell a module the
  // viewer just added from one that was restored. Not a persistence trigger.
  onItemInit: (item: GridsterItemConfig) => void;

  /**
   * One module's geometry settled, whatever settled it.
   *
   * Carries the item purely so the canvas can SAY which module changed - a pointer
   * drag was otherwise announced to nobody, and the live region went on reporting
   * a position the module no longer held. It carries no write and no geometry
   * decision: the canvas reads the item, never assigns to it, and the persistence
   * trigger for the very same event is the argument-free callback below.
   *
   * Deliberately fed from `itemChangeCallback` alone. `itemResizeCallback` fires
   * from the engine's own size computation whenever an item's PIXEL box changes,
   * which includes every recalculation the grid does for its own reasons, so
   * announcing from there would talk over the viewer without a geometry having
   * changed at all.
   */
  onItemGeometryChange: (item: GridsterItemConfig) => void;

  // Intentionally argument-free: every trigger reports the same fact, and the
  // grid item array the canvas owns is the single source of truth for what
  // changed.
  onLayoutChange: () => void;

  /**
   * The end of a pointer resize gesture, however it ended. The engine calls its
   * `stop` hook from one place that every ending funnels through - mouseup,
   * mouseleave, touchend, touchcancel and a window blur alike, and for an
   * abandoned gesture as much as a completed one - which is what makes it the
   * only safe place to undo anything {@link onResizeGestureStart} set up.
   *
   * Carries no write and is not a persistence trigger: a resize that actually
   * changed the arrangement is reported separately through
   * `itemResizeCallback`.
   */
  onResizeGestureEnd: (itemComponent: GridsterItem) => void;

  /**
   * The start of a pointer resize gesture, forwarded with the component whose
   * cell is being resized so the canvas can hold that module's content box
   * still for the duration of it.
   *
   * The engine writes the cell's `width` and `height` on every pointer move, so
   * without this the module inside re-lays-out on every move as well - which for
   * a module holding a chart or a table means its own resize observers, and its
   * charting library's re-render, run tens of times per gesture and the content
   * is visibly broken at the intermediate sizes it is asked to fit. The cell
   * itself still tracks the pointer frame-synchronously; only the content inside
   * it waits, and it reflows exactly once, on release.
   *
   * Carries no write either, for the same reason as its counterpart.
   */
  onResizeGestureStart: (itemComponent: GridsterItem) => void;
}

/**
 * The class the module host puts on the region that holds a module, handed to
 * the engine as its `ignoreContentClass` so a press inside a module never starts
 * a drag.
 *
 * Exported because the canvas has to find that same region to hold it still
 * during a resize, and because the global `styles/gridster.scss` paints its
 * focus ring - three files that must name the one element, so the name is
 * declared once. The module host's template carries the literal, which a
 * template cannot avoid, and says so where it does.
 */
export const MODULE_CONTENT_CLASS = 'gridster-item-content';

// The grid-wide floor, handed to the engine as its `minItemCols` /
// `minItemRows` policy and squared into `minItemArea` so degenerate shapes that
// satisfy one dimension while failing the other are ruled out too. It is a
// floor and nothing more: {@link itemValidateCallback} measures every placement
// against the minimum its own module declared, which may be stricter and never
// looser.
const MINIMUM_ITEM_COLS = 2;

const MINIMUM_ITEM_ROWS = 2;

// Exported because the canvas needs the same two numbers to fit a *stored*
// geometry back inside the grid as it hydrates, and reading them from here is
// what stops that normalization and the engine's own
// `minCols`/`maxCols`/`maxRows`/`maxItemCols`/`maxItemRows` from ever describing
// different grids. The per-item pair belongs in that list and not just the
// grid-wide pair: the engine tests a footprint against the per-item ceilings
// alone, so leaving those to the library's own defaults is precisely how the two
// layers came to disagree.
export const GRID_COLUMNS = 12;

export const GRID_ROWS = 100;

// The `defaultItemCols` / `defaultItemRows` this configuration ships, named
// here because the canvas raises them to the dragged module's registered
// footprint for the duration of a catalog drag and has to restore exactly these
// afterwards. They are a fallback rather than a policy: every item the canvas
// mints carries an explicit `cols` and `rows` from the registry, so the engine
// reads these only for its own preview and for the degenerate cases it handles
// internally.
export const DEFAULT_DROP_PREVIEW_COLS = 4;

export const DEFAULT_DROP_PREVIEW_ROWS = 4;

/**
 * Rejects any placement whose footprint is smaller than the minimum its module
 * declared in the registry.
 *
 * Gridster consults this predicate before committing a resize and before
 * admitting an item onto the grid, which is what turns a declared minimum into
 * an enforced one: returning `false` genuinely rejects the configuration rather
 * than merely reporting it. The grid-wide floors are enforced separately by the
 * library's own `checkGridCollision`, so this predicate is about one thing
 * only.
 *
 * The grid-wide floor stands in when an item declares none, which is not a
 * loosening - it is exactly what the engine does one line later in
 * `checkGridCollision`. The one candidate that cannot present a contract is the
 * library's own drag-over candidate, minted with no per-item minimums;
 * rejecting it would tell the browser `dropEffect = 'none'` and leave
 * drag-to-add silently dead with `enableEmptyCellDrop` switched on and
 * unreachable. Admitting that candidate does not admit a module: the canvas
 * screens the real item, at its own size and with its own minimums attached,
 * before appending it.
 *
 * Exported independently of the configuration factory so it can be asserted
 * directly, with no fixture and no rendering.
 */
export const itemValidateCallback = (item: GridsterItemConfig): boolean =>
  item.cols >= (item.minItemCols ?? MINIMUM_ITEM_COLS) &&
  item.rows >= (item.minItemRows ?? MINIMUM_ITEM_ROWS);

/**
 * Builds the `GridsterConfig` for the dashboard canvas - the one declaration
 * site for grid policy, kept out of `GfDashboardCanvasComponent` so {@link
 * itemValidateCallback} stays assertable as a pure function with no `TestBed`,
 * DOM or injection.
 *
 * Returns a new object on every call, because gridster writes runtime
 * bookkeeping straight onto the configuration it receives and sharing one
 * literal across canvas instances would leak that bookkeeping.
 */
export function createDashboardCanvasConfig(
  handlers: DashboardCanvasConfigHandlers
): GridsterConfig {
  return {
    compactType: CompactType.None,

    // Read from the shared constants so that the value the canvas restores
    // after a catalog drag and the value shipped here can never disagree.
    defaultItemCols: DEFAULT_DROP_PREVIEW_COLS,
    defaultItemRows: DEFAULT_DROP_PREVIEW_ROWS,

    destroyCallback: (gridster: Gridster) =>
      handlers.onGridsterDestroy(gridster),
    displayGrid: DisplayGrid.OnDragAndResize,
    draggable: {
      // Frozen contract with `gf-dashboard-module-host`, whose handle element
      // carries this class, and with the global `styles/gridster.scss`, which
      // paints it. Renaming it here silently disables dragging.
      dragHandleClass: 'gf-dashboard-module-drag-handle',
      enabled: true,

      // A drag may start from the handle alone, so inputs, tables, menus and
      // charts inside a module stay usable. The module host renders the lazily
      // loaded component inside `.gridster-item-content` for exactly this
      // reason.
      ignoreContent: true,
      ignoreContentClass: MODULE_CONTENT_CLASS
    },
    emptyCellDropCallback: (event: DragEvent, item: GridsterItemConfig) =>
      handlers.onEmptyCellDrop(event, item),

    // Required for the catalog's native HTML5 drag-to-add path. Angular CDK
    // drag and drop would never reach it, because gridster listens for the
    // browser's own `dragover` and `drop` events. Reaching it also depends on
    // {@link itemValidateCallback} admitting the library's own drag-over
    // candidate.
    enableEmptyCellDrop: true,

    // A constant pixel row height, so a two-row module is a predictable size
    // rather than a fraction of the viewport.
    fixedRowHeight: 80,
    gridType: GridType.VerticalFixed,

    // Forward the `Gridster` component instance, never `options.api`: the
    // instance's `getNextPossiblePosition` returns `boolean`, whereas the
    // identically named member of the `GridsterApi` surface returns `void`.
    // Gridster also passes a second `gridsterApi` argument, left undeclared
    // because `noUnusedParameters` makes an unused parameter a build error.
    initCallback: (gridster: Gridster) => handlers.onGridsterInit(gridster),

    // The four callbacks below are the complete and exclusive set of layout
    // persistence triggers - drag, resize, add and remove - and they all feed
    // the same handler. There is no per-event handler, no per-event subject and
    // no fifth trigger, so no module component can reach a save path. Their
    // `(item, itemComponent)` arguments are undeclared because this file
    // reports that the layout changed, never what it changed to.
    // `itemInitCallback` additionally forwards the item to `onItemInit`,
    // because both obligations belong to the same moment and the engine offers
    // no second hook. That forward carries no write.
    itemChangeCallback: (item: GridsterItemConfig) => {
      handlers.onLayoutChange();
      handlers.onItemGeometryChange(item);
    },
    itemInitCallback: (item: GridsterItemConfig) => {
      handlers.onLayoutChange();
      handlers.onItemInit(item);
    },
    itemRemovedCallback: () => handlers.onLayoutChange(),
    itemResizeCallback: () => handlers.onLayoutChange(),
    itemValidateCallback,
    margin: 10,
    maxCols: GRID_COLUMNS,

    // The per-item ceilings, and they have to be stated rather than left to the
    // library, which defaults both to 50. `maxCols`/`maxRows` bound the grid;
    // these bound one module inside it, and `checkGridCollision` reads only
    // these two when it decides whether a footprint may be placed at all. Omit
    // them and the grid says a module may be 100 rows tall while the engine
    // quietly refuses anything past 50: a taller stored module is admitted by
    // the server, hydrated by the canvas, then marked `notPlaced` and painted
    // `display: none`, so the module vanishes with no notice and no way for a
    // viewer to recover it. Deriving them from the same two constants is what
    // makes the ceiling a viewer can reach the ceiling the server already
    // advertises - its own validator message names the `12 x 100` grid - so the
    // engine, the hydration clamp and the DTO all describe one grid.
    maxItemCols: GRID_COLUMNS,
    maxItemRows: GRID_ROWS,
    maxRows: GRID_ROWS,
    minCols: GRID_COLUMNS,

    // Derived from the column and row floors so it can never contradict them;
    // on its own it excludes no shape they allow.
    minItemArea: MINIMUM_ITEM_COLS * MINIMUM_ITEM_ROWS,
    minItemCols: MINIMUM_ITEM_COLS,
    minItemRows: MINIMUM_ITEM_ROWS,
    minRows: 1,

    // Permanently disables gridster's mobile stacking path: the library enters
    // mobile mode only while `mobileBreakpoint > curWidth`, and no viewport is
    // narrower than zero. There is no CSS substitute, and no media query
    // belongs in the dashboard stylesheets.
    mobileBreakpoint: 0,
    outerMargin: true,
    pushItems: false,
    resizable: {
      enabled: true,

      // Bottom and right only, so a module always grows away from its origin
      // and its top-left corner stays put. The remaining five are stated
      // explicitly rather than omitted, because the library enables all eight
      // by default.
      handles: {
        e: true,
        n: false,
        ne: false,
        nw: false,
        s: true,
        se: true,
        sw: false,
        w: false
      },

      // The item the engine hands these is its own live geometry object rather
      // than the array entry, and neither hook has any business reading it - the
      // component is the only argument either one wants - so the first parameter
      // is named out of the way. `noUnusedParameters` tolerates the underscore,
      // and the engine's signature makes declaring it unavoidable.
      start: (_item: GridsterItemConfig, itemComponent: GridsterItem) =>
        handlers.onResizeGestureStart(itemComponent),
      stop: (_item: GridsterItemConfig, itemComponent: GridsterItem) =>
        handlers.onResizeGestureEnd(itemComponent)
    },

    // The engine applies this from the first size computation of every item -
    // the same place `itemInitCallback` fires - so it cannot itself tell a
    // module the viewer just added from one being restored. Which cells count
    // as new is therefore decided by the canvas, the only layer that knows; see
    // `applyNewItemReveal`.
    scrollToNewItems: true,

    // Dragging one module onto another exchanges their places, which keeps a
    // rearrangement local to the two modules involved.
    swap: true,

    // Position with CSS transforms so a drag stays on the compositor. Together
    // with the library's own `transition: 0s` while moving or resizing - which
    // must never be overridden - this is what keeps the interaction
    // frame-synchronous.
    useTransformPositioning: true
  };
}
