import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

describe('the global theme contrast overrides', () => {
  const membershipCardStyles = readFileSync(
    join(
      __dirname,
      '../../../libs/ui/src/lib/membership-card/membership-card.component.scss'
    ),
    'utf8'
  );
  const styles = readFileSync(join(__dirname, 'styles.scss'), 'utf8');

  it('uses the high-contrast primary label colour in both themes', () => {
    // Both themes fill these containers with the brand primary, which is a LIGHT
    // teal in each of them, so both need the palette's dark contrast colour. The
    // two rules are spelled differently on purpose: the light-theme one goes
    // through the Material system token with the palette value as its fallback,
    // which is the form the design-system rule prescribes for anything new, while
    // the dark-theme rule predates it and states the palette value directly.
    expect(
      styles.match(
        /color: var\(--mat-sys-on-primary, rgba\(var\(--dark-primary-text\)\)\) !important;/g
      )
    ).toHaveLength(1);
    expect(
      styles.match(/color: rgba\(var\(--dark-primary-text\)\) !important;/g)
    ).toHaveLength(1);

    // The inversion this replaced: `--light-primary-text` is pure white, which on
    // light teal measured 1.92:1.
    expect(styles).not.toContain(
      'color: rgba(var(--light-primary-text)) !important;'
    );
  });

  it('makes muted text theme-aware only inside the dark theme', () => {
    const darkThemeStart = styles.indexOf('&.theme-dark {');
    const mutedTextOverride = styles.indexOf('.text-muted {');

    expect(darkThemeStart).toBeGreaterThan(-1);
    expect(mutedTextOverride).toBeGreaterThan(darkThemeStart);
    expect(
      styles.match(/color: rgba\(var\(--light-secondary-text\)\) !important;/g)
    ).toHaveLength(1);
    expect(styles.match(/\.text-muted\s*\{/g)).toHaveLength(1);
  });

  it('keeps muted labels readable on a light membership card in dark mode', () => {
    expect(membershipCardStyles).toContain(':host-context(.theme-dark)');
    expect(membershipCardStyles).toMatch(
      /\.card-container:not\(\.premium\)[\s\S]*?\.text-muted\s*\{[\s\S]*?color: rgba\(var\(--dark-secondary-text\)\) !important;/
    );
  });
});

/**
 * The design-system rule for the grid chrome, asserted over its source.
 *
 * Every Material Design 3 value in the canvas, the module chrome, the resize
 * handle, the drop indicator, the catalog and the toolbar must be written as
 * `var(--mat-sys-<token>, <fallback>)`. The fallback half is not belt and braces
 * here - it is the half that paints. This application themes through
 * `mat.define-theme()` + `mat.all-component-themes()`, which emits hundreds of
 * component-level `--mat-*` custom properties and essentially no `--mat-sys-*`
 * ones, so a bare `var(--mat-sys-surface-container)` resolves to nothing and the
 * whole declaration is dropped. A module header would lose its background, the
 * resize handle its ink, the drop indicator its fill - silently, because an
 * invalid custom-property reference is not an error anywhere.
 *
 * The mirror-image failure is a value written directly. That compiles, paints and
 * looks right today, and stops tracking the theme forever: it is how the chrome
 * drifts out of the design system one declaration at a time.
 *
 * Neither failure is visible to a compiler, a linter or a rendering test - a
 * dropped declaration and an off-token colour both produce a page that renders.
 * Reading the source is the only mechanical guard, so that is what this does, over
 * every chrome stylesheet discovered rather than listed.
 */
describe('the grid chrome design-token contract', () => {
  /** `apps/client/src`, resolved from this spec's own location. */
  const clientSourceDirectory = __dirname;

  const dashboardDirectory = join(clientSourceDirectory, 'app', 'dashboard');

  /**
   * The global partial plus every stylesheet in the dashboard tree.
   *
   * The partial is global by necessity rather than by choice: all three
   * `angular-gridster2` components declare `ViewEncapsulation.None` and inject
   * hardcoded colours of their own, so an encapsulated stylesheet cannot reach
   * them. It is therefore as much "grid chrome" as any component stylesheet and is
   * held to the same rule.
   */
  const chromeStylesheets = [
    join('styles', 'gridster.scss'),
    ...readdirSync(dashboardDirectory, { recursive: true })
      .map(String)
      .filter((entry) => entry.endsWith('.scss'))
      .map((entry) => join('app', 'dashboard', entry))
  ].sort();

  const readChrome = (aRelativePath: string) => {
    return readFileSync(join(clientSourceDirectory, aRelativePath), 'utf8');
  };

  /**
   * The source with its comments removed.
   *
   * These stylesheets carry long explanations that name colours and tokens in
   * prose, so scanning the raw text reports the explanation as the offence. `//`
   * is only treated as a comment when the character before it is neither a colon
   * nor a quote, so a `https://` inside a string is left alone.
   */
  const withoutComments = (aSource: string) => {
    return aSource
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/(^|[^:'"])\/\/[^\n]*/gm, '$1 ');
  };

  /**
   * The `[start, end)` span of every `var(...)` call, outermost first.
   *
   * Found by matching parentheses rather than by regex, because a fallback is
   * routinely another function - `rgba(0, 0, 0, 0.12)`, `min(...)`, a nested
   * `var(...)` - and a non-greedy pattern stops at the first `)` inside it. The
   * gridster partial additionally wraps long declarations across several lines, so
   * the span has to be newline-agnostic.
   */
  const varSpans = (aSource: string) => {
    const spans: [number, number][] = [];
    const opening = /\bvar\(/g;

    let match: RegExpExecArray;

    while ((match = opening.exec(aSource))) {
      const open = match.index + match[0].length - 1;

      let depth = 0;
      let end = -1;

      for (let index = open; index < aSource.length; index += 1) {
        if (aSource[index] === '(') {
          depth += 1;
        } else if (aSource[index] === ')') {
          depth -= 1;

          if (depth === 0) {
            end = index;
            break;
          }
        }
      }

      if (end === -1) {
        break;
      }

      spans.push([match.index, end + 1]);
      opening.lastIndex = end + 1;
    }

    return spans;
  };

  /** Every Material system token referenced, with the fallback it was given. */
  const systemTokenReferences = (aSource: string) => {
    return varSpans(aSource)
      .map(([start, end]) => aSource.slice(start, end))
      .map((text) => {
        const inner = text.slice('var('.length, -1);
        const token = /^\s*(--[a-z0-9-]+)/.exec(inner)?.[1];

        let depth = 0;
        let separator = -1;

        for (let index = 0; index < inner.length; index += 1) {
          if (inner[index] === '(') {
            depth += 1;
          } else if (inner[index] === ')') {
            depth -= 1;
          } else if (inner[index] === ',' && depth === 0) {
            separator = index;
            break;
          }
        }

        return {
          fallback: separator === -1 ? '' : inner.slice(separator + 1).trim(),
          token
        };
      })
      .filter(({ token }) => token?.startsWith('--mat-sys-'));
  };

  /**
   * The source with every `var(...)` call removed.
   *
   * Removing them is what leaves the *declared* values behind: a colour inside a
   * `var(...)` is a sanctioned fallback, and a colour outside one is a hardcoded
   * value. Repeated until nothing changes, so a fallback that itself contains a
   * `var(...)` is removed with its parent.
   */
  const withoutVarCalls = (aSource: string) => {
    let source = aSource;
    let spans = varSpans(source);

    while (spans.length > 0) {
      for (let index = spans.length - 1; index >= 0; index -= 1) {
        source = `${source.slice(0, spans[index][0])} ${source.slice(
          spans[index][1]
        )}`;
      }

      spans = varSpans(source);
    }

    return source;
  };

  /**
   * Colour literals in any form CSS accepts one.
   *
   * `(?!-)` after the keyword group is load-bearing: without it `white-space`
   * reports as the colour `white`, which it is not, in four of these files.
   * `transparent`, `currentColor`, `inherit`, `none` and `0` are deliberately
   * absent - the design-system rule names them as the permitted exceptions.
   */
  const colourLiteral =
    /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(|\b(?:aqua|black|blue|fuchsia|gray|grey|green|lime|maroon|navy|olive|orange|purple|red|silver|teal|white|yellow)\b(?!-)/g;

  const declaredColoursIn = (aSource: string) => {
    return [
      ...withoutVarCalls(withoutComments(aSource)).matchAll(colourLiteral)
    ].map(([literal]) => literal);
  };

  it('scans the whole of the chrome the rule governs', () => {
    // A silently empty or shrinking file list would pass every assertion below
    // while checking nothing, so the discovery itself is asserted - and it is a
    // discovery rather than a list precisely so a stylesheet added tomorrow is
    // covered without anyone remembering to add it here.
    expect(chromeStylesheets).toContain(join('styles', 'gridster.scss'));

    for (const chrome of [
      join('dashboard-canvas', 'dashboard-canvas.scss'),
      join(
        'dashboard-canvas',
        'dashboard-module-host',
        'dashboard-module-host.scss'
      ),
      join('dashboard-canvas', 'dashboard-toolbar', 'dashboard-toolbar.scss'),
      join('dashboard-canvas', 'empty-canvas-state', 'empty-canvas-state.scss'),
      join('dashboard-canvas', 'sign-in-prompt', 'sign-in-prompt.scss'),
      join('module-catalog', 'module-catalog.scss'),
      join('module-catalog', 'module-catalog-item', 'module-catalog-item.scss')
    ]) {
      expect(chromeStylesheets).toContain(join('app', 'dashboard', chrome));
    }

    expect(chromeStylesheets.length).toBeGreaterThanOrEqual(18);
  });

  it.each(chromeStylesheets)(
    '%s gives every Material system token a fallback',
    (stylesheet) => {
      const references = systemTokenReferences(readChrome(stylesheet));

      // Reported as the offending token names rather than as a count, so a failure
      // says which declaration would have been dropped.
      expect(
        references.filter(({ fallback }) => !fallback).map(({ token }) => token)
      ).toEqual([]);
    }
  );

  it.each(chromeStylesheets)(
    '%s declares no colour of its own outside a token reference',
    (stylesheet) => {
      expect(declaredColoursIn(readChrome(stylesheet))).toEqual([]);
    }
  );

  it('reads the system tokens it is asserting over', () => {
    // The two assertions above are absence assertions over a parser, and a parser
    // that matched nothing would satisfy both. This is what keeps them meaningful:
    // the chrome really is tokenised, in volume, and the scan really does see it.
    const found = chromeStylesheets.flatMap((stylesheet) => {
      return systemTokenReferences(readChrome(stylesheet)).map(
        ({ token }) => token
      );
    });

    expect(found.length).toBeGreaterThan(100);
    expect(new Set(found).size).toBeGreaterThan(5);
    expect(found).toContain('--mat-sys-surface-container');
  });

  it('detects a bare token and a hardcoded colour when they are present', () => {
    // The positive control for the parser itself, over the two exact shapes the
    // rule forbids - including the multi-line form the gridster partial uses,
    // which a non-greedy pattern would mis-parse.
    const offending = [
      'gridster-item {',
      '  background: var(--mat-sys-surface-container);',
      '  border-color: #cccccc;',
      '  box-shadow: var(',
      '    --mat-sys-level3',
      '  );',
      '}'
    ].join('\n');

    expect(
      systemTokenReferences(offending)
        .filter(({ fallback }) => !fallback)
        .map(({ token }) => token)
    ).toEqual(['--mat-sys-surface-container', '--mat-sys-level3']);
    expect(declaredColoursIn(offending)).toEqual(['#cccccc']);

    // And the compliant form of the same two declarations is accepted, so the
    // parser is not simply rejecting everything.
    const compliant = [
      'gridster-item {',
      '  background: var(--mat-sys-surface-container, #ffffff);',
      '  box-shadow: var(',
      '    --mat-sys-level3,',
      '    0 6px 10px rgba(0, 0, 0, 0.14)',
      '  );',
      '  white-space: nowrap;',
      '}'
    ].join('\n');

    expect(
      systemTokenReferences(compliant).filter(({ fallback }) => !fallback)
    ).toEqual([]);
    expect(declaredColoursIn(compliant)).toEqual([]);
  });

  it('ignores a custom property this application declares itself', () => {
    // The rule is about Material's system-token layer, which this theme does not
    // populate. A stylesheet's own `--gf-*` property is declared in the same file,
    // so a fallback would be meaningless - and the canvas genuinely uses several
    // to share a measurement between rules.
    const local = [
      ':host {',
      '  --gf-dashboard-catalog-width: 22rem;',
      '  width: var(--gf-dashboard-catalog-width);',
      '}'
    ].join('\n');

    expect(systemTokenReferences(local)).toEqual([]);
    expect(declaredColoursIn(local)).toEqual([]);
  });
});
