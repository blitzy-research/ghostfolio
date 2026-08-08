import { getTooltipPositionerMapTop } from '@ghostfolio/common/chart-helper';

import { Chart, ChartType, Filler, Tooltip } from 'chart.js';
import type { TooltipPositionerFunction } from 'chart.js';
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
  Chart.register(annotationPlugin, Filler, Tooltip);

  Tooltip.positioners.top = function (_elements, eventPosition) {
    return getTooltipPositionerMapTop(this.chart, eventPosition);
  };
}

registerChartConfiguration();
