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

  afterEach(() => {
    jest.restoreAllMocks();
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
