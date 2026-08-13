import { ComponentFixture, TestBed } from '@angular/core/testing';
import { MatSnackBar } from '@angular/material/snack-bar';

import { GfValueComponent } from './value.component';

/**
 * The algebraic sign, and specifically when it must not be drawn.
 *
 * When `colorizeSign` is set this component owns the sign itself: it formats the
 * magnitude and the template puts a `+` or a `-` in front of it. That is only correct
 * while the magnitude survives rounding. A loss of a hundredth of a percent is displayed
 * as zero, and a zero with a minus in front of it tells the viewer they lost something
 * when the figure beside it says they lost nothing.
 *
 * The guard that suppressed the sign compared the *rendered string* against the literal
 * `'0.00'`, so it held for exactly one configuration - two decimal places, in a locale
 * that separates them with a full stop - and silently stopped working everywhere else.
 * Both of the configurations it missed are reached by the summary screen on its own: it
 * drops to `precision` 0 for large totals on a phone, and the application ships twelve
 * locales of which several separate decimals with a comma.
 *
 * The fix decides from the number, so these cases are stated as the numbers that produce
 * them. Inputs are set through `setInput` throughout, because the formatting is done in
 * `ngOnChanges` and assigning the field directly would never run it.
 */
describe('GfValueComponent', () => {
  let fixture: ComponentFixture<GfValueComponent>;

  /** Sets inputs together and renders once. */
  const render = (inputs: Record<string, unknown>) => {
    for (const [name, value] of Object.entries(inputs)) {
      fixture.componentRef.setInput(name, value);
    }

    fixture.detectChanges();
  };

  /** The rendered text, whitespace collapsed. */
  const text = () => {
    return (fixture.nativeElement as HTMLElement).textContent
      .replace(/\s+/g, ' ')
      .trim();
  };

  const useAbsoluteValue = () => {
    return fixture.componentInstance.useAbsoluteValue;
  };

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [GfValueComponent],
      providers: [{ provide: MatSnackBar, useValue: { open: jest.fn() } }]
    }).compileComponents();

    fixture = TestBed.createComponent(GfValueComponent);

    fixture.componentRef.setInput('colorizeSign', true);
    fixture.componentRef.setInput('locale', 'en-US');
  });

  describe('a magnitude that rounds away to zero', () => {
    it('is drawn without a sign at two decimal places', () => {
      render({ isCurrency: true, value: -0.001 });

      expect(useAbsoluteValue()).toBe(true);
      expect(text()).toBe('0.00');
    });

    it('is drawn without a sign at no decimal places', () => {
      // The case the old string comparison missed on a phone: the same number renders
      // '0' rather than '0.00', so the guard did not fire and the row read '-0'.
      render({ isCurrency: true, precision: 0, value: -0.4 });

      expect(useAbsoluteValue()).toBe(true);
      expect(text()).toBe('0');
    });

    it('is drawn without a sign at four decimal places', () => {
      render({ isCurrency: true, precision: 4, value: -0.000001 });

      expect(useAbsoluteValue()).toBe(true);
      expect(text()).toBe('0.0000');
    });

    it('is drawn without a sign in a locale using a decimal comma', () => {
      // The other case the string comparison missed: '0,00' is not '0.00'.
      render({ isCurrency: true, locale: 'de-DE', value: -0.001 });

      expect(useAbsoluteValue()).toBe(true);
      expect(text()).toBe('0,00');
    });

    it('applies to a percentage judged after it has been scaled', () => {
      // A percentage is multiplied by a hundred before it is formatted, so the rounding
      // has to be judged against the scaled magnitude: -0.00001 is -0.001%, which
      // rounds to zero, while -0.0001 is -0.01%, which does not.
      render({ isPercent: true, value: -0.00001 });

      expect(useAbsoluteValue()).toBe(true);
      expect(text()).toBe('0.00%');
    });
  });

  describe('a magnitude that survives rounding', () => {
    it('keeps its sign', () => {
      render({ isCurrency: true, value: -12.34 });

      expect(useAbsoluteValue()).toBe(false);
      expect(text()).toBe('- 12.34');
    });

    it('keeps a percentage sign that scaling preserves', () => {
      render({ isPercent: true, value: -0.0001 });

      expect(useAbsoluteValue()).toBe(false);
      expect(text()).toBe('- 0.01%');
    });

    it('keeps a positive sign', () => {
      render({ isCurrency: true, value: 12.34 });

      expect(useAbsoluteValue()).toBe(false);
      expect(text()).toBe('+ 12.34');
    });
  });

  describe('an exact zero', () => {
    it('is drawn without a sign', () => {
      render({ isCurrency: true, value: 0 });

      expect(text()).toBe('0.00');
    });
  });

  describe('a value this component does not sign itself', () => {
    it('leaves a plain number to the formatter', () => {
      // Neither currency nor percentage, so `toLocaleString` owns the sign and nothing
      // here should second-guess it. Every caller that colourizes a sign pairs it with
      // one of those two, which is the configuration this component formats for, so the
      // plain case is stated the way it is actually used.
      render({ colorizeSign: false, value: 1234 });

      expect(useAbsoluteValue()).toBe(false);
      expect(text()).toBe('1,234');
    });

    it('leaves a string alone', () => {
      render({ colorizeSign: false, value: 'n/a' });

      expect(useAbsoluteValue()).toBe(false);
      expect(text()).toBe('n/a');
    });
  });
});
