import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import 'reflect-metadata';

import { DashboardModuleType } from '../dashboard/enums/dashboard-module-type';
import { UpdateUserDashboardLayoutDto } from './update-user-dashboard-layout.dto';

/**
 * The envelope half of the layout write contract.
 *
 * `DashboardModuleLayoutItemDto` states what one item may be, and its own suite
 * covers that. What this suite covers is the claim the envelope makes about the
 * array: that every element reaching the handler *is* an item. Those are different
 * claims, and until the shape check existed only the first of them was true.
 *
 * `@ValidateNested({ each: true })` does not assert an element's shape - it
 * descends into the element and reports whatever the element's own validators
 * report. An element that is itself an empty array offers nothing to descend into,
 * so none of the item rules ran and `{"modules":[[]]}` was accepted with a 200 and
 * written to storage, even though `[null]`, `["x"]`, `[1]` and `[[1,2,3]]` were all
 * correctly refused - each of those does have something to descend into. The read
 * path drops a non-object entry, so no document was lost; but the boundary was not
 * a boundary, and every subsequent read of that row reported a dropped item. That
 * asymmetry is why the whole non-object *category* is swept here rather than one
 * representative of it: the case that escaped was the one nobody would think to
 * write down.
 *
 * Validated with the two options the API's global pipe is configured with, so what
 * these tests measure is what a request meets. `plainToInstance` is applied first
 * for the same reason: `@Type()` is what turns each entry into an item instance in
 * production, and validating a bare literal would skip the very transformation the
 * nested rules run against.
 */
