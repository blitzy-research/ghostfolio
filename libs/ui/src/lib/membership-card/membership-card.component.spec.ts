import { ComponentFixture, TestBed } from '@angular/core/testing';

import { GfMembershipCardComponent } from './membership-card.component';

/**
 * The card that shows a membership and offers the plan page.
 *
 * The whole card is one link, and where that link goes changed with the canvas
 * refactor: the plan page left the application, so the card addresses it absolutely
 * and opens it in a new tab. Two consequences are asserted here because neither is
 * visible to a compiler and both matter.
 *
 * `rel="noopener noreferrer"` is a security property expressed as markup - without
 * `noopener` the opened document keeps a handle on this window through `opener` and
 * can navigate it - so it is asserted rather than assumed.
 *
 * The API-key control sits *inside* that link, which is the interesting part. A
 * button nested in an anchor inherits the anchor's activation: pressing it would
 * both emit the request and leave for the plan page, and the viewer would find
 * themselves on an external site instead of holding a new key. The handler stops
 * both the default action and the propagation that would reach the anchor, and this
 * suite asserts that by pressing the real button on a real anchor and checking that
 * the event was cancelled - which is the only way to tell a handler that emits from
 * one that emits *and* navigates.
 */
describe('GfMembershipCardComponent', () => {
  let fixture: ComponentFixture<GfMembershipCardComponent>;

  /** Every request for a key the card emitted. */
  let keyRequests: number;

  const createComponent = (
    inputs: {
      expiresAt?: string;
      hasPermissionToCreateApiKey?: boolean;
      hover3d?: boolean;
      name?: string;
    } = {}
  ) => {
    fixture = TestBed.createComponent(GfMembershipCardComponent);

    for (const [name, value] of Object.entries({
      hasPermissionToCreateApiKey: false,
      name: 'Basic',
      ...inputs
    })) {
      fixture.componentRef.setInput(name, value);
    }

    keyRequests = 0;

    fixture.componentInstance.generateApiKeyClicked.subscribe(() => {
      keyRequests += 1;
    });

    fixture.detectChanges();

    return fixture;
  };

  const host = () => fixture.nativeElement as HTMLElement;

  const anchor = () => host().querySelector('a');
  const apiKeyButton = () => host().querySelector('button');

  /**
   * The same lookups, for the assertions that go on to read or press them.
   *
   * Each throws rather than returning `null`, which is what narrows the type for the
   * caller. A matcher could not: `expect(...).not.toBeNull()` tells the reader the
   * element is there and tells the compiler nothing, so every following attribute
   * read would still be an access on a possibly-absent element - and `!` and `as`
   * are both refused here. Something that failed to render therefore fails the test
   * where it is missed, naming what was expected.
   */
  const require = <T>(element: T | null, description: string) => {
    if (!element) {
      throw new Error(`Expected ${description}, but none was rendered.`);
    }

    return element;
  };

  const requireAnchor = () => require(anchor(), 'the card link');
  const requireApiKeyButton = () =>
    require(apiKeyButton(), 'the API key control');
  const requireCardContainer = () =>
    require(host().querySelector('.card-container'), 'the card container');

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [GfMembershipCardComponent]
    }).compileComponents();
  });

  describe('the plan page it addresses', () => {
    it('is the externally hosted page, opened in a tab of its own', () => {
      createComponent();

      // Absolute rather than in-application: the plan page is no longer a screen of
      // this application, so a `routerLink` would resolve to nothing at all.
      expect(requireAnchor().getAttribute('href')).toBe(
        `https://ghostfol.io/${document.documentElement.lang}/pricing`
      );
      expect(requireAnchor().getAttribute('href')).toMatch(
        /^https:\/\/ghostfol\.io\//
      );
      expect(requireAnchor().getAttribute('target')).toBe('_blank');
    });

    it('is opened with this window isolated from it', () => {
      createComponent();

      const rel = requireAnchor().getAttribute('rel');

      expect(rel).toContain('noopener');
      expect(rel).toContain('noreferrer');
    });

    it('is the only address the card carries', () => {
      createComponent({ hasPermissionToCreateApiKey: true });

      // One target for the card, even with the key control rendered: a second
      // address inside it would make the card ambiguous to operate.
      expect(host().querySelectorAll('a')).toHaveLength(1);
      expect(host().querySelectorAll('[href]')).toHaveLength(1);
    });
  });

  describe('the membership it shows', () => {
    it('shows the plan it was given', () => {
      createComponent({ name: 'Premium' });

      expect(host().textContent).toContain('Premium');
    });

    it('marks a premium membership so it can be styled as one', () => {
      createComponent({ name: 'Premium' });

      expect(requireCardContainer().classList.contains('premium')).toBe(true);
    });

    it('leaves a basic membership unmarked', () => {
      createComponent({ name: 'Basic' });

      expect(requireCardContainer().classList.contains('premium')).toBe(false);
    });

    it('shows an expiry only when there is one', () => {
      createComponent({ expiresAt: '2027-01-31', name: 'Premium' });

      expect(host().textContent).toContain('2027-01-31');

      createComponent({ name: 'Premium' });

      // A membership that does not expire must not show an empty date field, which
      // reads as missing information rather than as none.
      expect(host().textContent).not.toContain('Valid until');
    });

    it('renders its hover surfaces only when asked to', () => {
      createComponent({ hover3d: true });

      expect(host().querySelectorAll('.hover-zone')).toHaveLength(9);

      createComponent({ hover3d: false });

      expect(host().querySelectorAll('.hover-zone')).toHaveLength(0);
    });
  });

  describe('the API key control', () => {
    it('is absent for a viewer who may not create one', () => {
      createComponent({ hasPermissionToCreateApiKey: false });

      expect(apiKeyButton()).toBeNull();
      expect(host().textContent).not.toContain('API Key');
    });

    it('is present, named and glyphed for a viewer who may', () => {
      createComponent({ hasPermissionToCreateApiKey: true });

      // Named through its title, because the control carries a glyph and no text -
      // without the title it would be an unlabelled button.
      expect(apiKeyButton()).not.toBeNull();
      expect(requireApiKeyButton().getAttribute('title')).toContain(
        'Generate Ghostfolio Premium Data Provider API key'
      );
      expect(requireApiKeyButton().querySelector('ion-icon')).not.toBeNull();
      expect(host().textContent).toContain('API Key');
    });

    it('asks for a key when pressed', () => {
      createComponent({ hasPermissionToCreateApiKey: true });

      requireApiKeyButton().click();

      expect(keyRequests).toBe(1);
    });

    it('does not leave for the plan page while asking', () => {
      createComponent({ hasPermissionToCreateApiKey: true });

      let pressesReachingTheCardLink = 0;

      requireAnchor().addEventListener('click', () => {
        pressesReachingTheCardLink += 1;
      });

      const event = new MouseEvent('click', {
        bubbles: true,
        cancelable: true
      });

      requireApiKeyButton().dispatchEvent(event);

      // The control sits inside the card's own link, so an uncancelled press would
      // emit the request *and* leave for the plan page - the viewer would end up on
      // an external site instead of holding the key they just asked for.
      //
      // Both halves of the suppression are observed rather than inferred. The
      // refused default action survives on the event; the halted propagation does
      // not - the DOM specification clears the stop-propagation flag when dispatch
      // completes, so `cancelBubble` reads false afterwards whether or not it was
      // ever set. A listener on the card's own link is therefore the observation:
      // it hears nothing, which is exactly what keeps the viewer here.
      expect(keyRequests).toBe(1);
      expect(event.defaultPrevented).toBe(true);
      expect(pressesReachingTheCardLink).toBe(0);
    });
  });
});
