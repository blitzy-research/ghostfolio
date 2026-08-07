import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideNoopAnimations } from '@angular/platform-browser/animations';

import { EntityLogoImageSourceService } from './entity-logo-image-source.service';
import { GfEntityLogoComponent } from './entity-logo.component';

/**
 * Asking once for a logo that does not exist.
 *
 * The behaviour under test is only visible across *instances*, which is why every
 * assertion here involves two of them. On a canvas holding both Holdings and
 * Activities, the two tables render one logo per row for the same twelve asset
 * profiles; the server answers 404 for each, because those profiles carry no
 * `url`; and before this component remembered that, the measured result was 24
 * requests and 24 console errors on every single load.
 *
 * The register is module-scoped and therefore shared by the whole suite, so each
 * test uses its own symbol. That is deliberate rather than incidental: resetting
 * it between tests would hide the very leak-across-instances property being
 * asserted, and distinct symbols keep the tests order-independent without it.
 *
 * Sharing that register is what the second half of these tests is about. Asking
 * once is only correct while every answer is filed against the address it actually
 * describes: an instance whose inputs move on mid-flight must hand its unanswered
 * address back rather than abandon it pending, must not let the browser's late
 * verdict on it be recorded against the address now wanted, and must show nothing
 * at all once nothing identifies a logo any more. Each of those three is a
 * cross-instance failure too - a wrong entry, or a missing one, is read by every
 * later instance for the rest of the session.
 */
