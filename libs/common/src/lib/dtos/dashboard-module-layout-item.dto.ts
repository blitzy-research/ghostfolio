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
 * The per-field bounds cap each coordinate in isolation, which still admits
 * combinations the canvas cannot hold — `x: 11` with `cols: 12` spans columns 11
 * through 22 of a 12-column grid. Declared on `cols` and reading its siblings off
 * the validated object, which is how `class-validator` expresses a cross-field rule.
 *
 * Defers by returning `true` when any coordinate is not an integer, because the
 * per-field `@IsInt()` bounds already report that and a second error for the same
 * item would obscure it.
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

  // Not validated against the module vocabulary on purpose: a retired type in a
  // saved layout has to be droppable per item rather than fail the whole request.
  // The length cap is what stops one item carrying megabytes into storage.
  //
  // `\p{C}` excludes the Unicode "other" categories, several of which PostgreSQL
  // cannot represent inside a JSONB document - a NUL or a lone surrogate makes the
  // driver reject the statement with "unsupported Unicode escape sequence", which
  // would surface as a 500 despite the payload satisfying every other rule here.
  // Excluding them turns that into a field-level 400 and costs nothing legitimate,
  // because a module type is a lower-case kebab-case machine identifier.
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