describe('UpdateUserDashboardLayoutDto', () => {
  /** A module that satisfies every item-level rule, so only the envelope is under test. */
  const validItem = {
    cols: 4,
    moduleType: DashboardModuleType.HOLDINGS,
    rows: 4,
    x: 0,
    y: 0
  };

  const validate = (payload: Record<string, unknown>) => {
    return validateSync(
      plainToInstance(UpdateUserDashboardLayoutDto, payload),
      {
        forbidNonWhitelisted: true,
        whitelist: true
      }
    );
  };

  /**
   * The names of the constraints that failed on `modules`, sorted.
   *
   * Reported per constraint rather than per property because every rule on this
   * array reports the same property name, so the property alone could not tell a
   * shape failure from a size failure.
   */
  const failedConstraints = (payload: Record<string, unknown>) => {
    return validate(payload)
      .filter(({ property }) => property === 'modules')
      .flatMap(({ constraints }) => Object.keys(constraints ?? {}))
      .sort();
  };

  describe('the module list', () => {
    it('accepts a list of module entries', () => {
      expect(
        validate({
          modules: [
            validItem,
            {
              cols: 3,
              moduleType: DashboardModuleType.AI_CHAT,
              rows: 5,
              x: 4,
              y: 0
            }
          ],
          version: 1
        })
      ).toEqual([]);
    });

    it('accepts an empty list, which is a viewer with no modules rather than an error', () => {
      // The state of somebody who removed their last module. It has to be
      // writable, or the only way back to a blank canvas would be to leave the
      // last module behind.
      expect(validate({ modules: [], version: 1 })).toEqual([]);
    });

    it('rejects a payload that carries no module list at all', () => {
      expect(failedConstraints({ version: 1 })).toEqual([
        'arrayMaxSize',
        'isArray',
        'isObject'
      ]);
    });

    it('rejects a module list that is not an array', () => {
      expect(failedConstraints({ modules: { ...validItem } })).toContain(
        'isArray'
      );
    });

    it.each([
      { description: 'an empty array', entry: [] },
      { description: 'a populated array', entry: [1, 2, 3] },
      { description: 'null', entry: null },
      { description: 'a string', entry: 'holdings' },
      { description: 'a number', entry: 1 },
      { description: 'a boolean', entry: true }
    ])('rejects an entry that is $description', ({ entry }) => {
      // The empty array is the case that used to be accepted, and it sits in this
      // table beside the ones that never were on purpose: the rule being asserted
      // is about the category, not about the one member of it that escaped.
      expect(failedConstraints({ modules: [entry], version: 1 })).toContain(
        'isObject'
      );
    });

    it('rejects a list in which only one entry among valid ones is not an object', () => {
      // The mixed case is what a partially-corrupted client would send, and it is
      // where a per-element rule can differ from a whole-array one: the request is
      // refused rather than silently reduced to the entries that happened to be
      // well formed.
      expect(
        failedConstraints({
          modules: [validItem, [], validItem],
          version: 1
        })
      ).toContain('isObject');
    });

    it('names the offending property so the report is actionable', () => {
      const [error] = validate({ modules: [[]], version: 1 });

      expect(error.property).toBe('modules');
      expect(error.constraints?.isObject).toBe(
        'each value in modules must be an object'
      );
    });

    it('still reports an item that is an object but breaks an item rule', () => {
      // The shape check is added in front of the nested rules, not in place of
      // them: an object entry must still satisfy every field bound, and the error
      // has to arrive as a nested one so the message names the field rather than
      // the array.
      const [error] = validate({
        modules: [{ ...validItem, cols: 1 }],
        version: 1
      });

      const failedFields = (error.children ?? [])
        .flatMap((entry) => entry.children ?? [])
        .map(({ property }) => property)
        .sort();
      const failedFieldConstraints = (error.children ?? [])
        .flatMap((entry) => entry.children ?? [])
        .flatMap(({ constraints }) => Object.keys(constraints ?? {}))
        .sort();

      expect(error.property).toBe('modules');
      expect(error.constraints?.isObject).toBeUndefined();
      // Two fields report, and both belong: `cols` fails the grid-wide floor of
      // two, and `moduleType` fails the module's own declared minimum - that rule
      // is declared on `moduleType` precisely so its message can name the module
      // it is measuring, which a bound on `cols` could not.
      expect(failedFields).toEqual(['cols', 'moduleType']);
      expect(failedFieldConstraints).toEqual([
        'min',
        'satisfiesDashboardModuleMinimum'
      ]);
    });

    it('accepts the largest list the canvas can hold, and refuses one more', () => {
      // 300 is the canvas capacity - 1200 cells at four cells for the smallest
      // legal module - and without it the 10 MiB body allowance would be the only
      // ceiling on a single JSONB document.
      const fill = (count: number) => {
        return Array.from({ length: count }, () => ({ ...validItem }));
      };

      expect(validate({ modules: fill(300), version: 1 })).toEqual([]);
      expect(failedConstraints({ modules: fill(301), version: 1 })).toEqual([
        'arrayMaxSize'
      ]);
    });
  });

  describe('the version discriminator', () => {
    it('accepts a payload that omits it, because older clients legitimately do', () => {
      expect(validate({ modules: [validItem] })).toEqual([]);
    });

    it.each([
      { description: 'null', version: null },
      { description: 'a string', version: '1' },
      { description: 'zero', version: 0 },
      { description: 'a version this build cannot read', version: 2 }
    ])('rejects a version declared as $description', ({ version }) => {
      // Rejecting `null` is what `@ValidateIf` buys over `@IsOptional()`: an
      // explicit null used to be stored verbatim and then refused by the reader on
      // every subsequent request - a write that succeeded and a layout that could
      // never be read again.
      const failed = validate({ modules: [validItem], version })
        .filter(({ property }) => property === 'version')
        .flatMap(({ constraints }) => Object.keys(constraints ?? {}));

      expect(failed).toEqual(['isIn']);
    });
  });

  it('refuses a member it does not declare', () => {
    // The pipe is configured with `forbidNonWhitelisted`, so an unknown member is
    // an error rather than something quietly dropped. That is what keeps the
    // stored document to the two members the reader knows how to interpret.
    const failed = validateSync(
      plainToInstance(UpdateUserDashboardLayoutDto, {
        modules: [validItem],
        userId: 'a-different-user',
        version: 1
      }),
      { forbidNonWhitelisted: true, whitelist: true }
    );

    expect(failed.map(({ property }) => property)).toEqual(['userId']);
  });
});
