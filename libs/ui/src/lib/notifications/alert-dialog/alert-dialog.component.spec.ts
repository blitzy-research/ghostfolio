import { ComponentFixture, TestBed } from '@angular/core/testing';
import { MatDialogRef } from '@angular/material/dialog';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { GfAlertDialogComponent } from './alert-dialog.component';

/**
 * The dialog every part of the application uses to say something went wrong, or to show
 * a value the viewer asked to see.
 *
 * Two things about it are load-bearing rather than cosmetic, and both follow from the
 * content being arbitrary: an account note somebody typed, a queue job's serialised stack
 * trace, a provider's error body.
 *
 * It must render that content as TEXT. A note containing `<img onerror=…>` was being
 * inserted as HTML, which made a value the viewer had stored into markup the browser
 * would execute.
 *
 * And it must stay reachable. Material sizes a dialog to its content, so a long stack
 * trace grew the surface past two thousand pixels and pushed the only control that closes
 * it off the bottom of the viewport, where a pointer cannot get to it. Bounding the
 * content and letting it scroll inside is what keeps the action row on screen at every
 * content length.
 *
 * The bounds are asserted against the stylesheet rather than against computed style
 * because they are expressed in `svh`, which jsdom does not resolve - the rendered
 * behaviour is checked in a browser instead. What a test CAN pin here is that the bound
 * exists, that it is viewport-relative, and that the element carrying it is the one that
 * scrolls.
 */
describe('GfAlertDialogComponent', () => {
  let component: GfAlertDialogComponent;
  let fixture: ComponentFixture<GfAlertDialogComponent>;
  let close: jest.Mock;

  /** The stylesheet as text, resolved from this spec's own location. */
  const stylesheet = readFileSync(join(__dirname, 'alert-dialog.scss'), 'utf8');

  /** A stack trace of the order that made the dialog unusable. */
  const createLongMessage = () => {
    return Array.from({ length: 400 }, (_unused, index) => {
      return `    at someFrame${index} (/app/dist/apps/api/main.js:${index}:17)`;
    }).join('\n');
  };

  const createComponent = async () => {
    close = jest.fn();

    TestBed.resetTestingModule();

    await TestBed.configureTestingModule({
      imports: [GfAlertDialogComponent],
      providers: [
        provideNoopAnimations(),
        { provide: MatDialogRef, useValue: { close } }
      ]
    }).compileComponents();

    fixture = TestBed.createComponent(GfAlertDialogComponent);
    component = fixture.componentInstance;

    return component;
  };

  const content = () => {
    return fixture.nativeElement.querySelector('[mat-dialog-content]');
  };

  describe('showing a long stack trace', () => {
    beforeEach(async () => {
      await createComponent();

      component.initialize({
        discardLabel: 'Close',
        message: createLongMessage(),
        title: 'Stacktrace'
      });

      fixture.detectChanges();
    });

    it('keeps the trace out of the heading', () => {
      // The trace used to BE the heading, which is what grew the dialog: a heading has
      // no scroll region and Material gives it none.
      expect(
        fixture.nativeElement.querySelector('[mat-dialog-title]').textContent
      ).toBe('Stacktrace');
      expect(content().textContent).toContain('someFrame399');
    });

    it('keeps the control that closes it', () => {
      const button = fixture.nativeElement.querySelector(
        '[mat-dialog-actions] button'
      );

      expect(button.textContent.trim()).toBe('Close');

      button.click();

      expect(close).toHaveBeenCalled();
    });

    it('renders the trace as text, not as markup', async () => {
      await createComponent();

      component.initialize({
        discardLabel: 'Close',
        message: '<img src="x" onerror="window.__alertDialogXss = true">',
        title: 'Data'
      });

      fixture.detectChanges();

      // The payload is visible as characters and there is no element to fire an error
      // handler, which is the whole distinction between showing a value and running it.
      expect(content().querySelector('img')).toBeNull();
      expect(content().textContent).toContain('onerror=');
      expect(
        (window as unknown as { __alertDialogXss?: boolean }).__alertDialogXss
      ).toBeUndefined();
    });
  });

  describe('the height bound', () => {
    it('bounds the content region rather than the dialog', () => {
      // Bounding the dialog would clip the actions with it. Bounding the content is
      // what leaves them on screen.
      expect(stylesheet).toContain('[mat-dialog-content].gf-notification-text');
      expect(stylesheet).toMatch(/max-height:\s*60svh/);
    });

    it('is viewport-relative, so it holds on a short window too', () => {
      // A pixel bound tuned to a tall window is exactly how the control ends up
      // off-screen on a laptop.
      expect(stylesheet).not.toMatch(/max-height:\s*\d+px/);
    });

    it('lets the bounded region scroll', () => {
      // A bound without a scroll region does not shorten the dialog, it hides the end
      // of the content.
      expect(stylesheet).toMatch(/overflow:\s*auto/);
    });

    it('bounds the heading as well, rather than trusting every caller', () => {
      // Long content belongs in the region below and every caller in this repository
      // now puts it there, but a heading is still a string a caller supplies, and an
      // unreachable close button is severe enough not to rest on that.
      expect(stylesheet).toContain('[mat-dialog-title].gf-notification-text');
      expect(stylesheet).toMatch(/max-height:\s*20svh/);
    });

    it('keeps the newlines the content carries', () => {
      // Required by the switch to text rendering: without it every serialised
      // structure collapses onto one unreadable line.
      expect(stylesheet).toMatch(/white-space:\s*pre-wrap/);
    });
  });
});
