import { PublicPortfolioResponse } from '@ghostfolio/common/interfaces';
import { DataService } from '@ghostfolio/ui/services';

import { HttpErrorResponse } from '@angular/common/http';
import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute } from '@angular/router';
import { StatusCodes } from 'http-status-codes';
import { DeviceDetectorService } from 'ngx-device-detector';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BehaviorSubject, throwError } from 'rxjs';

import { GfPublicPortfolioComponent } from './public-portfolio.component';

/**
 * The consumer half of the public share link.
 *
 * The identifier arrives as the root route's `accessId` *query parameter*, and that
 * read is the whole subject here. It is more delicate than it looks, because the
 * root route's query parameters belong to every co-mounted module at once. They change for reasons that have nothing to do with a shared
 * portfolio - a dialog flag, a symbol, a spent token being cleared - so the stream
 * is narrowed to a defined value and deduplicated. Get either wrong and the
 * component either loses the identifier it captured or refetches somebody else's
 * portfolio on an unrelated URL change; neither is visible to a compiler and
 * neither raises an error.
 *
 * The template is replaced. It renders five chart and table components whose own
 * suites cover them, and none of them participates in the identifier read; what is
 * asserted here is the request the component makes and how it treats the answer.
 */
describe('GfPublicPortfolioComponent', () => {
  /**
   * Shaped like the identifier the server actually issues - `Access.id` is
   * `@default(uuid())` - because the component refuses to ask about anything else.
   * A placeholder would make every assertion below pass or fail for the wrong
   * reason, by never reaching the request at all.
   */
  const accessId = '8f5cd0cf-2e2f-4bbe-a3ec-6a6b1b1b6d02';

  let fetchPublicPortfolio: jest.Mock;
  let fixture: ComponentFixture<GfPublicPortfolioComponent>;
  let queryParams: BehaviorSubject<Record<string, unknown>>;

  const createPortfolio = (): PublicPortfolioResponse => {
    return {
      alias: 'Some Portfolio',
      holdings: {},
      latestActivities: [],
      markets: {}
    } as unknown as PublicPortfolioResponse;
  };

  const createComponent = async (
    initialQueryParams: Record<string, unknown> = { accessId }
  ) => {
    fetchPublicPortfolio = jest.fn(
      () => new BehaviorSubject(createPortfolio())
    );
    queryParams = new BehaviorSubject<Record<string, unknown>>(
      initialQueryParams
    );

    await TestBed.configureTestingModule({
      imports: [GfPublicPortfolioComponent],
      providers: [
        {
          provide: ActivatedRoute,
          useValue: { queryParams: queryParams.asObservable() }
        },
        {
          provide: DataService,
          useValue: {
            fetchInfo: () => ({ globalPermissions: [] }),
            fetchPublicPortfolio
          }
        },
        {
          provide: DeviceDetectorService,
          useValue: { deviceInfo: signal({ deviceType: 'desktop' }) }
        }
      ]
    })
      .overrideComponent(GfPublicPortfolioComponent, {
        set: { imports: [], template: '' }
      })
      .compileComponents();

    fixture = TestBed.createComponent(GfPublicPortfolioComponent);

    return fixture.componentInstance;
  };

  /**
   * The identifiers the component asked about, in order.
   *
   * There is no captured field to read: the identifier is derived inside the
   * parameter pipeline and handed straight to the request, which is what lets a
   * newer link abandon an in-flight read for an older one. Observing the requests
   * is therefore both the only way to see it and the stronger assertion - it pins
   * the effect rather than an intermediate member.
   */
  const requestedAccessIds = (): string[] => {
    return fetchPublicPortfolio.mock.calls.map(([id]) => id);
  };

  /** Whether the component is showing the visitor an error. */
  const isReportingError = (component: GfPublicPortfolioComponent) => {
    return (component as unknown as { hasError: boolean }).hasError;
  };

  const portfolioOf = (component: GfPublicPortfolioComponent) => {
    return (component as unknown as { publicPortfolioDetails: unknown })
      .publicPortfolioDetails;
  };

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('reading the identifier from the query', () => {
    it('asks about exactly the identifier the link was addressed with', async () => {
      const component = await createComponent();

      component.ngOnInit();

      // The single most consequential assertion in this file: the argument is the
      // identifier, unwrapped and unprefixed. A component that passed the whole
      // parameter object, or a prefixed value, would fetch nothing and show an empty
      // portfolio without any error.
      expect(requestedAccessIds()).toEqual([accessId]);
      expect(isReportingError(component)).toBeFalsy();
    });

    it('follows the identifier when the link changes', async () => {
      const component = await createComponent();

      component.ngOnInit();

      queryParams.next({ accessId: '3b1f4b8a-9c6d-4a71-8f2e-5d0c7a9e1b34' });

      expect(requestedAccessIds()).toEqual([
        accessId,
        '3b1f4b8a-9c6d-4a71-8f2e-5d0c7a9e1b34'
      ]);
    });

    it.each([
      {
        description: 'an unrelated dialog flag arrives',
        params: { accessId, holdingDetailDialog: true }
      },
      {
        description: 'a spent token is cleared',
        params: { accessId, jwt: null }
      },
      {
        description: 'the same identifier is re-emitted',
        params: { accessId }
      }
    ])('asks nothing further when $description', async ({ params }) => {
      const component = await createComponent();

      component.ngOnInit();

      queryParams.next(params);

      // Deduplicated on the identifier itself, not on the parameter object, so an
      // unrelated mutation of a URL that every co-mounted module writes to is a
      // no-op here. Without that, every dialog flag on the canvas would refetch
      // somebody else's portfolio.
      expect(requestedAccessIds()).toEqual([accessId]);
      expect(portfolioOf(component)).toEqual(createPortfolio());
    });

    it('asks nothing when the identifier disappears from the query', async () => {
      const component = await createComponent();

      component.ngOnInit();

      queryParams.next({ holdingDetailDialog: true });

      // There is nothing to ask about, and nothing to report either: dropping the
      // identifier is how this branch is dismissed, and the canvas stops rendering
      // this component in the same change - it is the presence of the identifier
      // that selects the shared-portfolio branch at all.
      expect(requestedAccessIds()).toEqual([accessId]);
      expect(isReportingError(component)).toBeFalsy();
    });

    it('asks nothing when the link carries no identifier', async () => {
      const component = await createComponent({});

      component.ngOnInit();

      expect(requestedAccessIds()).toEqual([]);
      expect(isReportingError(component)).toBeFalsy();
    });

    it.each([
      { description: 'is not shaped like one', accessId: 'a1b2c3' },
      {
        description: 'is a path traversal attempt',
        accessId: '../../api/v1/user'
      },
      { description: 'carries a query of its own', accessId: 'abc?x=1' }
    ])(
      'refuses an identifier that $description, without asking',
      async ({ accessId: candidate }) => {
        const component = await createComponent({ accessId: candidate });

        component.ngOnInit();

        // The value is visitor-supplied and ends up in a path segment, so it is
        // checked against the shape the server issues before any request is made.
        // Anything else is reported to the visitor rather than sent.
        expect(requestedAccessIds()).toEqual([]);
        expect(isReportingError(component)).toBe(true);
      }
    );
  });

  /**
   * The keyboard focus indicator, asserted from the stylesheet source.
   *
   * It cannot be asserted from behaviour here. This environment applies no
   * component-scoped stylesheet and computes no outline, so a rendered-and-focused
   * assertion passes whether the rule exists or not - which is precisely how a ring
   * that was authored, compiled and shipped once turned out to paint nothing. The
   * source is the only thing a test in this environment can actually see.
   *
   * Both selectors matter and they are asserted separately. The button is the sole
   * control on the unavailable-share branch, and the anchor is the CTA at the foot
   * of a loaded portfolio; a rule naming only one of them would leave a signed-out
   * visitor with an unindicated control on whichever surface it missed.
   */
  describe('the focus indicator on its own controls', () => {
    const styles = readFileSync(
      join(__dirname, 'public-portfolio.scss'),
      'utf8'
    );

    it('names both the button and the anchor', () => {
      expect(styles).toContain('a:focus-visible,');
      expect(styles).toContain('button:focus-visible {');
    });

    it('draws the same indicator as every other signed-out surface', () => {
      // Identical to the sign-in prompt and the empty-canvas state. The token is
      // unpopulated in this theme, so the fallback is what paints, and it is the
      // fallback - not the token - that has to be right.
      expect(styles).toContain(
        'outline: 2px solid var(--mat-sys-on-surface, rgba(0, 0, 0, 0.87));'
      );
      expect(styles).toContain('outline-offset: 2px;');
    });

    it('restates only the colour for the dark theme', () => {
      // A second full declaration would re-specify the width and offset in a place
      // nobody would think to look when changing them.
      const darkTheme = styles.slice(
        styles.indexOf(':host-context(.theme-dark)')
      );

      expect(darkTheme).toContain(
        'outline-color: var(--mat-sys-on-surface, #ffffff);'
      );
      expect(darkTheme).not.toContain('outline-offset');
    });

    it('does not reach into the tables and charts it hosts', () => {
      // Deliberate: those are pre-existing shared components with their own
      // indicators to answer for, and a component-scoped rule could not reach them
      // anyway. Asserted so that a later attempt to fix them from here is caught
      // here rather than discovered to be inert in a browser.
      expect(styles).not.toContain('::ng-deep');
    });
  });

  describe('the fetched portfolio', () => {
    it('adopts the answer and prepares the activity table', async () => {
      const component = await createComponent();

      component.ngOnInit();

      expect(portfolioOf(component)).toEqual(createPortfolio());
      expect(
        (
          component as unknown as {
            latestActivitiesDataSource: { data: unknown[] };
          }
        ).latestActivitiesDataSource.data
      ).toEqual([]);
    });

    it.each([
      { description: 'unknown or revoked', status: StatusCodes.NOT_FOUND },
      {
        description: 'unreadable for a server-side reason',
        status: StatusCodes.INTERNAL_SERVER_ERROR
      }
    ])(
      'reports a portfolio that is $description and carries on',
      async ({ status }) => {
        const component = await createComponent();
        const consoleErrorSpy = jest
          .spyOn(console, 'error')
          .mockImplementation(() => undefined);

        fetchPublicPortfolio.mockReturnValue(
          throwError(() => new HttpErrorResponse({ status }))
        );

        // Swallowed rather than rethrown, and deliberately without a navigation: this
        // component is hosted by the root route itself, so redirecting there would be
        // a no-op at best and re-entrant at worst.
        expect(() => component.ngOnInit()).not.toThrow();

        expect(portfolioOf(component)).toBeUndefined();
        expect(isReportingError(component)).toBe(true);
        expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
      }
    );

    it('reports the failure without disclosing what was asked for', async () => {
      const component = await createComponent();
      const consoleErrorSpy = jest
        .spyOn(console, 'error')
        .mockImplementation(() => undefined);

      fetchPublicPortfolio.mockReturnValue(
        throwError(
          () =>
            new HttpErrorResponse({
              status: StatusCodes.NOT_FOUND,
              url: `/api/v1/public/${accessId}/portfolio`
            })
        )
      );

      component.ngOnInit();

      // An event identifier and a status, never the error object: the raw response
      // carries the requested URL, and the identifier in it is the share secret.
      const [reported] = consoleErrorSpy.mock.calls[0];

      expect(typeof reported).toBe('string');
      expect(reported).toBe(
        `GF-PUBLIC-PORTFOLIO-FETCH-FAILED (status ${StatusCodes.NOT_FOUND})`
      );
      expect(reported as string).not.toContain(accessId);
    });
  });
});
