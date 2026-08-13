import { Access, User } from '@ghostfolio/common/interfaces';
import { NotificationService } from '@ghostfolio/ui/notifications';

import { Clipboard } from '@angular/cdk/clipboard';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { MatSnackBar } from '@angular/material/snack-bar';

import { GfAccessTableComponent } from './access-table.component';

/**
 * The producer half of the public share link.
 *
 * The identifier travels as a query parameter of the root route -
 * `/<language>/?accessId=<id>` - because this application serves no path that
 * could address it. The consumer of that link is covered by the public portfolio's
 * own spec; this one covers the producer.
 *
 * It is asserted through the rendered anchor rather than by calling the method,
 * for two reasons. The method is `protected`, so reaching it would mean reaching
 * around the component's own contract; and the anchor's `href` is the thing a
 * viewer copies out of the page, so the rendered attribute *is* the link. A drift
 * in either - a path segment appearing, the locale segment disappearing, the
 * parameter being renamed - would compile, would pass every layout test, and would
 * break every link this table has ever handed out.
 */
describe('GfAccessTableComponent', () => {
  const accessId = 'a1b2c3';

  let clipboardMock: { copy: jest.Mock };
  let fixture: ComponentFixture<GfAccessTableComponent>;
  let snackBarMock: { open: jest.Mock };
  // Recorded through a typed side effect rather than read back off
  // `snackBarMock.open.mock.calls`, whose element type is `any` and would put the
  // message assertion beyond anything the compiler checks.
  let snackBarMessages: string[];

  const createAccess = (access: Partial<Access> = {}): Access => {
    return {
      id: accessId,
      permissions: ['READ'],
      type: 'PUBLIC',
      ...access
    };
  };

  const createViewer = (language = 'en'): User => {
    return { settings: { language } } as User;
  };

  const createComponent = async ({
    accesses = [createAccess()],
    showActions = false,
    user = createViewer()
  }: {
    accesses?: Access[];
    showActions?: boolean;
    user?: User;
  } = {}) => {
    clipboardMock = { copy: jest.fn() };
    snackBarMessages = [];
    snackBarMock = {
      open: jest.fn((message: string) => {
        snackBarMessages.push(message);
      })
    };

    await TestBed.configureTestingModule({
      imports: [GfAccessTableComponent],
      providers: [
        { provide: Clipboard, useValue: clipboardMock },
        { provide: MatSnackBar, useValue: snackBarMock },
        // Reached only by the deletion confirmation, which nothing below triggers.
        // An unimplemented stub is therefore the stricter choice: a call throws
        // rather than passing silently.
        { provide: NotificationService, useValue: {} }
      ]
    }).compileComponents();

    fixture = TestBed.createComponent(GfAccessTableComponent);

    fixture.componentRef.setInput('accesses', accesses);
    fixture.componentRef.setInput('showActions', showActions);
    fixture.componentRef.setInput('user', user);

    fixture.detectChanges();

    return fixture.componentInstance;
  };

  /** Every share link the table rendered, read off the anchors themselves. */
  const renderedLinks = () => {
    return Array.from(
      (
        fixture.nativeElement as HTMLElement
      ).querySelectorAll<HTMLAnchorElement>('a[target="_blank"]')
    );
  };

  /**
   * Opens the overflow menu of the first access, which is what puts its items in
   * the document at all: a `MatMenu` renders its panel lazily, and into the
   * overlay container rather than into the component's own element.
   */
  const openActionsMenu = () => {
    (fixture.nativeElement as HTMLElement)
      .querySelector<HTMLButtonElement>('button[mat-button]')
      .click();

    fixture.detectChanges();
  };

  /**
   * The menu item that copies a link, located by its own source message and
   * searched for in the document, because that is where the overlay lives.
   */
  const copyLinkButton = () => {
    return Array.from(
      document.querySelectorAll<HTMLButtonElement>(
        '.cdk-overlay-container button[mat-menu-item]'
      )
    ).find((button) => {
      return button.textContent.trim() === 'Copy link to clipboard';
    });
  };

  afterEach(() => {
    // The overlay container outlives the fixture, so a panel left open would be
    // found by the next test's document query.
    for (const container of Array.from(
      document.querySelectorAll('.cdk-overlay-container')
    )) {
      container.remove();
    }

    jest.restoreAllMocks();
  });

  describe('the public share link', () => {
    it('addresses the locale root with the identifier as a query parameter', async () => {
      await createComponent();

      const [link] = renderedLinks();

      // `window.location.origin` in jsdom, which is what the component reads as its
      // base. Spelled out so the whole link is asserted rather than only its tail.
      expect(link.getAttribute('href')).toBe(
        `${window.location.origin}/en/?accessId=${accessId}`
      );
    });

    it('shows the viewer the same link it will hand out', async () => {
      await createComponent();

      const [link] = renderedLinks();

      // The text and the target are generated by the same call, so a divergence
      // between what is displayed and what is followed is impossible - and this is
      // the assertion that keeps it impossible.
      expect(link.textContent.trim()).toBe(link.getAttribute('href'));
    });

    it('addresses none of the paths this application does not serve', async () => {
      await createComponent();

      const [link] = renderedLinks();
      const href = link.getAttribute('href');

      // `/p/` is the path a share link would most plausibly acquire, and the one
      // that would silently keep working in development, where the wildcard
      // redirect hides a dead link behind the canvas, while failing as a 404 for
      // every recipient of a copied URL.
      expect(href).not.toContain('/p/');
      expect(href).not.toContain('/public/');
    });

    it.each([
      { language: 'de' },
      { language: 'en' },
      { language: 'pt' },
      { language: 'zh' }
    ])('follows the viewer own language: $language', async ({ language }) => {
      await createComponent({ user: createViewer(language) });

      const [link] = renderedLinks();

      // The client is deployed under a per-locale base href, so the segment is not
      // decoration: a link built without it does not resolve to the application.
      expect(link.getAttribute('href')).toBe(
        `${window.location.origin}/${language}/?accessId=${accessId}`
      );
    });

    it('encodes an identifier that would otherwise change the query', async () => {
      await createComponent({
        accesses: [createAccess({ id: 'a b&c=d?e#f' })]
      });

      const [link] = renderedLinks();

      // Identifiers are generated, so this is defence rather than a live case - but
      // an unencoded `&` would split one parameter into two and hand the recipient a
      // truncated identifier, which is exactly the kind of failure that only ever
      // shows up in production.
      expect(link.getAttribute('href')).toBe(
        `${window.location.origin}/en/?accessId=a%20b%26c%3Dd%3Fe%23f`
      );
    });

    it('renders one link per public access and none for a private one', async () => {
      await createComponent({
        accesses: [
          createAccess({ id: 'first' }),
          createAccess({ id: 'second' }),
          createAccess({ id: 'third', type: 'PRIVATE' })
        ]
      });

      expect(renderedLinks().map((link) => link.getAttribute('href'))).toEqual([
        `${window.location.origin}/en/?accessId=first`,
        `${window.location.origin}/en/?accessId=second`
      ]);
    });
  });

  describe('copying the link', () => {
    it('copies exactly the link it rendered', async () => {
      await createComponent({
        showActions: true,
        user: {
          settings: { isExperimentalFeatures: true, language: 'en' }
        } as User
      });

      const [link] = renderedLinks();

      openActionsMenu();
      copyLinkButton().click();

      // One source for the link and one only: whatever reaches the clipboard is the
      // same string the anchor points at.
      expect(clipboardMock.copy).toHaveBeenCalledTimes(1);
      expect(clipboardMock.copy).toHaveBeenCalledWith(
        link.getAttribute('href')
      );
    });

    it('confirms the copy to the viewer', async () => {
      await createComponent({
        showActions: true,
        user: {
          settings: { isExperimentalFeatures: true, language: 'en' }
        } as User
      });

      openActionsMenu();
      copyLinkButton().click();

      expect(snackBarMock.open).toHaveBeenCalledTimes(1);
      expect(snackBarMessages).toHaveLength(1);
      expect(snackBarMessages[0]).toContain(
        'Link has been copied to the clipboard'
      );
    });
  });
});
