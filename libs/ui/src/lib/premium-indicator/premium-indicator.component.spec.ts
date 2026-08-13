import { ComponentFixture, TestBed } from '@angular/core/testing';

import { GfPremiumIndicatorComponent } from './premium-indicator.component';

/**
 * The badge that offers the plan page, and the shape it takes when it must not.
 *
 * This badge carries no text of its own - a single diamond glyph - so everything
 * about it is either an attribute or the choice of element, and neither is visible
 * to a compiler. Two things changed with the canvas refactor and neither could be
 * seen from the outside.
 *
 * First, the plan page moved out of the application, so the badge is an ordinary
 * absolute address opened in a new tab. `rel="noopener noreferrer"` is what stops
 * the opened document from keeping a handle on this window through `opener`, from
 * which it could navigate it; that attribute is a security property expressed as
 * markup, so it is asserted rather than assumed.
 *
 * Second, and less obviously, the disabled state is a *different element* rather
 * than an anchor styled out of action. `pointer-events: none` takes the pointer
 * away and nothing else: the anchor stays in the tab order and stays activatable
 * from the keyboard, so a viewer navigating by keyboard could still reach the plan
 * page from a badge that was meant to be inert - and where a consumer nests this
 * badge inside its own link, as the dashboard toolbar's plan row does, it also puts
 * a link inside a link, which is invalid and offers two targets for one thing.
 * Choosing the element instead makes the inert shape genuinely inert. That is only
 * true while *both* shapes exist and neither is an anchor by accident, which is
 * what the two mutually exclusive assertions below pin down.
 *
 * The accessible name is asserted on both shapes because the glyph is hidden from
 * assistive technology in both: with the glyph hidden and no text present, the
 * `title` is the only name either shape has, and losing it would leave an
 * unlabelled control in one case and an unlabelled image in the other.
 */
describe('GfPremiumIndicatorComponent', () => {
  const EXPECTED_NAME = 'Upgrade to Ghostfolio Premium';

  let fixture: ComponentFixture<GfPremiumIndicatorComponent>;

  const createComponent = (enableLink?: boolean) => {
    fixture = TestBed.createComponent(GfPremiumIndicatorComponent);

    if (enableLink !== undefined) {
      fixture.componentRef.setInput('enableLink', enableLink);
    }

    fixture.detectChanges();

    return fixture;
  };

  const host = () => fixture.nativeElement as HTMLElement;

  const anchor = () => host().querySelector('a');
  const decorativeShape = () => host().querySelector('span[role="img"]');
  const glyph = () => host().querySelector('ion-icon');

  /**
   * The same three lookups, for the assertions that go on to read them.
   *
   * Each throws rather than returning `null`, which is what narrows the type for the
   * caller. A matcher could not: `expect(...).not.toBeNull()` tells the reader the
   * element is there and tells the compiler nothing, so every following attribute
   * read would still be an access on a possibly-absent element - and `!` and `as`
   * are both refused here. A shape that failed to render therefore fails the test
   * where it is missed, naming what was expected.
   */
  const require = <T>(element: T | null, description: string) => {
    if (!element) {
      throw new Error(`Expected ${description}, but none was rendered.`);
    }

    return element;
  };

  const requireAnchor = () => require(anchor(), 'a link to the plan page');
  const requireDecorativeShape = () =>
    require(decorativeShape(), 'a decorative badge');
  const requireGlyph = () => require(glyph(), 'the badge glyph');

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [GfPremiumIndicatorComponent]
    }).compileComponents();
  });

  it('offers the plan page by default, because that is what it is for', () => {
    createComponent();

    expect(anchor()).not.toBeNull();
    expect(decorativeShape()).toBeNull();
  });

  describe('when it offers the plan page', () => {
    it('addresses the externally hosted page in a tab of its own', () => {
      createComponent(true);

      const link = requireAnchor();

      // Absolute rather than in-application: the plan page is not part of this
      // application any more, so a `routerLink` here would resolve to nothing.
      expect(link.getAttribute('href')).toBe(
        `https://ghostfol.io/${document.documentElement.lang}/pricing`
      );
      expect(link.getAttribute('href')).toMatch(/^https:\/\/ghostfol\.io\//);
      expect(link.getAttribute('target')).toBe('_blank');
    });

    it('isolates the opened tab from this one', () => {
      createComponent(true);

      // Without `noopener` the opened document can navigate this window through
      // `opener`; `noreferrer` withholds the address it was opened from. Both are
      // required and both are asserted, because a partial `rel` reads as correct.
      const rel = requireAnchor().getAttribute('rel');

      expect(rel).toContain('noopener');
      expect(rel).toContain('noreferrer');
    });

    it('is named, and names itself only once', () => {
      createComponent(true);

      // The glyph is hidden, so the title is the whole of the accessible name - and
      // hiding the glyph is also what stops the name being announced twice.
      expect(requireAnchor().getAttribute('title')).toBe(EXPECTED_NAME);
      expect(requireAnchor().textContent.trim()).toBe('');
      expect(requireGlyph().getAttribute('aria-hidden')).toBe('true');
    });
  });

  describe('when it must not offer the plan page', () => {
    it('renders a decorative element instead of a disabled link', () => {
      createComponent(false);

      // No anchor at all, which is the point: an anchor made unclickable with
      // pointer events would still be reachable from the keyboard, and nested
      // inside a consumer's own link it would be invalid markup as well.
      expect(anchor()).toBeNull();
      expect(decorativeShape()).not.toBeNull();
      expect(host().querySelector('[href]')).toBeNull();
    });

    it('keeps its name, and keeps it reachable on a bare element', () => {
      createComponent(false);

      // A `title` on a plain span is not announced as a name on its own; the image
      // role is what makes it one, so the badge still says what it is even when it
      // does nothing.
      expect(requireDecorativeShape().getAttribute('title')).toBe(
        EXPECTED_NAME
      );
      expect(requireDecorativeShape().getAttribute('role')).toBe('img');
      expect(requireGlyph().getAttribute('aria-hidden')).toBe('true');
    });

    it('is not focusable, so it cannot be activated at all', () => {
      createComponent(false);

      expect(host().querySelector('[tabindex]')).toBeNull();
      expect(
        host().querySelectorAll('a, button, input, [tabindex]')
      ).toHaveLength(0);
    });
  });

  it('renders exactly one of its two shapes, whichever is asked for', () => {
    // The two shapes are mutually exclusive by construction, and a template edit
    // that turned the alternative into a sibling would render both - a duplicate
    // name and, in the enabled case, two targets for one thing.
    for (const enableLink of [true, false]) {
      createComponent(enableLink);

      expect(host().querySelectorAll('a, span[role="img"]')).toHaveLength(1);
      expect(host().querySelectorAll('ion-icon')).toHaveLength(1);
    }
  });
});
