import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import 'reflect-metadata';

import { dashboardModules } from '../dashboard';
import { DashboardModuleType } from '../dashboard/enums/dashboard-module-type';
import { DashboardModuleLayoutItemDto } from './dashboard-module-layout-item.dto';

/**
 * The write-side half of the declared-minimum rule.
 *
 * The grid engine enforces each module's declared footprint on screen, for every
 * resize and every drop. That leaves the wire, and the wire is what a document
 * reaches persistent storage through: a request built by hand can name any
 * footprint that clears the grid-wide floor, and until this constraint existed a
 * module could be stored at a size no person could have resized it to. Asserting
 * it here rather than only through the controller keeps the rule testable without
 * a Nest application, and pins which property carries the failure - the message an
 * operator reads names the module, which a bound on `cols` could not.
 */
describe('DashboardModuleLayoutItemDto', () => {
  const validate = (item: Record<string, unknown>) => {
    return validateSync(plainToInstance(DashboardModuleLayoutItemDto, item), {
      forbidNonWhitelisted: true,
      whitelist: true
    });
  };

  const failedProperties = (item: Record<string, unknown>) => {
    return validate(item)
      .map(({ property }) => property)
      .sort();
  };

  it('accepts a known module sized exactly to its own declared minimum', () => {
    for (const { minItemCols, minItemRows, moduleType } of Object.values(
      dashboardModules
    )) {
      expect(
        validate({
          moduleType,
          cols: minItemCols,
          rows: minItemRows,
          x: 0,
          y: 0
        })
      ).toEqual([]);
    }
  });

  it.each([
    { dimension: 'cols' as const, other: 'rows' as const },
    { dimension: 'rows' as const, other: 'cols' as const }
  ])(
    'rejects a known module one $dimension short of its declared minimum',
    ({ dimension, other }) => {
      // The AI chat module carries the strictest minimum in the catalog, so one
      // cell inside it is still comfortably clear of the grid-wide floor of two -
      // which is exactly the gap this rule closes.
      const { minItemCols, minItemRows } =
        dashboardModules[DashboardModuleType.AI_CHAT];

      const minimums = { cols: minItemCols, rows: minItemRows };

      const errors = validate({
        moduleType: DashboardModuleType.AI_CHAT,
        x: 0,
        y: 0,
        [dimension]: minimums[dimension] - 1,
        [other]: minimums[other]
      });

      expect(minimums[dimension] - 1).toBeGreaterThanOrEqual(2);
      expect(errors.map(({ property }) => property)).toEqual(['moduleType']);
      // `constraints` is optional on a validation error, so an absent map has to
      // read as an empty one rather than throwing - the assertion below still
      // fails loudly in that case, because an empty map cannot name the module.
      expect(Object.values(errors[0].constraints ?? {}).join(' ')).toContain(
        DashboardModuleType.AI_CHAT
      );
    }
  );

  it('defers on a discriminator it has no metadata for, so a withdrawn module stays writable', () => {
    // There is nothing to measure an unknown module against, and failing the
    // request would make an arrangement containing a module that has since been
    // withdrawn unwritable. Such an entry is dropped per item when the layout is
    // read instead.
    expect(
      validate({
        cols: 2,
        moduleType: 'some-future-module',
        rows: 2,
        x: 0,
        y: 0
      })
    ).toEqual([]);
  });

  it('defers to the integer bounds rather than reporting the same item twice', () => {
    // `@IsInt()` already reports a non-integer dimension. A second error about the
    // declared minimum for the same item would bury the one that explains it.
    expect(
      failedProperties({
        cols: 2.5,
        moduleType: DashboardModuleType.AI_CHAT,
        rows: 5,
        x: 0,
        y: 0
      })
    ).toEqual(['cols']);
  });

  it('still enforces the grid-wide floor and the grid extent', () => {
    expect(
      failedProperties({
        cols: 1,
        moduleType: 'some-future-module',
        rows: 2,
        x: 0,
        y: 0
      })
    ).toEqual(['cols']);

    // Every per-field bound is satisfied and the placement is still impossible,
    // because origin and span together run past the twelfth column.
    expect(
      failedProperties({
        cols: 2,
        moduleType: 'some-future-module',
        rows: 2,
        x: 11,
        y: 0
      })
    ).toEqual(['cols']);
  });
});
