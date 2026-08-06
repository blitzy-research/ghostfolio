import { readFileSync } from 'node:fs';
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
