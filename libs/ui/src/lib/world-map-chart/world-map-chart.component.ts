import { getLocale, getNumberFormatGroup } from '@ghostfolio/common/helper';

import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  Input,
  NgZone,
  OnChanges,
  OnDestroy,
  inject
} from '@angular/core';
import { NgxSkeletonLoaderModule } from 'ngx-skeleton-loader';
import svgMap from 'svgmap';

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [NgxSkeletonLoaderModule],
  selector: 'gf-world-map-chart',
  styleUrls: ['./world-map-chart.component.scss'],
  templateUrl: './world-map-chart.component.html'
})
export class GfWorldMapChartComponent implements OnChanges, OnDestroy {
  @Input() countries: { [code: string]: { name?: string; value: number } };
  @Input() format: string;
  @Input() isInPercentage = false;
  @Input() locale = getLocale();

  public isLoading = true;
  public svgMapElement;

  private readonly zone = inject(NgZone);

  public constructor(private changeDetectorRef: ChangeDetectorRef) {
    // Registered for the lifetime of the component rather than per map, because a
    // map is torn down and rebuilt on every input change and the listener has
    // nothing to do with which map is current.
    //
    // On `document` in the CAPTURE phase, because a scroll on an element does not
    // bubble - it is dispatched at that element and reaches `document` only on the
    // way down - and the element that scrolls here belongs to the shell rather than
    // to this component: the map is drawn inside a module body that scrolls, inside
    // a canvas that scrolls as well. Neither is reachable from a library component,
    // and neither should have to be.
    //
    // Outside the Angular zone and passive, so a scroll costs a class test and
    // schedules no change detection. The handler paints nothing of its own: it
    // takes the map's own hide path, so the tooltip disappears exactly as it does
    // when the pointer leaves a country.
    this.zone.runOutsideAngular(() => {
      document.addEventListener('scroll', this.hideTooltipOnScroll, {
        capture: true,
        passive: true
      });
    });
  }

  public ngOnChanges() {
    // Create a copy before manipulating countries object
    this.countries = structuredClone(this.countries);

    if (this.countries) {
      this.isLoading = true;

      this.destroySvgMap();

      this.initialize();
    }
  }

  public ngOnDestroy() {
    document.removeEventListener('scroll', this.hideTooltipOnScroll, true);

    this.destroySvgMap();
  }

  private initialize() {
    if (this.isInPercentage) {
      // Convert value of countries to percentage
      let sum = 0;
      Object.keys(this.countries).map((country) => {
        sum += this.countries[country].value;
      });

      Object.keys(this.countries).map((country) => {
        this.countries[country].value = Number(
          ((this.countries[country].value * 100) / sum).toFixed(2)
        );
      });
    } else {
      // Convert value to fixed-point notation
      Object.keys(this.countries).map((country) => {
        this.countries[country].value = Number(
          this.countries[country].value.toFixed(2)
        );
      });
    }

    this.svgMapElement = new svgMap({
      colorMax: '#22bdb9',
      colorMin: '#c3f1f0',
      colorNoData: 'transparent',
      data: {
        applyData: 'value',
        data: {
          value: {
            format: this.format,
            thousandSeparator: getNumberFormatGroup(this.locale)
          }
        },
        values: this.countries
      },
      hideFlag: true,
      minZoom: 1.06,
      maxZoom: 1.06,
      targetElementID: 'svgMap'
    });

    setTimeout(() => {
      this.isLoading = false;

      this.changeDetectorRef.markForCheck();
    }, 500);
  }

  private destroySvgMap() {
    this.svgMapElement?.mapWrapper?.remove();
    this.svgMapElement?.tooltip?.remove();

    this.svgMapElement = null;
  }

  /**
   * Dismisses the tooltip when anything under the pointer scrolls.
   *
   * The tooltip is placed from the pointer's page coordinates at the moment a
   * country was entered, and the map library has no scroll handling of its own: it
   * hides on `pointerleave`, which a scroll does not produce. On a page that
   * scrolled as one document that was invisible, because the tooltip and the
   * country beneath it moved together. Inside a module body that scrolls
   * independently it is not: the map slides away and the tooltip stays behind,
   * naming a country that is no longer where it points - or no longer on screen.
   *
   * Dismissing rather than repositioning, and deliberately. A tooltip is a
   * transient answer to "what is this", and the honest response to the thing it was
   * about having moved is to stop answering; following the country would also mean
   * re-deriving a pointer position from a scroll event, which carries none.
   *
   * Declared as a bound property so that the same function object is passed to both
   * `addEventListener` and `removeEventListener` - a method reference would be a
   * new function on each access and would never be removed.
   */
  private readonly hideTooltipOnScroll = () => {
    // A narrow view of the library instance, which ships no types: the three
    // members this reads are named here so each use is checked rather than being an
    // unchecked call on an untyped value.
    const map = this.svgMapElement as
      | {
          hideTooltip: () => void;
          mapWrapper?: HTMLElement;
          tooltip?: HTMLElement;
        }
      | null
      | undefined;

    if (!map?.tooltip?.classList.contains('svgMap-active')) {
      return;
    }

    map.hideTooltip();

    // The library clears this alongside its own hide, and it is what keeps a
    // country drawn as hovered. Left behind, the map would still show a highlight
    // for a country the pointer is no longer anywhere near.
    map.mapWrapper
      ?.querySelectorAll('.svgMap-active')
      .forEach((element) => element.classList.remove('svgMap-active'));
  };
}
