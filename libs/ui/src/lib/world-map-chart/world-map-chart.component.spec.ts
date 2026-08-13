import { ComponentFixture, TestBed } from '@angular/core/testing';

import { GfWorldMapChartComponent } from './world-map-chart.component';

/**
 * Stood in for the real map library, which builds an SVG world from a bundled
 * dataset and attaches pointer handlers across every country. None of that is what
 * these tests are about, and this environment lays nothing out for it to attach to.
 *
 * The stand-in keeps exactly the surface this component touches: a `mapWrapper`, a
 * `tooltip` element whose `svgMap-active` class is how the library records that a
 * tooltip is showing, and a `hideTooltip` that clears it. Recording the calls is
 * what lets the tests below assert that the component takes the library's OWN hide
 * path rather than reaching into the element itself.
 */
const svgMapInstances: {
  hideTooltip: jest.Mock;
  mapWrapper: HTMLElement;
  tooltip: HTMLElement;
}[] = [];

jest.mock('svgmap', () => {
  return {
    __esModule: true,
    default: class SvgMapStub {
      public readonly hideTooltip: jest.Mock;
      public readonly mapWrapper: HTMLElement;
      public readonly tooltip: HTMLElement;

      public constructor() {
        this.mapWrapper = document.createElement('div');
        this.tooltip = document.createElement('div');

        this.hideTooltip = jest.fn(() => {
          this.tooltip.classList.remove('svgMap-active');
        });

        svgMapInstances.push(this);
      }
    }
  };
});

describe('GfWorldMapChartComponent', () => {
  let fixture: ComponentFixture<GfWorldMapChartComponent>;

  /** The map the component most recently built. */
  const currentMap = () => {
    return svgMapInstances[svgMapInstances.length - 1];
  };

  /** Puts the map into the state it is in while a country is being hovered. */
  const showTooltip = () => {
    const map = currentMap();
    const country = document.createElement('path');

    country.classList.add('svgMap-country', 'svgMap-active');
    map.mapWrapper.appendChild(country);
    map.tooltip.classList.add('svgMap-active');

    return { country, map };
  };

  /**
   * Scrolls something above the map.
   *
   * Dispatched on an element other than the map and NOT bubbling, because that is
   * exactly what a scroll is: `scroll` on an element does not bubble, and the
   * element that scrolls here belongs to the shell - the module body the map is
   * drawn in, and the canvas above that. Only a capture-phase listener on the
   * document sees it, so a component that registered a bubbling one would pass
   * every other assertion here and do nothing in a browser.
   */
  const scrollAnAncestor = () => {
    document.body.dispatchEvent(
      new Event('scroll', { bubbles: false, cancelable: false })
    );
  };

  beforeEach(async () => {
    svgMapInstances.length = 0;

    await TestBed.configureTestingModule({
      imports: [GfWorldMapChartComponent]
    }).compileComponents();

    fixture = TestBed.createComponent(GfWorldMapChartComponent);

    fixture.componentRef.setInput('countries', {
      CH: { name: 'Switzerland', value: 2 },
      US: { name: 'United States', value: 8 }
    });

    fixture.detectChanges();
  });

  afterEach(() => {
    fixture.destroy();
  });

  it('builds a map for the countries it is given', () => {
    expect(svgMapInstances).toHaveLength(1);
  });

  it('dismisses a showing tooltip when anything above it scrolls', () => {
    const { country, map } = showTooltip();

    scrollAnAncestor();

    // Through the library's own hide, so the tooltip disappears exactly as it does
    // when the pointer leaves a country rather than by some second mechanism.
    expect(map.hideTooltip).toHaveBeenCalledTimes(1);
    expect(map.tooltip.classList.contains('svgMap-active')).toBe(false);

    // And the country stops being drawn as hovered, which the library clears
    // alongside its own hide. Left behind, the map would keep a highlight for a
    // country the pointer is nowhere near.
    expect(country.classList.contains('svgMap-active')).toBe(false);
  });

  it('does nothing when no tooltip is showing', () => {
    scrollAnAncestor();

    expect(currentMap().hideTooltip).not.toHaveBeenCalled();
  });

  it('stops listening once it is destroyed', () => {
    const { map } = showTooltip();

    fixture.destroy();

    scrollAnAncestor();

    // A listener on the document outlives the component that registered it, so
    // leaving one behind would keep reaching into a torn-down map for the rest of
    // the session.
    expect(map.hideTooltip).not.toHaveBeenCalled();
  });

  it('survives a scroll after the map has been torn down and not yet rebuilt', () => {
    showTooltip();

    (
      fixture.componentInstance as unknown as { destroySvgMap: () => void }
    ).destroySvgMap();

    expect(() => scrollAnAncestor()).not.toThrow();
  });
});
