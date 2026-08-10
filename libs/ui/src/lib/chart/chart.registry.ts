import { getTooltipPositionerMapTop } from '@ghostfolio/common/chart-helper';

import { Chart, ChartType, Filler, Plugin, Tooltip } from 'chart.js';
import type { TooltipModel, TooltipPositionerFunction } from 'chart.js';
import 'chartjs-adapter-date-fns';
import annotationPlugin from 'chartjs-plugin-annotation';

interface VerticalHoverLinePluginOptions {
  color?: string;
  width?: number;
}

declare module 'chart.js' {
  interface PluginOptionsByType<TType extends ChartType> {
    verticalHoverLine: TType extends 'line' | 'bar'
      ? VerticalHoverLinePluginOptions
      : never;
  }
  interface TooltipPositionerMap {
    top: TooltipPositionerFunction<ChartType>;
  }
}

/**
 * The overflow values that clip a box, per axis.
 *
 * `clip` and `hidden` clip without scrolling; `auto` and `scroll` clip whatever
 * is outside the current scroll position. `visible` is the only value that does
 * not clip, and a box that declares it on one axis and a clipping value on the
 * other is coerced by CSS to `auto` on the first - so testing for the clipping
 * values rather than for `visible` needs no special case for that pair.
 */
const CLIPPING_OVERFLOW_VALUES = ['auto', 'clip', 'hidden', 'scroll'];

interface VisibleCanvasBox {
  bottom: number;
  isClipped: boolean;
  left: number;
  right: number;
  top: number;
}

/**
 * The part of a canvas that is actually on screen, in the canvas's own
 * coordinates.
 *
 * Walks the ancestors and intersects the canvas box with every one of them that
 * clips, per axis, then converts the result into canvas coordinates. `isClipped`
 * reports whether any ancestor removed anything at all, which is what lets the
 * caller leave a fully visible chart completely untouched.
 */
function getVisibleCanvasBox(aCanvas: HTMLCanvasElement): VisibleCanvasBox {
  const canvasBox = aCanvas.getBoundingClientRect();

  let bottom = canvasBox.bottom;
  let isClipped = false;
  let left = canvasBox.left;
  let right = canvasBox.right;
  let top = canvasBox.top;

  for (
    let ancestor = aCanvas.parentElement;
    ancestor;
    ancestor = ancestor.parentElement
  ) {
    const style = getComputedStyle(ancestor);

    const clipsHorizontally = CLIPPING_OVERFLOW_VALUES.includes(
      style.overflowX
    );
    const clipsVertically = CLIPPING_OVERFLOW_VALUES.includes(style.overflowY);

    if (!clipsHorizontally && !clipsVertically) {
      continue;
    }

    const ancestorBox = ancestor.getBoundingClientRect();

    if (clipsHorizontally) {
      if (ancestorBox.left > left) {
        left = ancestorBox.left;
        isClipped = true;
      }

      if (ancestorBox.right < right) {
        right = ancestorBox.right;
        isClipped = true;
      }
    }

    if (clipsVertically) {
      if (ancestorBox.top > top) {
        top = ancestorBox.top;
        isClipped = true;
      }

      if (ancestorBox.bottom < bottom) {
        bottom = ancestorBox.bottom;
        isClipped = true;
      }
    }
  }

  // Chart.js draws in CSS pixels - it applies the device pixel ratio to the
  // context rather than to its own coordinates - so the two spaces normally
  // differ only by their origin. The ratio is computed all the same, because a
  // transformed ancestor scales the measured box without changing what the chart
  // believes its size to be, and a zero-sized box would otherwise divide by zero.
  const horizontalRatio = canvasBox.width ? aCanvas.width / canvasBox.width : 1;
  const verticalRatio = canvasBox.height
    ? aCanvas.height / canvasBox.height
    : 1;

  return {
    bottom: (bottom - canvasBox.top) * verticalRatio,
    isClipped,
    left: (left - canvasBox.left) * horizontalRatio,
    right: (right - canvasBox.left) * horizontalRatio,
    top: (top - canvasBox.top) * verticalRatio
  };
}

/**
 * Moves a box of `aSize` so that it lies within `[aMinimum, aMaximum]`, keeping
 * it as close to `aPosition` as that allows.
 *
 * Where the span is narrower than the box there is nothing to choose, so the box
 * is pinned to the start of the span: showing its beginning is more useful than
 * showing its end, because a tooltip reads title-first.
 */
function clampToSpan(
  aPosition: number,
  aSize: number,
  aMinimum: number,
  aMaximum: number
) {
  if (aMaximum - aMinimum <= aSize) {
    return aMinimum;
  }

  return Math.min(Math.max(aPosition, aMinimum), aMaximum - aSize);
}

