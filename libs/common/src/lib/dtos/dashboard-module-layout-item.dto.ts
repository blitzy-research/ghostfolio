import { getDashboardModule } from '@ghostfolio/common/dashboard';

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

/**
 * Rejects a grid item smaller than the footprint its own module declares.
 *
 * The per-field `@Min(2)` bounds below are the *global* floor, which every module
 * shares, and they are all this request used to be measured against. Individual
 * modules declare stricter minimums in the shared metadata — the AI chat module
 * needs three columns by five rows, the analysis module six by six — and those
 * minimums are what the grid engine enforces on screen through
 * `itemValidateCallback`. Enforcing them only on screen left the wire open: a
 * hand-written request could store the AI chat module at two by two, and a client
 * hydrating that document would draw a module at a size the engine would never
 * have let a person resize it to. This constraint closes that gap, so the declared
 * minimum is enforced end to end rather than in the browser alone.
 *
 * Declared on `moduleType` because the module is what determines the minimum, and
 * because the resulting message can then name it — "'ai-chat' requires at least 3
 * columns by 5 rows" is actionable in a way that a bare bound on `cols` is not.
 *
 * Two cases defer by returning `true`, and both are deliberate:
 *
 * - **An unknown discriminator.** There is no metadata to measure it against, and
 *   failing the whole request would make a layout containing a withdrawn module
 *   unwritable. Such an entry is dropped per item when the layout is read, which
 *   is the behaviour the surrounding class documents for a retired type.
 * - **A non-integer dimension.** `@IsInt()` on `cols` and `rows` already reports
 *   that, and a second error about the same item would bury it.
 */
@ValidatorConstraint({ name: 'satisfiesDashboardModuleMinimum' })
export class SatisfiesDashboardModuleMinimumConstraint implements ValidatorConstraintInterface {
  public defaultMessage(validationArguments: ValidationArguments) {
    const { moduleType } =
      validationArguments.object as DashboardModuleLayoutItemDto;

    const dashboardModule = getDashboardModule(moduleType);

    return dashboardModule
      ? `module '${moduleType}' requires at least ${dashboardModule.minItemCols} columns by ${dashboardModule.minItemRows} rows`
      : 'module is smaller than its declared minimum';
  }

  public validate(
    aModuleType: string,
    validationArguments: ValidationArguments
  ) {
    const { cols, rows } =
      validationArguments.object as DashboardModuleLayoutItemDto;

    const dashboardModule = getDashboardModule(aModuleType);

    if (!dashboardModule) {
      return true;
    }

    if (!Number.isInteger(cols) || !Number.isInteger(rows)) {
      return true;
    }

    return (
      cols >= dashboardModule.minItemCols && rows >= dashboardModule.minItemRows
    );
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
  @Validate(SatisfiesDashboardModuleMinimumConstraint)
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
