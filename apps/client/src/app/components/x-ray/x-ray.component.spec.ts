import { ImpersonationStorageService } from '@ghostfolio/client/services/impersonation-storage.service';
import { UserService } from '@ghostfolio/client/services/user/user.service';
import { PortfolioReportResponse } from '@ghostfolio/common/interfaces';
import { User } from '@ghostfolio/common/interfaces/user.interface';
import { permissions } from '@ghostfolio/common/permissions';
import { DataService } from '@ghostfolio/ui/services';

import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { BehaviorSubject, Observable, of, throwError } from 'rxjs';

import { GfXRayComponent } from './x-ray.component';

/**
 * The X-ray module.
 *
 * Two properties of the report are pinned here, and each was a defect the module
 * shipped with.
 *
 * A rule that has been switched off appears exactly ONCE. The report hands the
 * module a set of categories, and the module also collects the switched-off rules
 * out of those same categories into an Inactive group - so handing the categories
 * over untouched drew every switched-off rule twice, once where it belongs and once
 * under Inactive. A viewer counting their rules counted it twice.
 *
 * A failed read ENDS. The request carried no failure handler, so a rejection left
 * the loading flag raised for ever: the module showed skeletons indefinitely, said
 * nothing about why, and offered no way to ask again - and because nothing was
 * watching the endpoint, recovering it changed nothing either.
 */
describe('GfXRayComponent', () => {
  let fixture: ComponentFixture<GfXRayComponent>;
  let component: GfXRayComponent;
  let fetchPortfolioReport: jest.Mock;
  let reportResponses: Observable<unknown>[];
  let stateChanged: BehaviorSubject<{ user: User }>;

  /**
   * A report shaped like the one the defect was found on: a category holding one
   * active rule and one rule that is switched off but still carries the value it
   * measured while it was on.
   */
  const createReport = (): PortfolioReportResponse => {
    return {
      xRay: {
        categories: [
          {
            key: 'EMERGENCY_FUND',
            name: 'Emergency Fund',
            rules: [
              {
                categoryName: 'Emergency Fund',
                configuration: undefined,
                evaluation: 'active and passing',
                isActive: true,
                key: 'EMERGENCY_FUND_SETUP',
                name: 'Emergency Fund: Set up',
                settings: undefined,
                value: true
              },
              {
                categoryName: 'Emergency Fund',
                configuration: undefined,
                // The shape that produced the contradiction: switched OFF while
                // still carrying the passing value it measured beforehand.
                evaluation: 'switched off but previously passing',
                isActive: false,
                key: 'FEE_RATIO_INITIAL_INVESTMENT',
                name: 'Fee Ratio',
                settings: undefined,
                value: true
              }
            ]
          }
        ],
        statistics: { rulesActiveCount: 1, rulesFulfilledCount: 1 }
      }
    } as unknown as PortfolioReportResponse;
  };

  const createUser = (): User => {
    return {
      permissions: [permissions.updateUserSettings],
      settings: { locale: 'en' },
      subscription: { type: 'Premium' }
    } as unknown as User;
  };

  const createComponent = async () => {
    fetchPortfolioReport = jest.fn(() => {
      return reportResponses.length
        ? reportResponses.shift()
        : of(createReport());
    });

    stateChanged = new BehaviorSubject<{ user: User }>({ user: createUser() });

    await TestBed.configureTestingModule({
      imports: [GfXRayComponent],
      providers: [
        provideNoopAnimations(),
        {
          provide: DataService,
          useValue: {
            fetchPortfolioReport,
            putUserSetting: jest.fn(() => of({}))
          }
        },
        {
          provide: ImpersonationStorageService,
          useValue: {
            onChangeHasImpersonation: () => new BehaviorSubject<string>(null)
          }
        },
        {
          provide: UserService,
          useValue: { get: () => of(createUser()), stateChanged }
        }
      ]
    }).compileComponents();

    fixture = TestBed.createComponent(GfXRayComponent);
    component = fixture.componentInstance;

    fixture.detectChanges();

    return component;
  };

  const host = () => fixture.nativeElement as HTMLElement;

  const notice = () => host().querySelector('[role="alert"]');

  const buttonLabelled = (label: string) => {
    return Array.from(host().querySelectorAll('button')).find((button) => {
      return button.textContent.trim() === label;
    });
  };

  beforeEach(() => {
    reportResponses = [];
  });

  describe('a rule that has been switched off', () => {
    it('is taken out of the category it belongs to', async () => {
      await createComponent();

      expect(component.categories).toHaveLength(1);
      expect(component.categories[0].rules.map(({ key }) => key)).toEqual([
        'EMERGENCY_FUND_SETUP'
      ]);
    });

    it('is collected into the inactive group instead', async () => {
      await createComponent();

      expect(component.inactiveRules.map(({ key }) => key)).toEqual([
        'FEE_RATIO_INITIAL_INVESTMENT'
      ]);
    });

    /**
     * The property the duplication actually violated, asserted over the whole
     * report rather than over either list: a rule belongs to exactly one place.
     */
    it('appears exactly once across the whole report', async () => {
      await createComponent();

      const rendered = [
        ...component.categories.flatMap(({ rules }) => rules),
        ...component.inactiveRules
      ].map(({ key }) => key);

      expect(rendered).toHaveLength(new Set(rendered).size);
      expect(rendered.sort()).toEqual([
        'EMERGENCY_FUND_SETUP',
        'FEE_RATIO_INITIAL_INVESTMENT'
      ]);
    });

    /**
     * The report object is shared between the two derivations, so taking the rule
     * out of the categories must not empty the list the inactive group is built
     * from. A splice would have done exactly that.
     */
    it('leaves the response it was derived from intact', async () => {
      const report = createReport();

      reportResponses = [of(report)];

      await createComponent();

      expect(report.xRay.categories[0].rules).toHaveLength(2);
    });
  });

  describe('a report that could not be read', () => {
    it('stops loading instead of showing skeletons for ever', async () => {
      reportResponses = [throwError(() => ({ status: 500 }))];

      await createComponent();

      expect(component.isLoading).toBe(false);
      expect(component.hasError).toBe(true);
    });

    it('says so, and offers to try again', async () => {
      reportResponses = [throwError(() => ({ status: 500 }))];

      await createComponent();

      expect(notice()).toBeTruthy();
      expect(notice().textContent).toContain(
        'Your X-ray report could not be loaded.'
      );
      expect(buttonLabelled('Try again')).toBeTruthy();
    });

    it('recovers the report when the retry succeeds', async () => {
      reportResponses = [throwError(() => ({ status: 500 }))];

      await createComponent();

      expect(fetchPortfolioReport).toHaveBeenCalledTimes(1);

      buttonLabelled('Try again').click();

      fixture.detectChanges();

      expect(fetchPortfolioReport).toHaveBeenCalledTimes(2);
      expect(component.hasError).toBe(false);
      expect(component.isLoading).toBe(false);
      expect(component.categories).toHaveLength(1);
      expect(notice()).toBeNull();
    });

    it('shows no notice at all when the report loads', async () => {
      await createComponent();

      expect(component.hasError).toBe(false);
      expect(notice()).toBeNull();
      expect(buttonLabelled('Try again')).toBeUndefined();
    });
  });
});
