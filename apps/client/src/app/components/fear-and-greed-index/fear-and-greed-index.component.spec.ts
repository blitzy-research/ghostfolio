import { ComponentFixture, TestBed } from '@angular/core/testing';

import { GfFearAndGreedIndexComponent } from './fear-and-greed-index.component';

/**
 * Which of three things this tile says.
 *
 * The distinction it used to be unable to make is the whole point of these tests.
 * The skeleton was drawn whenever no index was present, so "the figure has not
 * arrived" and "the figure is not on offer" rendered identically - and a provider
 * that supplies no index answers with an empty object, which means the value never
 * arrives at all. The tile then pulsed a loading placeholder, indefinitely, over a
 * response it had already received: it claimed to be working while nothing was
 * outstanding.
 *
 * Only the host knows which case it is, so the answer arrives as an input. These
 * tests pin all three renderings, including the boundary that makes the check a
 * numeric one rather than a truthiness one: the index legitimately reaches zero.
 */
describe('GfFearAndGreedIndexComponent', () => {
  let component: GfFearAndGreedIndexComponent;
  let fixture: ComponentFixture<GfFearAndGreedIndexComponent>;

  /** The value row, which is hidden rather than removed. */
  const valueRow = (): HTMLElement => {
    return fixture.nativeElement.querySelector('.d-flex.flex-row');
  };

  const isValueRowVisible = (): boolean => {
    return valueRow()?.hidden === false;
  };

  const skeleton = (): HTMLElement => {
    return fixture.nativeElement.querySelector('ngx-skeleton-loader');
  };

  /**
   * The empty notice, matched as a direct child of the host wrapper. The value row
   * contains a `small.text-muted` of its own for the `/100` suffix, so a bare class
   * selector would find that one too and every assertion below would be reading the
   * wrong element.
   */
  const emptyNotice = (): HTMLElement => {
    return fixture.nativeElement.querySelector('div.position-relative > small');
  };

  const render = ({
    fearAndGreedIndex,
    isLoading
  }: {
    fearAndGreedIndex?: number;
    isLoading?: boolean;
  }) => {
    component.fearAndGreedIndex = fearAndGreedIndex;
    component.isLoading = isLoading ?? false;

    fixture.detectChanges();
  };

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [GfFearAndGreedIndexComponent]
    }).compileComponents();

    fixture = TestBed.createComponent(GfFearAndGreedIndexComponent);
    component = fixture.componentInstance;
  });

  it('shows the loading placeholder while the figure is outstanding', () => {
    render({ isLoading: true });

    expect(skeleton()).toBeTruthy();
    expect(emptyNotice()).toBeNull();
    expect(isValueRowVisible()).toBe(false);
  });

  it('says so when the figure arrived and there was none', () => {
    render({ isLoading: false });

    // The regression this component existed to produce: a provider with no index
    // answers, the value never arrives, and the tile used to go on pulsing.
    expect(skeleton()).toBeNull();
    expect(emptyNotice()?.textContent.trim()).toBe('No data available');
    expect(isValueRowVisible()).toBe(false);
  });

  it('draws the figure once it has arrived', () => {
    render({ fearAndGreedIndex: 62, isLoading: false });

    expect(skeleton()).toBeNull();
    expect(emptyNotice()).toBeNull();
    expect(isValueRowVisible()).toBe(true);
    expect(valueRow().textContent).toContain('62');
  });

  it('draws an index of zero rather than treating it as absent', () => {
    render({ fearAndGreedIndex: 0, isLoading: false });

    // Zero is the extreme-fear end of the scale and is a real reading, so the
    // presence test is numeric rather than truthy.
    expect(component.hasIndex).toBe(true);
    expect(emptyNotice()).toBeNull();
    expect(isValueRowVisible()).toBe(true);
  });

  it('prefers the loading placeholder while a figure is being replaced', () => {
    render({ fearAndGreedIndex: 62, isLoading: true });

    // A host that re-reads keeps the previous figure in hand; what the viewer is
    // told is that a new one is on its way, not that there is none.
    expect(skeleton()).toBeTruthy();
    expect(emptyNotice()).toBeNull();
  });

  it('defaults to the empty state rather than to an endless placeholder', () => {
    fixture.detectChanges();

    // A host that never binds the input gets an honest answer. The opposite
    // default would reintroduce the defect for exactly the callers most likely to
    // forget.
    expect(component.isLoading).toBe(false);
    expect(skeleton()).toBeNull();
    expect(emptyNotice()).toBeTruthy();
  });
});
