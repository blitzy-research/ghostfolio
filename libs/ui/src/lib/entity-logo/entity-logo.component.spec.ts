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
});
