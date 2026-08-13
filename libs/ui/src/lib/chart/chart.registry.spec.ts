import { Chart } from 'chart.js';

import { clippedTooltipPlugin } from './chart.registry';

/**
 * Keeping a chart tooltip inside the part of its canvas that is on screen.
 *
 * Chart.js draws its tooltip onto the chart's own canvas and positions it relative
 * to the hovered point within that canvas alone. On a canvas of independently sized
 * modules that is not enough: every module body is a scrollport, so a chart is
 * routinely taller than the box it is drawn in, and the grid scrolls above that.
 * Hovering a point near the top of what was visible therefore drew the tooltip into
 * the part of the canvas that had been scrolled out of sight - measured at fully
 * hidden, 64 of 64 pixel rows, with the crosshair still rendering. The viewer was
 * told their hover had registered and shown none of the data it was for.
 *
 * These tests drive the plugin hook directly with measured boxes rather than
 * through a real chart. A rendered chart in this environment has a zero-sized canvas
 * and no layout at all, so every rect would be empty and the clamp would have
 * nothing to act on; the arithmetic is the whole of the behaviour, and it is
 * asserted against the geometry the browser reports.
 */
describe('clippedTooltipPlugin', () => {
  /**
   * The hook, resolved once and narrowed here.
   *
   * Every member of Chart.js's `Plugin` interface is optional, so an absent
   * `beforeTooltipDraw` is a type-level possibility. It is worth failing over rather
   * than asserting away: a plugin that had lost its hook would otherwise satisfy
   * every clamp assertion below, because a tooltip nobody clamped would keep the
   * coordinates the test gave it, and several of those tests expect exactly that.
   */
  const beforeTooltipDraw = clippedTooltipPlugin.beforeTooltipDraw;

  if (!beforeTooltipDraw) {
    throw new Error('clippedTooltipPlugin must implement beforeTooltipDraw');
  }

  /** A tooltip model carrying only what the hook reads and writes. */
  const createTooltip = ({
    height = 64,
    opacity = 1,
    width = 120,
    x = 0,
    y = 0
  }: {
    height?: number;
    opacity?: number;
    width?: number;
    x?: number;
    y?: number;
  } = {}) => {
    return { height, opacity, width, x, y };
  };

  /**
   * A canvas whose ancestors clip it to `visible`, in viewport coordinates.
   *
   * Built out of real elements so that the walk up the tree, the computed-style
   * test and the rect intersection are all exercised: only `getBoundingClientRect`
   * is stood in, because this environment lays nothing out and would report every
   * box as empty.
   */
  const createClippedCanvas = ({
    canvasBox,
    overflow = 'auto',
    visibleBox
  }: {
    canvasBox: { height: number; left: number; top: number; width: number };
    overflow?: string;
    visibleBox?: { height: number; left: number; top: number; width: number };
  }) => {
    const scrollport = document.createElement('div');
    const canvas = document.createElement('canvas');

    // Both longhands, not the shorthand: the plugin reads `overflowX` and
    // `overflowY` off the computed style, and this environment's `getComputedStyle`
    // does not expand `overflow` into them - a real browser always does. Setting
    // them directly drives the code through the same members the browser gives it.
    scrollport.style.overflowX = overflow;
    scrollport.style.overflowY = overflow;
    scrollport.appendChild(canvas);
    document.body.appendChild(scrollport);

    canvas.height = canvasBox.height;
    canvas.width = canvasBox.width;

    const asRect = (box: {
      height: number;
      left: number;
      top: number;
      width: number;
    }) => {
      return {
        bottom: box.top + box.height,
        height: box.height,
        left: box.left,
        right: box.left + box.width,
        toJSON: () => ({}),
        top: box.top,
        width: box.width,
        x: box.left,
        y: box.top
      } as DOMRect;
    };

    canvas.getBoundingClientRect = () => asRect(canvasBox);
    scrollport.getBoundingClientRect = () => asRect(visibleBox ?? canvasBox);

    return { canvas, scrollport };
  };

  const draw = (
    canvas: HTMLCanvasElement,
    tooltip: ReturnType<typeof createTooltip>
  ) => {
    beforeTooltipDraw(
      { canvas } as unknown as Chart,
      { cancelable: true, tooltip } as never,
      {}
    );

    return tooltip;
  };

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('is registered for every chart in the application', () => {
    // Registered globally rather than per chart, because the defect is a property
    // of where charts are drawn rather than of any one of them, and a chart that
    // forgot to opt in would be the one that clipped.
    expect(Chart.registry.plugins.get('gfClippedTooltip')).toBe(
      clippedTooltipPlugin
    );
  });

  it('leaves a fully visible chart exactly as it was', () => {
    // The measurement short-circuits when nothing clips the canvas, so a chart that
    // fits its module draws byte-identically to what it drew before this existed.
    const { canvas } = createClippedCanvas({
      canvasBox: { height: 300, left: 0, top: 0, width: 400 }
    });

    const tooltip = draw(canvas, createTooltip({ x: 10, y: 12 }));

    expect(tooltip.x).toBe(10);
    expect(tooltip.y).toBe(12);
  });

  it('pushes a tooltip down out of the region scrolled off the top', () => {
    // The measured defect: the canvas begins 200px above the visible band and the
    // tooltip is drawn at the canvas's own origin, so all 64 of its rows are hidden.
    const { canvas } = createClippedCanvas({
      canvasBox: { height: 600, left: 0, top: -200, width: 400 },
      visibleBox: { height: 400, left: 0, top: 0, width: 400 }
    });

    const tooltip = draw(canvas, createTooltip({ height: 64, x: 0, y: 0 }));

    // 200 is where the visible band starts in the canvas's own coordinates.
    expect(tooltip.y).toBe(200);
    expect(tooltip.x).toBe(0);
  });

  it('pulls a tooltip up so its bottom edge stays visible', () => {
    const { canvas } = createClippedCanvas({
      canvasBox: { height: 600, left: 0, top: 0, width: 400 },
      visibleBox: { height: 300, left: 0, top: 0, width: 400 }
    });

    const tooltip = draw(canvas, createTooltip({ height: 64, y: 280 }));

    // The band ends at 300, so a 64-tall box has to start at 236 to end there.
    expect(tooltip.y).toBe(236);
  });

  it('clamps horizontally on the same terms', () => {
    const { canvas } = createClippedCanvas({
      canvasBox: { height: 300, left: -150, top: 0, width: 800 },
      visibleBox: { height: 300, left: 0, top: 0, width: 400 }
    });

    const tooltip = draw(canvas, createTooltip({ width: 120, x: 0 }));

    expect(tooltip.x).toBe(150);
  });

  it('pins a tooltip taller than the visible band to the top of it', () => {
    // Nothing to choose here, so the beginning is shown: a tooltip reads title
    // first, and its title is the answer to what was hovered.
    const { canvas } = createClippedCanvas({
      canvasBox: { height: 600, left: 0, top: -100, width: 400 },
      visibleBox: { height: 40, left: 0, top: 0, width: 400 }
    });

    const tooltip = draw(canvas, createTooltip({ height: 64, y: 0 }));

    expect(tooltip.y).toBe(100);
  });

  it('respects an ancestor that clips without scrolling', () => {
    // `overflow: hidden` clips just as firmly as a scrollport, and the grid gives
    // every cell exactly that - so a module partly outside its own cell is the same
    // problem arriving by a different route.
    const { canvas } = createClippedCanvas({
      canvasBox: { height: 600, left: 0, top: -200, width: 400 },
      overflow: 'hidden',
      visibleBox: { height: 400, left: 0, top: 0, width: 400 }
    });

    expect(draw(canvas, createTooltip({ height: 64, y: 0 })).y).toBe(200);
  });

  it('ignores an ancestor that clips nothing', () => {
    const { canvas } = createClippedCanvas({
      canvasBox: { height: 600, left: 0, top: -200, width: 400 },
      overflow: 'visible',
      visibleBox: { height: 400, left: 0, top: 0, width: 400 }
    });

    expect(draw(canvas, createTooltip({ height: 64, y: 0 })).y).toBe(0);
  });

  it('does nothing while no tooltip is showing', () => {
    // `opacity` is how Chart.js reports a tooltip that is fading out or absent, and
    // its coordinates are meaningless then. Measuring anyway would cost a forced
    // layout on every frame of every chart for no effect.
    const { canvas } = createClippedCanvas({
      canvasBox: { height: 600, left: 0, top: -200, width: 400 },
      visibleBox: { height: 400, left: 0, top: 0, width: 400 }
    });

    const tooltip = draw(canvas, createTooltip({ opacity: 0, y: 0 }));

    expect(tooltip.y).toBe(0);
  });

  it('does nothing for a chart with no canvas', () => {
    const tooltip = createTooltip({ y: 0 });

    expect(() =>
      beforeTooltipDraw(
        {} as unknown as Chart,
        { cancelable: true, tooltip } as never,
        {}
      )
    ).not.toThrow();

    expect(tooltip.y).toBe(0);
  });
});
