import { FocusMonitor } from '@angular/cdk/a11y';
import { coerceBooleanProperty } from '@angular/cdk/coercion';
import {
  Component,
  DoCheck,
  ElementRef,
  HostBinding,
  HostListener,
  Input,
  OnDestroy
} from '@angular/core';
import { ControlValueAccessor, NgControl, Validators } from '@angular/forms';
import { MatFormFieldControl } from '@angular/material/form-field';
import { Subject } from 'rxjs';

@Component({
  template: '',
  standalone: false
})
export abstract class AbstractMatFormField<T>
  implements ControlValueAccessor, DoCheck, MatFormFieldControl<T>, OnDestroy
{
  /**
   * The identifier `mat-form-field` points its `<label for>` at.
   *
   * Deliberately NOT host-bound, and that is the fix for a whole class of unnamed
   * fields. `mat-form-field` renders `<label [attr.for]="control.id">`, and `for` only
   * associates with a LABELABLE element - an input, select, textarea, button. While this
   * sat on the host it named `<gf-symbol-autocomplete>`, a custom element, which is not
   * labelable: the association failed silently, and the inner input a viewer actually
   * focused had no accessible name at all. Nothing pointed at the failure because the
   * label still rendered and still looked right.
   *
   * Each subclass now puts this on its own inner control with `[id]="id"`, so `for`
   * resolves to a real labelable element. Native label behaviour comes back with it:
   * clicking the label focuses the field, and the accessible name is the visible one
   * rather than a duplicate stated in ARIA.
   */
  public id = `${this.controlType}-${AbstractMatFormField.nextId++}`;

  @HostBinding('attr.aria-describedBy') public describedBy = '';

  public readonly autofilled: boolean;
  public errorState: boolean;
  public focused = false;
  public readonly stateChanges = new Subject<void>();
  public readonly userAriaDescribedBy: string;

  protected onChange?: (value: T) => void;
  protected onTouched?: () => void;

  private static nextId = 0;

  protected constructor(
    protected _elementRef: ElementRef<HTMLElement>,
    protected _focusMonitor: FocusMonitor,
    public readonly ngControl: NgControl
  ) {
    if (this.ngControl) {
      this.ngControl.valueAccessor = this;
    }

    _focusMonitor
      .monitor(this._elementRef.nativeElement, true)
      .subscribe((origin) => {
        this.focused = !!origin;
        this.stateChanges.next();
      });
  }

  private _controlType: string;

  public get controlType(): string {
    return this._controlType;
  }

  protected set controlType(value: string) {
    this._controlType = value;
    this.id = `${this._controlType}-${AbstractMatFormField.nextId++}`;
  }

  private _value: T;

  public get value(): T {
    return this._value;
  }

  public set value(value: T) {
    this._value = value;

    if (this.onChange) {
      this.onChange(value);
    }
  }

  public get empty(): boolean {
    return !this._value;
  }

  public _placeholder = '';

  public get placeholder() {
    return this._placeholder;
  }

  @Input()
  public set placeholder(placeholder: string) {
    this._placeholder = placeholder;
    this.stateChanges.next();
  }

  public _required = false;

  public get required() {
    return (
      this._required ||
      this.ngControl.control?.hasValidator(Validators.required)
    );
  }

  @Input()
  public set required(required: any) {
    this._required = coerceBooleanProperty(required);
    this.stateChanges.next();
  }

  public _disabled = false;

  public get disabled() {
    if (this.ngControl?.disabled !== null) {
      return this.ngControl.disabled;
    }

    return this._disabled;
  }

  @Input()
  public set disabled(disabled: any) {
    this._disabled = coerceBooleanProperty(disabled);

    if (this.focused) {
      this.focused = false;
      this.stateChanges.next();
    }
  }

  public abstract focus(): void;

  /**
   * Adopts the value the model already holds, without reporting it as a user edit.
   *
   * Assigning `value` runs the `onChange` callback, which is how a real edit reaches the
   * outer form - and Angular treats that callback as evidence of interaction, so it marks
   * the bound control DIRTY. That is correct for a keystroke and wrong for initialisation,
   * and these controls initialise themselves: each reads the value out of its parent form
   * during `ngOnInit`, which meant every form containing one was born dirty before the
   * viewer had touched anything.
   *
   * The consequence was not theoretical. The unsaved-changes guard asks whether a form has
   * been edited before letting a dismissal through, so a dialog holding a currency
   * selector interrogated the viewer on the way out of a form they had never typed in -
   * measured at runtime as `ng-dirty` alongside `ng-untouched`, with the currency control
   * the only dirty one in the group.
   *
   * Dirtiness is restored rather than blanket-cleared, so a control that was ALREADY dirty
   * when this runs stays dirty: the guarantee is that adopting a value changes nothing
   * about whether the form has been edited, in either direction.
   */
  protected adoptModelValue(value: T) {
    const control = this.ngControl?.control;
    const wasPristine = control?.pristine ?? true;

    this.value = value;

    if (wasPristine) {
      control?.markAsPristine();
    }
  }

  public get shouldLabelFloat(): boolean {
    return this.focused || !this.empty;
  }

  public ngDoCheck() {
    if (this.ngControl) {
      this.errorState = !!(this.ngControl.invalid && this.ngControl.touched);
      this.stateChanges.next();
    }
  }

  public ngOnDestroy() {
    this.stateChanges.complete();
    this._focusMonitor.stopMonitoring(this._elementRef.nativeElement);
  }

  public registerOnChange(fn: (_: T) => void) {
    this.onChange = fn;
  }

  public registerOnTouched(fn: () => void) {
    this.onTouched = fn;
  }

  public setDescribedByIds(ids: string[]) {
    this.describedBy = ids.join(' ');
  }

  /**
   * Receives a value FROM the model, which by the `ControlValueAccessor` contract is the
   * one direction that must never report a change back.
   *
   * Angular calls this while binding the control and again whenever the model is set
   * programmatically. It used to assign `value` directly, and that runs `onChange` - the
   * view-to-model callback - so the framework recorded an edit for a value it had just
   * handed in itself, and every form opened on existing data was dirty before the viewer
   * arrived. An edit dialog therefore looked exactly like an edited one.
   */
  public writeValue(value: T) {
    this.adoptModelValue(value);
  }

  @HostListener('focusout')
  public onBlur() {
    this.focused = false;

    if (this.onTouched) {
      this.onTouched();
    }

    this.stateChanges.next();
  }

  public onContainerClick() {
    if (!this.focused) {
      this.focus();
    }
  }
}
