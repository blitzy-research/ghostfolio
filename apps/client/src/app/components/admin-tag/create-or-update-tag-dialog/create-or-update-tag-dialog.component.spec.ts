import { NotificationService } from '@ghostfolio/ui/notifications';

import { ComponentFixture, TestBed } from '@angular/core/testing';
import { MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { EMPTY } from 'rxjs';

import { GfCreateOrUpdateTagDialogComponent } from './create-or-update-tag-dialog.component';

/**
 * A tag name that is already taken.
 *
 * Two different things used to go wrong here, and only one of them was a server matter.
 *
 * A tag is unique per owner by database constraint, so renaming one onto another owned
 * name is rejected - but the rejection arrived after this dialog had closed and taken the
 * typed name with it, leaving the viewer with a message about a name they could no longer
 * see or edit.
 *
 * The create path is worse, and is why this check lives in the dialog rather than only in
 * the server mapping: a tag created from the administration screen carries NO owner, and
 * Postgres treats the NULL owners of two global tags as distinct, so the unique index
 * over `(name, userId)` never fires for them. A second tag with the same name is simply
 * created, and the table then shows two rows nobody can tell apart. Nothing downstream
 * can fix that; it has to be refused before the write.
 *
 * The comparison is deliberately scope-aware and the caller supplies the scope, because
 * a global tag and a user's tag may legitimately share a name.
 */
describe('GfCreateOrUpdateTagDialogComponent', () => {
  let closed: unknown[];
  let fixture: ComponentFixture<GfCreateOrUpdateTagDialogComponent>;

  const createComponent = async ({
    existingNames = [] as string[],
    tag = { id: null as string, name: null as string }
  }: {
    existingNames?: string[];
    tag?: { id: string; name: string };
  } = {}) => {
    closed = [];

    await TestBed.configureTestingModule({
      imports: [GfCreateOrUpdateTagDialogComponent],
      providers: [
        provideNoopAnimations(),
        { provide: MAT_DIALOG_DATA, useValue: { existingNames, tag } },
        // The dialog takes `disableClose` over so it can ask before discarding a
        // part-filled form, and subscribes to both routes out. Empty streams are enough
        // here - the guard's own behaviour is covered where it is exercised, in
        // `transfer-balance-dialog.component.spec.ts`.
        {
          provide: MatDialogRef,
          useValue: {
            backdropClick: () => EMPTY,
            close: (value?: unknown) => {
              closed.push(value);
            },
            disableClose: false,
            keydownEvents: () => EMPTY
          }
        },
        { provide: NotificationService, useValue: { confirm: jest.fn() } }
      ]
    }).compileComponents();

    fixture = TestBed.createComponent(GfCreateOrUpdateTagDialogComponent);

    fixture.detectChanges();

    return fixture.componentInstance;
  };

  /** Types a name and submits, the way the form does. */
  const submit = async (name: string) => {
    const component = fixture.componentInstance;

    component.tagForm.get('name').setValue(name);
    component.tagForm.markAsDirty();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (component as any).onSubmit();

    fixture.detectChanges();
  };

  /** The message shown beside the field, if any. */
  const notice = () => {
    return (fixture.nativeElement as HTMLElement).querySelector(
      '[role="alert"]'
    );
  };

  describe('a name already taken in the same scope', () => {
    it('names it and keeps the dialog open', async () => {
      await createComponent({ existingNames: ['Emergency Fund'] });
      await submit('Emergency Fund');

      expect(closed).toEqual([]);
      expect(notice()?.textContent.trim()).toBe(
        'A tag named Emergency Fund already exists.'
      );
    });

    it('leaves the typed name in the field to correct', async () => {
      await createComponent({ existingNames: ['Emergency Fund'] });
      await submit('Emergency Fund');

      // The whole reason the check is here and not after the close: the name has to
      // still be on screen for the message about it to be actionable.
      expect(fixture.componentInstance.tagForm.get('name').value).toBe(
        'Emergency Fund'
      );
    });

    it('ignores case', async () => {
      await createComponent({ existingNames: ['Emergency Fund'] });
      await submit('emergency fund');

      // Two names differing only in case are indistinguishable in the list they land
      // in, so refusing them is the same service as refusing an exact repeat - even
      // though the database index would let this one through.
      expect(closed).toEqual([]);
      expect(notice()).toBeTruthy();
    });

    it('ignores surrounding space', async () => {
      await createComponent({ existingNames: ['  Emergency Fund '] });
      await submit('Emergency Fund');

      expect(closed).toEqual([]);
      expect(notice()).toBeTruthy();
    });

    /**
     * The comparison is lenient on purpose, so the message must not simply echo what
     * was typed: quoting `  emergency FUND  ` back would name something that appears
     * nowhere in the list being complained about, and would carry the typed whitespace
     * into a string a screen reader announces verbatim.
     */
    it('quotes the stored name rather than the typed one', async () => {
      await createComponent({ existingNames: ['Emergency Fund'] });
      await submit('  emergency FUND  ');

      expect(notice()?.textContent.trim()).toBe(
        'A tag named Emergency Fund already exists.'
      );
    });

    it('releases the submission so a corrected name can be sent', async () => {
      await createComponent({ existingNames: ['Emergency Fund'] });

      await submit('Emergency Fund');

      expect(closed).toEqual([]);

      await submit('Rainy Day');

      // The guard must not latch: a refused submission is not an in-flight one.
      expect(closed).toEqual([{ name: 'Rainy Day' }]);
    });

    it('clears the message once a corrected name is submitted', async () => {
      await createComponent({ existingNames: ['Emergency Fund'] });

      await submit('Emergency Fund');

      expect(notice()).toBeTruthy();

      await submit('Rainy Day');

      expect(notice()).toBeNull();
    });
  });

  describe('a name that is free', () => {
    it('is accepted', async () => {
      await createComponent({ existingNames: ['Emergency Fund'] });
      await submit('Rainy Day');

      expect(closed).toEqual([{ name: 'Rainy Day' }]);
      expect(notice()).toBeNull();
    });

    it('is accepted when nothing is taken at all', async () => {
      await createComponent();
      await submit('Rainy Day');

      expect(closed).toEqual([{ name: 'Rainy Day' }]);
    });

    it('is accepted when the caller passed no list', async () => {
      await createComponent({ existingNames: undefined });
      await submit('Rainy Day');

      // Defensive: an absent list means "nothing known to be taken", not a crash.
      expect(closed).toEqual([{ name: 'Rainy Day' }]);
    });
  });

  describe('renaming a tag', () => {
    it('lets it keep its own name', async () => {
      // The caller leaves the tag being renamed out of the list, so submitting the
      // unchanged name is not a collision with itself.
      await createComponent({
        existingNames: ['Emergency Fund'],
        tag: { id: 'TAG_ID', name: 'Rainy Day' }
      });

      await submit('Rainy Day');

      expect(closed).toEqual([{ id: 'TAG_ID', name: 'Rainy Day' }]);
    });

    it('refuses a rename onto another taken name', async () => {
      await createComponent({
        existingNames: ['Emergency Fund'],
        tag: { id: 'TAG_ID', name: 'Rainy Day' }
      });

      await submit('Emergency Fund');

      expect(closed).toEqual([]);
      expect(notice()?.textContent.trim()).toBe(
        'A tag named Emergency Fund already exists.'
      );
    });
  });
});