/**
 * Keeps a tooltip inside the visible part of its canvas.
 *
 * ## The defect this exists for
 *
 * Chart.js draws its tooltip onto the chart's own canvas, and positions it
 * relative to the hovered point within that canvas alone - it has no notion of
 * anything outside. On a single canvas of independently sized modules that is not
 * enough: every module body is a scrollport, so a chart is routinely taller than
 * the box it is drawn in, and the grid itself scrolls above that. Hovering a point
 * near the top of what is on screen therefore put the tooltip in the part of the
 * canvas that had been scrolled out of sight - measured at fully hidden, 64 of 64
 * pixel rows, with the crosshair still rendering. The viewer got the feedback that
 * their hover had registered and none of the data it was for.
 *
 * Chart.js's own `clip` handling does not address this. It confines drawing to the
 * canvas, which was never the boundary being crossed.
 *
 * ## How it works, and why it cannot change a chart that is fully visible
 *
 * `beforeTooltipDraw` runs immediately before `tooltip.draw()`, which reads `x`
 * and `y` afresh on every frame, so nudging them here moves the whole box -
 * background, title, body and footer alike - for exactly that frame, and is
 * re-applied on the next one. Nothing is cached and no state is kept, which is
 * also why this plugin needs no `start` hook and is safe to register at any time.
 *
 * The measurement short-circuits on `isClipped`: when no ancestor removes any part
 * of the canvas, the coordinates are left strictly alone rather than recomputed to
 * the same values. A chart that fits its module is therefore byte-identical to
 * what it drew before, which is what keeps this out of the way of the visual
 * comparison the chrome is held to.
 *
 * The caret is deliberately not moved with the box. Chart.js draws it on the edge
 * of the box at `caretX`, clamped to the box's own span, so a tooltip pushed down
 * away from its point keeps an arrow that still points back towards it.
 */
export const clippedTooltipPlugin: Plugin = {
  beforeTooltipDraw: (chart, { tooltip }) => {
    // Named rather than used through the destructured parameter, because every
    // reference below reads or writes a coordinate and the local makes the four of
    // them obviously the same object.
    const tooltipModel: TooltipModel<ChartType> = tooltip;

    if (!chart.canvas || !tooltipModel?.opacity) {
      return;
    }

    const visibleBox = getVisibleCanvasBox(chart.canvas);

    if (!visibleBox.isClipped) {
      return;
    }

    tooltipModel.x = clampToSpan(
      tooltipModel.x,
      tooltipModel.width,
      visibleBox.left,
      visibleBox.right
    );

    tooltipModel.y = clampToSpan(
      tooltipModel.y,
      tooltipModel.height,
      visibleBox.top,
      visibleBox.bottom
    );
  },
  id: 'gfClippedTooltip'
};

/**
 * Installs everything Chart.js keeps in module-global state: the plugins, the
 * date adapter and the custom tooltip positioner.
 *
 * Idempotent, so calling it from a component constructor stays harmless, but the
 * call is not what makes it safe - the invocation at the bottom of this file is.
 * Read {@link registerChartConfiguration} for why that distinction is the whole
 * point of this module.
 */
let isRegistered = false;

/**
 * Registers every piece of Chart.js state that is shared between charts, and
 * does so before any chart in the application can exist.
 *
 * ## Why this has to be a module-level side effect
 *
 * A Chart.js plugin is not a passive lookup entry. Each one is handed a `start`
 * hook when a chart is constructed and uses it to create that chart's slice of
 * the plugin's own state; every later hook - `beforeUpdate`, `beforeEvent`, the
 * animator's redraw - then reads that slice back. Chart.js only offers the hook
 * to plugins that are registered at the moment the chart is constructed.
 *
 * Registering a plugin from a component constructor therefore makes the global
 * registry depend on module load order, and this application draws its modules
 * onto one canvas as independently loaded chunks that arrive in a
 * non-deterministic order. A chart built from a chunk that arrived before the
 * plugin was registered never gets its `start` hook, so it has no state - and
 * the moment a later chunk registers that plugin, the earlier chart's next
 * update runs the plugin against state that was never created and throws,
 * abandoning the update mid-flight and leaving the canvas blank. Depending on
 * which hook wins the race the same defect surfaces as a failure to set
 * `annotations`, or to read `listened`, or to read `visibleElements`.
 *
 * Invoking this function at the bottom of this module removes the race rather
 * than narrowing it. Module evaluation always precedes the evaluation of any
 * module that imports it, and a lazily loaded chunk always waits for the chunks
 * it imports, so every chart-bearing component - in this chunk or any chunk
 * loaded afterwards - is defined only after this has run. No chart can be
 * constructed before the plugins are in place, in any load order.
 *
 * ## What belongs here, and what does not
 *
 * Only registry entries with per-chart lifecycle state: the plugins, and the
 * date adapter that a time scale captures when it is built. Controllers,
 * elements and scales are stateless lookups resolved at construction time, so
 * registering them late cannot corrupt an existing chart; each chart component
 * keeps declaring the ones it needs, which is also what keeps chart types it
 * does not use out of its bundle.
 *
 * Per-chart plugins passed through a chart's own `plugins` array are equally
 * unaffected, because they never touch this registry.
 */
export function registerChartConfiguration() {
  if (isRegistered) {
    return;
  }

  isRegistered = true;

  // `Filler` and `Tooltip` are plugins, not elements, and both keep per-chart
  // state - which is why they are registered here rather than alongside the
  // controllers and scales in the individual chart components.
  //
  // The tooltip-clamping plugin keeps no state of its own and so is not subject to
  // the load-order hazard above, but it is registered here all the same: it has to
  // apply to every chart in the application without each of them opting in, and
  // this is the one place that already runs before any chart can exist.
  Chart.register(annotationPlugin, clippedTooltipPlugin, Filler, Tooltip);

  Tooltip.positioners.top = function (_elements, eventPosition) {
    return getTooltipPositionerMapTop(this.chart, eventPosition);
  };
}

registerChartConfiguration();
