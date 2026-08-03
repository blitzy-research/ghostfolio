import {
  IsInt,
  IsNotEmpty,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  Validate,
  ValidationArguments,
  ValidatorConstraint,
  ValidatorConstraintInterface
} from 'class-validator';

/**
 * Rejects a grid item whose origin and span jointly overflow the canvas.
 *
 * The per-field bounds on `DashboardModuleLayoutItemDto` cap each coordinate in
 * isolation, which still admits combinations that cannot exist on the canvas —
 * `x: 11` with `cols: 12` would span columns 11 through 22 of a grid that is
 * only 12 columns wide. The grid is locked to a fixed 12-column width and a
 * 100-row ceiling, so this constraint closes that gap server-side, exactly as
 * the per-field minimums close the gap a hand-crafted request would otherwise
 * open. It is declared on `cols` and reads its siblings off the validated
 * object, which is how `class-validator` expresses a cross-field rule.
 *
 * When any of the four coordinates is not an integer the constraint defers by
 * returning `true`: the per-field `@IsInt()` bounds already report that failure,
 * and a second error for the same malformed item would only obscure it.
 */
@ValidatorConstraint({ name: 'isWithinDashboardGrid' })
export class IsWithinDashboardGridConstraint implements ValidatorConstraintInterface {
  public defaultMessage() {
    return 'module must fit the 12 x 100 grid (x + cols must not exceed 12 and y + rows must not exceed 100)';
  }

  public validate(aCols: number, validationArguments: ValidationArguments) {
    const { rows, x, y } =
      validationArguments.object as DashboardModuleLayoutItemDto;

    if (
      !Number.isInteger(aCols) ||
      !Number.isInteger(rows) ||
      !Number.isInteger(x) ||
      !Number.isInteger(y)
    ) {
      return true;
    }

    return x + aCols <= 12 && y + rows <= 100;
  }
}

export class DashboardModuleLayoutItemDto {
  @IsInt()
  @Max(12)
  @Min(2)
  @Validate(IsWithinDashboardGridConstraint)
  cols: number;

  // Deliberately an opaque, unvalidated-by-vocabulary string: the module
  // registry is the only mechanism that introduces module types, and a retired
  // type in a saved layout has to be droppable per item rather than failing the
  // whole request. It is still bounded, because an unbounded string would let a
  // single item carry megabytes into persistent storage. 64 characters leaves
  // ample headroom over the longest shipped type (18 characters).
  //
  // Opaque stops short of unstorable, though. `\p{C}` covers the Unicode "other"
  // categories - control, format, surrogate, private use and unassigned - and
  // PostgreSQL cannot represent several of them inside a JSONB document: a NUL
  // (U+0000) or a lone surrogate makes the driver reject the whole statement
  // with "unsupported Unicode escape sequence", which surfaces as a 500 even
  // though the payload satisfies every other rule declared here. Excluding them
  // turns that into a field-level 400 like every sibling case, and costs nothing
  // legitimate: a module type is a machine identifier, and every shipped one is
  // lower-case kebab-case ASCII.
  @IsNotEmpty()
  @IsString()
  @Matches(/^[^\p{C}]+$/u, {
    message: 'moduleType must not contain control characters'
  })
  @MaxLength(64)
  moduleType: string;

  @IsInt()
  @Max(100)
  @Min(2)
  rows: number;

  @IsInt()
  @Max(11)
  @Min(0)
  x: number;

  @IsInt()
  @Max(99)
  @Min(0)
  y: number;
}
