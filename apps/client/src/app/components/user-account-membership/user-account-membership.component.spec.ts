import { UserService } from '@ghostfolio/client/services/user/user.service';
import { publicRoutes } from '@ghostfolio/common/routes/routes';
import { NotificationService } from '@ghostfolio/ui/notifications';
import { DataService } from '@ghostfolio/ui/services';

import { ComponentFixture, TestBed } from '@angular/core/testing';
import { MatSnackBar } from '@angular/material/snack-bar';
import { BehaviorSubject } from 'rxjs';

import { GfUserAccountMembershipComponent } from './user-account-membership.component';

/**
 * The pricing link, which is a link without being a route.
 *
 * This application serves no pricing page, but the hosted deployment does, so the
 * link is an absolute URL to `ghostfol.io` - the same pattern the admin settings
 * component uses for the same page.
 *
 * Two things make this worth pinning. The route *constant* is deliberately still
 * consulted - `publicRoutes.pricing.path` is a `$localize`-tagged, per-locale
 * segment, so hardcoding "pricing" here would break twelve translations - which
 * means a reader could easily mistake this for an internal route and "simplify" it
 * into one. And because the URL is only ever handed to an `href`, a relative value
 * would still render as a working-looking link that resolves to the canvas via the
 * wildcard, so nothing would visibly fail.
 */