describe('GfEntityLogoComponent', () => {
  const logoUrlFor = (symbol: string) => {
    return `../api/v1/logo/MANUAL/${symbol}`;
  };

  const createComponent = () => {
    const fixture: ComponentFixture<GfEntityLogoComponent> =
      TestBed.createComponent(GfEntityLogoComponent);

    return fixture;
  };

  const renderWith = (
    fixture: ComponentFixture<GfEntityLogoComponent>,
    symbol: string
  ) => {
    fixture.componentRef.setInput('dataSource', 'MANUAL');
    fixture.componentRef.setInput('symbol', symbol);

    fixture.detectChanges();
  };

  const imageOf = (fixture: ComponentFixture<GfEntityLogoComponent>) => {
    return fixture.nativeElement.querySelector('img') as HTMLImageElement;
  };

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [GfEntityLogoComponent],
      providers: [EntityLogoImageSourceService, provideNoopAnimations()]
    });
  });

  it('renders an image for a logo it has no reason to doubt', () => {
    const fixture = createComponent();

    renderWith(fixture, 'first-attempt');

    const image = imageOf(fixture);

    expect(image).not.toBeNull();
    expect(image.getAttribute('src')).toBe(logoUrlFor('first-attempt'));
  });

  it('removes the image once the address turns out to be empty', () => {
    const fixture = createComponent();

    renderWith(fixture, 'goes-missing');

    imageOf(fixture).dispatchEvent(new Event('error'));

    fixture.detectChanges();

    // Removed rather than hidden, so there is nothing left in the document for
    // assistive technology to reach.
    expect(imageOf(fixture)).toBeNull();
    expect(fixture.componentInstance.src).toBeUndefined();
  });

  it('does not ask a second time, from a second instance', () => {
    const first = createComponent();

    renderWith(first, 'shared-between-two-tables');

    imageOf(first).dispatchEvent(new Event('error'));

    first.detectChanges();

    const second = createComponent();

    renderWith(second, 'shared-between-two-tables');

    // No element means no request. This is the whole fix: the second table's row
    // for the same asset profile never reaches the network, so twelve duplicate
    // 404s per load - and every repeat of them for the rest of the session -
    // simply do not happen.
    expect(imageOf(second)).toBeNull();
    expect(second.componentInstance.src).toBeUndefined();
  });

  it('does not ask twice when both rows render before any answer arrives', () => {
    // The cold-load case, and the one an answer-only register could not fix.
    // Measured on the real canvas: the second table issued its twelve requests
    // 7-50ms BEFORE the first `<img>` error event fired, because that event
    // arrives 220-320ms after the 404 itself while the main thread is busy. So
    // here NEITHER instance has settled when the second one renders.
    const first = createComponent();

    renderWith(first, 'both-render-before-any-answer');

    expect(imageOf(first)).not.toBeNull();

    const second = createComponent();

    renderWith(second, 'both-render-before-any-answer');

    // Exactly one image exists across the two instances, so exactly one request
    // was made. The second waits on the first rather than repeating it.
    expect(imageOf(second)).toBeNull();

    imageOf(first).dispatchEvent(new Event('error'));

    first.detectChanges();
    second.detectChanges();

    // And once the answer is in, the waiter agrees with it.
    expect(imageOf(first)).toBeNull();
    expect(imageOf(second)).toBeNull();
  });

  it('gives a waiting row the logo when the probe succeeds', () => {
    const first = createComponent();

    renderWith(first, 'this-one-really-exists');

    const second = createComponent();

    renderWith(second, 'this-one-really-exists');

    expect(imageOf(second)).toBeNull();

    // Success has to be reported as loudly as failure. Reporting only failures
    // would leave every row after the first permanently blank for logos that do
    // exist - a silent regression on the common path, traded for a saved request
    // on the rare one.
    imageOf(first).dispatchEvent(new Event('load'));

    second.detectChanges();

    expect(imageOf(second)).not.toBeNull();
    expect(imageOf(second).getAttribute('src')).toBe(
      logoUrlFor('this-one-really-exists')
    );
  });

  it('lets a waiting row take over when the probing row disappears', () => {
    const first = createComponent();

    renderWith(first, 'probe-goes-away');

    const second = createComponent();

    renderWith(second, 'probe-goes-away');

    expect(imageOf(second)).toBeNull();

    // A module removed mid-flight must not strand everyone waiting on it. This is
    // the failure this test exists for, and it is worse than the duplicate
    // request it replaces: it is silent and it never resolves itself.
    first.destroy();

    second.detectChanges();

    expect(imageOf(second)).not.toBeNull();
    expect(imageOf(second).getAttribute('src')).toBe(
      logoUrlFor('probe-goes-away')
    );
  });

  it('still asks for a different logo after one has failed', () => {
    const failing = createComponent();

    renderWith(failing, 'this-one-is-empty');

    imageOf(failing).dispatchEvent(new Event('error'));

    failing.detectChanges();

    const other = createComponent();

    renderWith(other, 'this-one-is-fine');

    // The register holds addresses, not a blanket rule. Suppressing logos for a
    // whole data source would have been wrong: the server's 404 means the asset
    // profile has no `url`, which is a fact about that profile and not about
    // manually-added holdings in general.
    expect(imageOf(other)).not.toBeNull();
    expect(imageOf(other).getAttribute('src')).toBe(
      logoUrlFor('this-one-is-fine')
    );
  });

  it('hands an unanswered address back when its inputs move on', () => {
    const switching = createComponent();

    renderWith(switching, 'abandoned-mid-flight');

    expect(imageOf(switching)).not.toBeNull();

    // The row is recycled onto another asset profile - a table paging, sorting or
    // filtering - while the first answer is still in flight.
    renderWith(switching, 'asked-for-instead');

    const later = createComponent();

    renderWith(later, 'abandoned-mid-flight');

    // The abandoned address is probed afresh rather than waited on. Left pending
    // with nobody probing it, it would have blocked the logo for every later row
    // showing that asset profile, silently and for the rest of the session.
    expect(imageOf(later)).not.toBeNull();
    expect(imageOf(later).getAttribute('src')).toBe(
      logoUrlFor('abandoned-mid-flight')
    );
  });

  it('does not let a late answer settle the address it has moved on to', () => {
    const switching = createComponent();

    renderWith(switching, 'answers-too-late');

    const abandonedImage = imageOf(switching);

    renderWith(switching, 'wanted-now-instead');

    // Measured at 220-320ms after the 404 itself, so an address swapped in
    // between is the normal case rather than a race worth calling unlikely. The
    // element the browser answers for is the one it was loading.
    abandonedImage.dispatchEvent(new Event('error'));

    switching.detectChanges();

    expect(imageOf(switching)).not.toBeNull();
    expect(imageOf(switching).getAttribute('src')).toBe(
      logoUrlFor('wanted-now-instead')
    );

    const waiting = createComponent();

    renderWith(waiting, 'wanted-now-instead');

    expect(imageOf(waiting)).toBeNull();

    // The discriminating assertion. Had the late error been filed against the new
    // address, that address would already be settled as empty, this `load` would
    // be refused as a second answer, and the waiting row would stay blank for a
    // logo that exists.
    imageOf(switching).dispatchEvent(new Event('load'));

    waiting.detectChanges();

    expect(imageOf(waiting)).not.toBeNull();
    expect(imageOf(waiting).getAttribute('src')).toBe(
      logoUrlFor('wanted-now-instead')
    );
  });

  it('refuses an answer reported for an address it is no longer probing', () => {
    const switching = createComponent();

    renderWith(switching, 'reported-out-of-turn');
    renderWith(switching, 'the-one-being-probed');

    // Called directly rather than dispatched, because tracking the image by its
    // address normally destroys the old element with its listeners and makes this
    // unreachable. The guard is asserted separately so that the outcome stays
    // correct if it ever became reachable again.
    switching.componentInstance.onImageError(
      logoUrlFor('reported-out-of-turn')
    );

    switching.detectChanges();

    expect(imageOf(switching)).not.toBeNull();

    const waiting = createComponent();

    renderWith(waiting, 'the-one-being-probed');

    imageOf(switching).dispatchEvent(new Event('load'));

    waiting.detectChanges();

    expect(imageOf(waiting)).not.toBeNull();
  });

  it('replaces the image when the address changes, and keeps it when nothing else does', () => {
    const rendered = createComponent();

    renderWith(rendered, 'keeps-its-element');

    const firstImage = imageOf(rendered);

    rendered.componentRef.setInput('tooltip', 'Keeps Its Element');

    rendered.detectChanges();

    // Same address, same element: an input that does not identify a logo must not
    // restart the probe, which is why the image is tracked by its address rather
    // than re-created whenever anything changes.
    expect(imageOf(rendered)).toBe(firstImage);
    expect(imageOf(rendered).getAttribute('title')).toBe('Keeps Its Element');

    renderWith(rendered, 'gets-a-new-element');

    // Different address, different element - and therefore different listeners,
    // which is what stops the previous address's answer arriving as this one's.
    expect(imageOf(rendered)).not.toBe(firstImage);
    expect(imageOf(rendered).getAttribute('src')).toBe(
      logoUrlFor('gets-a-new-element')
    );
  });

  it('shows nothing once nothing identifies a logo any more', () => {
    const cleared = createComponent();

    renderWith(cleared, 'identified-then-not');

    imageOf(cleared).dispatchEvent(new Event('load'));

    cleared.detectChanges();

    expect(imageOf(cleared)).not.toBeNull();

    cleared.componentRef.setInput('symbol', undefined);

    cleared.detectChanges();

    // Reached only when the asset profile identifier and the explicit url are all
    // absent, so what is rendered describes inputs that no longer exist. Leaving
    // it in place showed a logo belonging to a row that had been emptied.
    expect(imageOf(cleared)).toBeNull();
    expect(cleared.componentInstance.src).toBeUndefined();
  });

  it('hands an unanswered address back when its inputs are cleared', () => {
    const cleared = createComponent();

    renderWith(cleared, 'cleared-mid-flight');

    expect(imageOf(cleared)).not.toBeNull();

    cleared.componentRef.setInput('symbol', undefined);

    cleared.detectChanges();

    expect(imageOf(cleared)).toBeNull();

    const later = createComponent();

    renderWith(later, 'cleared-mid-flight');

    // Same obligation as a row moving on: an emptied row stops probing, so the
    // address it was probing has to go back rather than stay pending forever.
    expect(imageOf(later)).not.toBeNull();
    expect(imageOf(later).getAttribute('src')).toBe(
      logoUrlFor('cleared-mid-flight')
    );
  });

  it('stops waiting on an address it has been emptied of', () => {
    const probing = createComponent();

    renderWith(probing, 'settles-after-the-wait-ends');

    const waiting = createComponent();

    renderWith(waiting, 'settles-after-the-wait-ends');

    expect(imageOf(waiting)).toBeNull();

    waiting.componentRef.setInput('symbol', undefined);

    waiting.detectChanges();

    imageOf(probing).dispatchEvent(new Event('load'));

    waiting.detectChanges();

    // It is asking for nothing, so an answer about an address it used to want must
    // not put an image back into it.
    expect(imageOf(waiting)).toBeNull();
    expect(imageOf(probing)).not.toBeNull();
  });
});
