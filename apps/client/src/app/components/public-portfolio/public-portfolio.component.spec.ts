import { PublicPortfolioResponse } from '@ghostfolio/common/interfaces';
import { DataService } from '@ghostfolio/ui/services';

import { HttpErrorResponse } from '@angular/common/http';
import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute } from '@angular/router';
import { StatusCodes } from 'http-status-codes';
import { DeviceDetectorService } from 'ngx-device-detector';
import { BehaviorSubject, throwError } from 'rxjs';

import { GfPublicPortfolioComponent } from './public-portfolio.component';

/**
 * The consumer half of the public share link.
 *
 * This component is the relocated leaf of the deleted public page, and the one
 * thing the relocation changed is where it gets its identifier from: the retired
 * `/<language>/p/<id>` route supplied it as a *route parameter*, and the root route
 * supplies it as the `accessId` *query parameter*. Everything downstream of that
 * read is carried over unchanged.
 *
 * That read is the whole subject here, and it is more delicate than it looks,
 * because the root route's query parameters now belong to every co-mounted module
 * at once. They change for reasons that have nothing to do with a shared
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
      // parameter object, or a residue of the retired route parameter, would fetch
      // nothing and show an empty portfolio without any error.
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
