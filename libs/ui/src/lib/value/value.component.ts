import { getLocale } from '@ghostfolio/common/helper';

import { Clipboard } from '@angular/cdk/clipboard';
import { CommonModule } from '@angular/common';
import {
  AfterViewInit,
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  computed,
  CUSTOM_ELEMENTS_SCHEMA,
  ElementRef,
  input,
  Input,
  OnChanges,
  ViewChild
} from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatSnackBar } from '@angular/material/snack-bar';
import { IonIcon } from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import { copyOutline } from 'ionicons/icons';
import { isNumber } from 'lodash';
import ms from 'ms';
import { NgxSkeletonLoaderModule } from 'ngx-skeleton-loader';

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, IonIcon, MatButtonModule, NgxSkeletonLoaderModule],
  schemas: [CUSTOM_ELEMENTS_SCHEMA],
  selector: 'gf-value',
  styleUrls: ['./value.component.scss'],
  templateUrl: './value.component.html'
})
export class GfValueComponent implements AfterViewInit, OnChanges {
  @Input() colorizeSign = false;
  @Input() deviceType: string;
  @Input() enableCopyToClipboardButton = false;
  @Input() icon = '';
  @Input() isAbsolute = false;
  @Input() isCurrency = false;
  @Input() isDate = false;
  @Input() isPercent = false;
  @Input() locale: string;
  @Input() position = '';
  @Input() size: 'large' | 'medium' | 'small' = 'small';
  @Input() subLabel = '';
  @Input() unit = '';
  @Input() value: number | string = '';

  @ViewChild('labelContent', { static: false })
  labelContent!: ElementRef<HTMLSpanElement>;

  public absoluteValue = 0;
  public formattedValue = '';
  public hasLabel = false;
  public isNumber = false;
  public isString = false;
  public useAbsoluteValue = false;

  public constructor(
    private changeDetectorRef: ChangeDetectorRef,
    private clipboard: Clipboard,
    private snackBar: MatSnackBar
  ) {
    addIcons({
      copyOutline
    });
  }

  public readonly precision = input<number>();

  private readonly formatOptions = computed<Intl.NumberFormatOptions>(() => {
    const digits = this.hasPrecision ? this.precision() : 2;

    return {
      maximumFractionDigits: digits,
      minimumFractionDigits: digits
    };
  });

  private get hasPrecision() {
    const precision = this.precision();
    return precision !== undefined && precision >= 0;
  }

  public ngAfterViewInit() {
    if (this.labelContent) {
      const element = this.labelContent.nativeElement;

      this.hasLabel =
        element.children.length > 0 || element.textContent.trim().length > 0;

      this.changeDetectorRef.markForCheck();
    }
  }

  public ngOnChanges() {
    this.initializeVariables();

    if (this.value || this.value === 0) {
      if (isNumber(this.value)) {
        this.isNumber = true;
        this.isString = false;
        this.absoluteValue = Math.abs(this.value);

        if (this.colorizeSign) {
          if (this.isCurrency) {
            try {
              this.formattedValue = this.absoluteValue.toLocaleString(
                this.locale,
                this.formatOptions()
              );
            } catch {}
          } else if (this.isPercent) {
            try {
              this.formattedValue = (this.absoluteValue * 100).toLocaleString(
                this.locale,
                this.formatOptions()
              );
            } catch {}
          }
        } else if (this.isCurrency) {
          try {
            this.formattedValue = this.value?.toLocaleString(
              this.locale,
              this.formatOptions()
            );
          } catch {}
        } else if (this.isPercent) {
          try {
            this.formattedValue = (this.value * 100).toLocaleString(
              this.locale,
              this.formatOptions()
            );
          } catch {}
        } else if (this.hasPrecision) {
          try {
            this.formattedValue = this.value?.toLocaleString(
              this.locale,
              this.formatOptions()
            );
          } catch {}
        } else {
          this.formattedValue = this.value?.toLocaleString(this.locale);
        }

        if (this.isAbsolute) {
          // Remove algebraic sign
          this.formattedValue = this.formattedValue.replace(/^-/, '');
        }
      } else {
        this.isNumber = false;
        this.isString = true;

        if (this.isDate) {
          this.formattedValue = new Date(this.value).toLocaleDateString(
            this.locale,
            {
              day: '2-digit',
              month: '2-digit',
              year: this.deviceType === 'mobile' ? '2-digit' : 'numeric'
            }
          );
        } else {
          this.formattedValue = this.value;
        }
      }
    }

    this.useAbsoluteValue = this.roundsToDisplayedZero();
  }

  public onCopyValueToClipboard() {
    this.clipboard.copy(String(this.value));

    this.snackBar.open(
      '✅ ' + $localize`${this.value} has been copied to the clipboard`,
      undefined,
      {
        duration: ms('3 seconds')
      }
    );
  }

  private initializeVariables() {
    this.absoluteValue = 0;
    this.formattedValue = '';
    this.isNumber = false;
    this.isString = false;
    this.locale = this.locale || getLocale();
    this.useAbsoluteValue = false;
  }

  /**
   * Whether the number will be drawn as zero once rounded to the digits on screen.
   *
   * This decides whether the algebraic sign is drawn at all, and it has to be decided
   * from the number rather than from the text: a magnitude too small to survive rounding
   * is displayed as zero, and a zero carrying a sign in front of it is simply wrong.
   *
   * The test it replaces compared the rendered string against the literal `'0.00'`,
   * which held only for a two-digit value in a locale that separates decimals with a
   * full stop. It therefore missed every case this component is actually configured
   * for elsewhere: at `precision` 0 the same number renders `'0'`, at `precision` 4 it
   * renders `'0.0000'`, and in a locale using a decimal comma it renders `'0,00'` - so a
   * tiny loss came out as `-0`, `-0.0000` and `-0,00` respectively. The summary screen
   * reaches two of those three on its own, because it drops to `precision` 0 for large
   * totals on a phone and colourizes the sign of its percentage rows.
   *
   * Restricted to the two modes in which this component formats from the absolute value,
   * since those are the only ones where it - rather than `toLocaleString` - owns the
   * sign.
   *
   * @returns `true` when the sign must be suppressed.
   */
  private roundsToDisplayedZero() {
    if (!isNumber(this.value) || !(this.isCurrency || this.isPercent)) {
      return false;
    }

    // Read through the signal rather than through `hasPrecision`, so the narrowing
    // the compiler needs happens on the value that is actually used. The test is the
    // same one that getter applies.
    const precision = this.precision();
    const digits = precision !== undefined && precision >= 0 ? precision : 2;

    // Percentages are scaled before they are formatted, so the rounding has to be
    // judged against the scaled magnitude and not the stored fraction.
    const magnitude = Math.abs(this.isPercent ? this.value * 100 : this.value);

    return Math.round(magnitude * Math.pow(10, digits)) === 0;
  }
}
