import { ComponentFixture, TestBed } from '@angular/core/testing';
import { AbstractControl } from '@angular/forms';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { GfFireCalculatorComponent } from './fire-calculator.component';

/**
 * The retirement projection, and the input it could not model.
 *
 * The number of compounding periods is solved with logarithms, and with a NEGATIVE annual
 * rate the argument of one of them goes non-positive: the answer came back `NaN`, which
 * was charted as an empty projection and a retirement date of nothing, with no indication
 * that the rate was the cause. The formula does not describe a shrinking balance, so the
 * input is refused rather than pretended at.
 *
 * Refusing it has three parts, and each one is a way the wrong answer used to get through:
 * the control reports the rule, the chart is not redrawn from a value the form has already
 * refused, and the rate is not emitted - because it is persisted as a user setting, so
 * publishing it would store the refused value and bring it back on the next visit.
 */
describe('GfFireCalculatorComponent', () => {
  let component: GfFireCalculatorComponent;
  let fixture: ComponentFixture<GfFireCalculatorComponent>;

  /** The template as text, resolved from this spec's own location. */
  const template = readFileSync(
    join(__dirname, 'fire-calculator.component.html'),
    'utf8'
  );

  const createComponent = async () => {
    TestBed.resetTestingModule();

    await TestBed.configureTestingModule({
      imports: [GfFireCalculatorComponent],
      providers: [provideNoopAnimations()]
    })
      // The chart is built against a real canvas, which jsdom does not provide, and the
      // rule under test is stated entirely in the form.
      .overrideComponent(GfFireCalculatorComponent, {
        set: { template: '' }
      })
      .compileComponents();

    fixture = TestBed.createComponent(GfFireCalculatorComponent);
    component = fixture.componentInstance;

    return component;
  };

  /**
   * The rate control, cast because `get` is declared as possibly returning nothing.
   *
   * Every use below would otherwise need the same guard, and a missing control is not a
   * condition worth tolerating here: the form is built in the component's constructor
   * and a test that reached this helper without it would be asserting nothing.
   */
  const rateControl = () => {
    return component.calculatorForm.get(
      'annualInterestRate'
    ) as AbstractControl;
  };

  describe('the annual interest rate', () => {
    it('refuses a negative rate', async () => {
      await createComponent();

      rateControl().setValue(-5);

      expect(rateControl().hasError('min')).toBe(true);
      expect(component.calculatorForm.invalid).toBe(true);
    });

    it('accepts no interest at all', async () => {
      await createComponent();

      rateControl().setValue(0);

      // Zero is a case the calculator models explicitly - it has its own branch that
      // skips compounding - so it must not be caught by the same rule.
      expect(rateControl().hasError('min')).toBe(false);
    });

    it('accepts an ordinary rate', async () => {
      await createComponent();

      rateControl().setValue(5);

      expect(rateControl().valid).toBe(true);
    });

    it('does not publish a refused rate', async () => {
      await createComponent();

      const emitted: number[] = [];

      (
        component as unknown as {
          annualInterestRateChanged: {
            subscribe: (fn: (r: number) => void) => void;
          };
        }
      ).annualInterestRateChanged.subscribe((rate) => {
        emitted.push(rate);
      });

      rateControl().setValue(-5);

      jest.advanceTimersByTime(1000);

      // The rate is persisted as a user setting, so emitting it would store the refused
      // value and bring it back on the next visit.
      expect(emitted).toEqual([]);
    });

    it('publishes an accepted rate', async () => {
      await createComponent();

      // The accepted path goes on to redraw, and the chart is built against a real
      // canvas this environment has none of. Only the publishing is under test here.
      jest
        .spyOn(component as unknown as { initialize: () => void }, 'initialize')
        .mockImplementation(() => undefined);

      const emitted: number[] = [];

      (
        component as unknown as {
          annualInterestRateChanged: {
            subscribe: (fn: (r: number) => void) => void;
          };
        }
      ).annualInterestRateChanged.subscribe((rate) => {
        emitted.push(rate);
      });

      rateControl().setValue(4);

      jest.advanceTimersByTime(1000);

      expect(emitted).toEqual([4]);
    });
  });

  describe('the rule as the viewer meets it', () => {
    it('is stated beside the control', () => {
      expect(template).toContain(
        "calculatorForm.get('annualInterestRate').hasError('min')"
      );
      expect(template).toContain('Please enter a rate of 0% or more.');
    });

    it('is stated to the control itself as well', () => {
      // So the number input's own stepper and its native validity agree with the form
      // rather than offering values the form will refuse.
      expect(template).toContain('min="0"');
    });
  });

  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });
});