describe('GfUserAccountMembershipComponent', () => {
  let fixture: ComponentFixture<GfUserAccountMembershipComponent>;
  let stateChanged: BehaviorSubject<{ user: unknown }>;

  const createViewer = (language = 'en') => {
    return {
      permissions: [],
      settings: { language, locale: 'en-GB' },
      subscription: { offer: {}, type: 'Basic' }
    };
  };

  const createComponent = async (language?: string) => {
    stateChanged = new BehaviorSubject<{ user: unknown }>({
      user: createViewer(language)
    });

    await TestBed.configureTestingModule({
      imports: [GfUserAccountMembershipComponent],
      providers: [
        {
          provide: DataService,
          useValue: {
            fetchInfo: jest.fn(() => ({
              baseCurrency: 'CHF',
              globalPermissions: []
            }))
          }
        },
        { provide: MatSnackBar, useValue: { open: jest.fn() } },
        // Reached only by the API-key and close-account confirmations, neither of
        // which this suite triggers.
        { provide: NotificationService, useValue: {} },
        { provide: UserService, useValue: { stateChanged } }
      ]
    })
      // No template: the URL is computed from viewer state, and rendering the
      // membership panel would pull in the API-key and premium child components
      // without adding anything to the assertion.
      .overrideComponent(GfUserAccountMembershipComponent, {
        set: { imports: [], template: '' }
      })
      .compileComponents();

    fixture = TestBed.createComponent(GfUserAccountMembershipComponent);

    fixture.detectChanges();

    return fixture.componentInstance;
  };

  /**
   * Builds the panel with its real template, for the layout assertions below.
   *
   * The pricing-link tests deliberately render nothing, because the URL is computed
   * from viewer state and the markup adds nothing to that claim. The opposite is true
   * here: the defect being pinned is entirely in the markup, so the markup is what has
   * to be built.
   */
  const createRenderedComponent = async () => {
    stateChanged = new BehaviorSubject<{ user: unknown }>({
      user: {
        permissions: ['updateUserSettings'],
        settings: { language: 'en', locale: 'en-GB' },
        subscription: { offer: { price: 99 }, type: 'Basic' }
      }
    });

    await TestBed.configureTestingModule({
      imports: [GfUserAccountMembershipComponent],
      providers: [
        {
          provide: DataService,
          useValue: {
            fetchInfo: jest.fn(() => ({
              baseCurrency: 'CHF',
              globalPermissions: ['enableSubscription']
            }))
          }
        },
        { provide: MatSnackBar, useValue: { open: jest.fn() } },
        { provide: NotificationService, useValue: {} },
        { provide: UserService, useValue: { stateChanged } }
      ]
    }).compileComponents();

    fixture = TestBed.createComponent(GfUserAccountMembershipComponent);

    fixture.detectChanges();

    return fixture.nativeElement as HTMLElement;
  };

  afterEach(() => {
    jest.restoreAllMocks();
  });

  /**
   * How the panel behaves in a cell at this module's declared minimum size.
   *
   * Four columns by five rows leaves roughly 364px of body, and for a Basic viewer the
   * card, the upgrade control, the price, the offer badge and the two secondary actions
   * come to more than that. Two separate things went wrong as a result, and only the
   * first of them was recoverable by the viewer:
   *
   * 1. The content was centred with `align-items-center` against a fixed `h-100`. A
   *    centred flex item taller than its container overflows equally in both
   *    directions, and block overflow before the container's start edge lies outside
   *    the scrollable region altogether - so the top of the membership card was cut off
   *    and no amount of scrolling brought it back.
   * 2. The gap between the card and the controls beneath it was page-scale, so the
   *    upgrade control - the only reason this module exists for a Basic viewer - was
   *    pushed past the fold at the very size the module declares as usable.
   *
   * jsdom performs no layout, so what is asserted here is the arrangement that produces
   * the behaviour rather than the pixels. That is the right level for it: the pixels are
   * measured at runtime, and what a regression would do is put one of these classes
   * back.
   */
  describe('the layout at the module minimum', () => {
    it('centres with an auto margin rather than by aligning', async () => {
      const element = await createRenderedComponent();
      const layout = element.querySelector('.gf-membership-layout');

      expect(layout).toBeTruthy();

      // The three that made the overflow unreachable. `h-100` in particular capped the
      // host at the visible height, so tall content spilled outside the box instead of
      // extending the region the module's scroll affordance travels over.
      expect(layout.classList.contains('align-items-center')).toBe(false);
      expect(layout.classList.contains('h-100')).toBe(false);
      expect(layout.classList.contains('justify-content-center')).toBe(false);
    });

    it('keeps the gutter that holds the row inside its cell', async () => {
      const element = await createRenderedComponent();
      const layout = element.querySelector('.gf-membership-layout');

      // `container-fluid` is what cancels the negative inline margins of the row it
      // wraps. Dropping it while rearranging the vertical centring would push the
      // content past both side edges of the module.
      expect(layout.classList.contains('container-fluid')).toBe(true);
      expect(layout.classList.contains('d-flex')).toBe(true);
    });

    it('separates the controls from the card at module scale', async () => {
      const element = await createRenderedComponent();
      const controls = element.querySelector(
        '.gf-membership-layout .d-flex.flex-column.mt-4'
      );

      expect(controls).toBeTruthy();
      expect(element.querySelector('.mt-5')).toBeNull();
    });

    it('lets the secondary actions wrap instead of overflowing', async () => {
      const element = await createRenderedComponent();
      const actions = Array.from(
        element.querySelectorAll('.justify-content-center')
      ).find((node) => node.classList.contains('align-items-center'));

      expect(actions).toBeTruthy();

      // Four columns is narrow enough that "Try Premium" with its premium indicator
      // and "Redeem Coupon" together exceed the body on a smaller canvas. Without
      // wrapping, the second control ended up outside it.
      expect(actions.classList.contains('flex-wrap')).toBe(true);
    });

    it('shows the upgrade control for a Basic viewer', async () => {
      const element = await createRenderedComponent();

      // A precondition for everything above: if this branch does not render there is
      // no overflow to arrange, and the layout assertions would pass vacuously.
      expect(element.textContent).toContain('Upgrade Plan');
      expect(element.textContent).toContain('Redeem Coupon');
    });
  });

  describe('the pricing link', () => {
    it('addresses the hosted deployment, not this application', async () => {
      const component = await createComponent('en');

      expect(component.pricingUrl).toBe(
        `https://ghostfol.io/en/${publicRoutes.pricing.path}`
      );
    });

    it('is absolute, so it cannot resolve against the canvas', async () => {
      const component = await createComponent();

      // A relative value would still render as a link and the wildcard would still
      // resolve it - to the canvas - so nothing would look broken.
      expect(component.pricingUrl.startsWith('https://')).toBe(true);
    });

    it.each(['de', 'es', 'pt', 'zh'])(
      'follows the viewer language %s',
      async (language) => {
        const component = await createComponent(language);

        expect(component.pricingUrl).toBe(
          `https://ghostfol.io/${language}/${publicRoutes.pricing.path}`
        );
      }
    );

    it('keeps using the translated route segment', async () => {
      const component = await createComponent();

      // Consulting the constant is the point: the segment is `$localize`-tagged per
      // locale, so a hardcoded "pricing" would silently break twelve translations
      // while still passing an equality check against the English value.
      expect(
        component.pricingUrl.endsWith(`/${publicRoutes.pricing.path}`)
      ).toBe(true);
    });

    it('is rebuilt when the viewer changes', async () => {
      const component = await createComponent('en');

      stateChanged.next({ user: createViewer('fr') });

      // The language lives in viewer settings, so a URL computed once at
      // construction would go stale the moment the viewer is re-fetched.
      expect(component.pricingUrl).toBe(
        `https://ghostfol.io/fr/${publicRoutes.pricing.path}`
      );
    });
  });
});
