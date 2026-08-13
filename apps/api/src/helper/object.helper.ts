import fastRedact from 'fast-redact';
import { JSONPath } from 'jsonpath-plus';
import { cloneDeep, isObject } from 'lodash';

export function hasNotDefinedValuesInObject(aObject: Object): boolean {
  for (const key in aObject) {
    if (aObject[key] === null || aObject[key] === undefined) {
      return true;
    } else if (isObject(aObject[key])) {
      return hasNotDefinedValuesInObject(aObject[key]);
    }
  }

  return false;
}

export function nullifyValuesInObject<T>(aObject: T, keys: string[]): T {
  const object = cloneDeep(aObject);

  if (object) {
    keys.forEach((key) => {
      object[key] = null;
    });
  }

  return object;
}

export function nullifyValuesInObjects<T>(aObjects: T[], keys: string[]): T[] {
  return aObjects.map((object) => {
    return nullifyValuesInObject(object, keys);
  });
}

/**
 * Evaluates a JSONPath expression against an object and returns every match.
 *
 * The expression is operator-supplied - it is the `selector` of a scraper
 * configuration - so the engine that interprets it is part of this function's
 * security surface, not an implementation detail. Two properties of the engine
 * used here are relied upon and are the reason it is the one used:
 *
 * - Filter and script expressions are evaluated by its own JSEP-based
 *   evaluator, the `'safe'` default, rather than by `eval` or `vm`. A selector
 *   can therefore describe a traversal and cannot reach the process.
 * - It carries no transitive dependency on the abandoned `underscore` chain,
 *   whose unbounded recursion in `_.flatten`/`_.isEqual` has no fixed release.
 *
 * `wrap: false` is deliberately NOT set: callers index into the result, so the
 * return value has to stay an array of matches even when there is exactly one -
 * which is the shape the previous engine returned and the shape the caller in
 * the manual data provider reads `[0]` from.
 *
 * @param object the parsed document to search, typically a provider's JSON
 * response.
 * @param pathExpression the JSONPath expression, for example `$.market.price`.
 * @returns every value the expression matched, in document order. Empty when
 * nothing matched, so a caller reading `[0]` gets `undefined` rather than an
 * exception.
 */
export function query({
  object,
  pathExpression
}: {
  object: object;
  pathExpression: string;
}) {
  return JSONPath({ json: object, path: pathExpression }) as unknown[];
}

export function redactPaths({
  object,
  paths,
  valueMap
}: {
  object: any;
  paths: fastRedact.RedactOptions['paths'];
  valueMap?: { [key: string]: any };
}): any {
  const redact = fastRedact({
    paths,
    censor: (value) => {
      if (valueMap) {
        if (valueMap[value]) {
          return valueMap[value];
        } else {
          return value;
        }
      } else {
        return null;
      }
    }
  });

  return JSON.parse(redact(object));
}
