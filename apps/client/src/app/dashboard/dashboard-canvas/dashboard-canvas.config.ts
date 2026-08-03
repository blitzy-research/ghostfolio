import { CompactType, DisplayGrid, GridType } from 'angular-gridster2';
import type {
  Gridster,
  GridsterConfig,
  GridsterItemConfig
} from 'angular-gridster2';

/**
 * Grid-engine policy for the single-canvas dashboard.
 *
 * This module is the one and only declaration site for `angular-gridster2`
 * configuration, and it is deliberately kept out of
 * `GfDashboardCanvasComponent`. Separating it is what makes
 * `itemValidateCallback` - the hook through which a module's declared minimum
 * footprint is actually *enforced* - assertable as a pure function, with no
 * `TestBed`, no DOM and no dependency injection. Declaring these values inline
 * in the component would make that assertion impossible, so this file must
 * never be merged into it.
 *
 * The purity contract is part of the design and is intentionally narrow:
 *
 * - no Angular decorator, no injection, no DOM or other browser global;
 * - no registry lookup and no import of any module component, so the module
 *   registry remains the only way a module type can reach the canvas;
 * - no persistence. The change callbacks forward to a single handler owned by
 *   the canvas; debouncing, projection and the HTTP write all belong to
 *   `GfDashboardLayoutService`;
 * - no state. `createDashboardCanvasConfig` mints a fresh object on every
 *   call, because gridster mutates the configuration object it is handed (it
 *   writes `api`, `curWidth`, `curRowHeight` and more onto it), so a shared
 *   literal would leak state between component instances and between tests.
 */

/**
 * The canvas-owned behaviour that the grid engine calls back into.
 *
 * Passing these in - rather than exporting a ready-made configuration
 * constant - keeps every policy value frozen and centralised here while
 * leaving the canvas free to decide what an interaction *means*.
 */
export interface DashboardCanvasConfigHandlers {
  /**
   * Invoked when something is dropped onto an empty cell.
   *
   * Both arguments are forwarded untouched, because decoding the payload is
   * the canvas's job. The payload contract is frozen:
   * `GfModuleCatalogItemComponent` writes the raw kebab-case module type under
   * the `'text/plain'` key of `event.dataTransfer` - no JSON, no wrapper
   * object, no prefix and no custom MIME type - so the canvas reads it back
   * with `event.dataTransfer?.getData('text/plain')`. `item` arrives already
   * positioned at the cell the pointer released over.
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
   * Signals that the grid mutated and the layout should be persisted.
   *
   * Intentionally argument-free: every trigger reports the same fact - the
   * layout changed - and the grid item array the canvas already owns is the
   * single source of truth for what it changed to.
   */
  onLayoutChange: () => void;
}

/**
 * Rejects any placement whose footprint is smaller than the minimum its module
 * declared in the registry.
 *
 * Gridster consults this predicate before committing a resize and before
 * admitting a drop, which is what turns a declared minimum into an enforced
 * one: returning `false` genuinely *rejects* the configuration instead of
 * merely reporting it. The global floors in `createDashboardCanvasConfig`
 * (`minItemCols: 2`, `minItemRows: 2`, `minItemArea: 4`) keep the engine
 * itself from going below 2x2, while this predicate additionally honours the
 * stricter per-item minimums the canvas copies onto each item from its
 * registry definition.
 *
 * HAZARD - `minItemCols` and `minItemRows` are optional on
 * `GridsterItemConfig`, and `4 >= undefined` evaluates to `false`, not `true`.
 * An item whose per-item minimums were never populated therefore has *every*
 * placement rejected and can be neither moved nor resized. No fallback is
 * applied here on purpose: quietly substituting a default would mask the bug
 * and dilute the very rule this predicate exists to enforce. Populating
 * `minItemCols` and `minItemRows` from the registry definition is the canvas's
 * contractual obligation, and it owes it on all three paths that mint an item
 * - hydrating a persisted layout, catalog click-to-add and catalog
 * drag-to-drop.
 *
 * Exported independently of the configuration factory so it can be asserted
 * directly, with no fixture and no rendering.
 *
 * @example
 * const item = { minItemCols: 2, minItemRows: 2, rows: 4, x: 0, y: 0 };
 *
 * itemValidateCallback({ ...item, cols: 2 }); // true, exactly at the floor
 * itemValidateCallback({ ...item, cols: 1 }); // false, one column too narrow
 */
export const itemValidateCallback = (item: GridsterItemConfig): boolean =>
  item.cols >= item.minItemCols && item.rows >= item.minItemRows;

/**
 * Builds the `GridsterConfig` for the dashboard canvas.
 *
 * Returns a new object on every call. That is not defensive style: gridster
 * writes runtime bookkeeping straight onto the configuration it receives, so
 * sharing one literal across canvas instances - or across specs - would leak
 * that bookkeeping.
 *
 * @param handlers canvas-owned callbacks; see
 * {@link DashboardCanvasConfigHandlers}.
 */
export function createDashboardCanvasConfig(
  handlers: DashboardCanvasConfigHandlers
): GridsterConfig {
  return {
    // The user's placement is authoritative. Never auto-compact a module into
    // a gap the user deliberately left open.
    compactType: CompactType.None,
    // Comfortable starting footprint for a newly added module, well above the
    // 2x2 floor so it is immediately readable.
    defaultItemCols: 4,
    defaultItemRows: 4,
    // Grid lines are guide-rails, so they surface only while the user is
    // actually dragging or resizing.
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
    // A constant pixel row height, so a two-row module is a predictable size
    // rather than a fraction of the viewport.
    fixedRowHeight: 80,
    // Fixed row height with vertical scrolling; the canvas grows downwards
    // instead of squeezing rows to fit.
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
    // Their `(item, itemComponent)` arguments are deliberately undeclared:
    // this file reports that the layout changed, never what it changed to.
    itemChangeCallback: () => handlers.onLayoutChange(),
    itemInitCallback: () => handlers.onLayoutChange(),
    itemRemovedCallback: () => handlers.onLayoutChange(),
    itemResizeCallback: () => handlers.onLayoutChange(),
    itemValidateCallback,
    margin: 10,
    // Locks the grid to exactly twelve columns: identical minimum and maximum
    // means the column count never varies with the viewport.
    maxCols: 12,
    // Generous vertical ceiling; combined with `minRows` the canvas is free to
    // grow as modules are added.
    maxRows: 100,
    minCols: 12,
    // 2x2 is the smallest usable module footprint. `minItemArea` additionally
    // rules out the degenerate 1x4 and 4x1 shapes, which would each satisfy
    // one dimension floor while being unusable.
    minItemArea: 4,
    minItemCols: 2,
    minItemRows: 2,
    minRows: 1,
    // Permanently disables gridster's mobile stacking path, which is the
    // technical enforcement of the "no mobile or responsive layout" exclusion.
    // The library enters mobile mode only while `mobileBreakpoint > curWidth`,
    // and no viewport is narrower than zero. There is no CSS substitute for
    // this, and no media query belongs in the dashboard stylesheets.
    mobileBreakpoint: 0,
    outerMargin: true,
    // Never displace a module the user did not touch; collisions are resolved
    // by swapping instead.
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
    // A module added below the fold scrolls itself into view, so the canvas
    // never appears to have swallowed it.
    scrollToNewItems: true,
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
