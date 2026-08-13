import { NotificationService } from '@ghostfolio/ui/notifications';
import { DataService } from '@ghostfolio/ui/services';

import { ComponentFixture, TestBed } from '@angular/core/testing';
import { MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { EMPTY, Observable, of, throwError } from 'rxjs';

import { GfCreateOrUpdateAccessDialogComponent } from './create-or-update-access-dialog.component';

/**
 * Granting and updating access, and the double press that used to do it twice.
 *
 * This dialog issues its own write, which is what separates it from its siblings. Across
 * this codebase the same unguarded double press was absorbed by `MatDialogRef.close`
 * ignoring its second call - so the dialogs that only close were safe by accident, and
 * this one, which sends a request before closing, was not safe at all. Two presses inside
 * the asynchronous validation window sent two requests.
 *
 * The guard is therefore explicit, and it is RELEASED wherever the dialog stays open: a
 * refused request or a validation failure both leave the viewer holding a form they must
 * be able to submit again.
 */
describe('GfCreateOrUpdateAccessDialogComponent', () => {
  let component: GfCreateOrUpdateAccessDialogComponent;
  let fixture: ComponentFixture<GfCreateOrUpdateAccessDialogComponent>;
  let alert: jest.Mock;
  let close: jest.Mock;
  let postAccess: jest.Mock;
  let putAccess: jest.Mock;

  /**
   * The shape this dialog is always opened with. Its own `ngOnInit` reads
   * `permissions[0]` and `type` unconditionally, so both are supplied for the create
   * case as well - which is what the account-access module hands it.
   */
  const createAccessData = (overrides: Record<string, unknown> = {}) => {
    return {
      permissions: ['READ_RESTRICTED'],
      type: 'PRIVATE',
      ...overrides
    };
  };

  const createComponent = async ({
    access = createAccessData(),
    response = of({})
  }: {
    access?: Record<string, unknown>;
    response?: Observable<unknown>;
  } = {}) => {
    alert = jest.fn();
    close = jest.fn();
    postAccess = jest.fn(() => response);
    putAccess = jest.fn(() => response);

    TestBed.resetTestingModule();

    await TestBed.configureTestingModule({
      imports: [GfCreateOrUpdateAccessDialogComponent],
      providers: [
        provideNoopAnimations(),
        {
          provide: DataService,
          useValue: { fetchUsers: () => of([]), postAccess, putAccess }
        },
        { provide: MAT_DIALOG_DATA, useValue: { access } },
        // The dialog takes `disableClose` over so it can ask before discarding a
        // part-filled form, and subscribes to both routes out. Empty streams are enough
        // here - the guard's own behaviour is covered where it is exercised, in
        // `transfer-balance-dialog.component.spec.ts`.
        {
          provide: MatDialogRef,
          useValue: {
            backdropClick: () => EMPTY,
            close,
            disableClose: false,
            keydownEvents: () => EMPTY
          }
        },
        {
          provide: NotificationService,
          useValue: { alert, confirm: jest.fn() }
        }
      ]
    })
      // The form's own controls are not what is under test, and the user picker they
      // include reaches for its own collaborators.
      .overrideComponent(GfCreateOrUpdateAccessDialogComponent, {
        set: { imports: [], template: '' }
      })
      .compileComponents();

    fixture = TestBed.createComponent(GfCreateOrUpdateAccessDialogComponent);
    component = fixture.componentInstance;

    fixture.detectChanges();

    return component;
  };

  const fillForCreate = () => {
    (
      component as unknown as {
        accessForm: { patchValue: (value: unknown) => void };
      }
    ).accessForm.patchValue({
      alias: 'A friend',
      granteeUserId: null,
      permissions: 'READ_RESTRICTED'
    });
  };

  const isSubmitting = () => {
    return (component as unknown as { isSubmitting: boolean }).isSubmitting;
  };

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('granting access', () => {
    it('sends one request for two presses', async () => {
      // A request that never settles, which is the window a second press lands in.
      await createComponent({ response: new Observable() });

      fillForCreate();

      await component.onSubmit();
      await component.onSubmit();

      // Two grants is not a cosmetic defect: it creates a second capability that has
      // to be found and revoked separately.
      expect(postAccess).toHaveBeenCalledTimes(1);
      expect(isSubmitting()).toBe(true);
    });

    it('closes once the grant is accepted', async () => {
      await createComponent();

      fillForCreate();

      await component.onSubmit();

      expect(postAccess).toHaveBeenCalledTimes(1);
      expect(close).toHaveBeenCalled();
    });

    it('releases the guard when the grant is refused, so it can be retried', async () => {
      await createComponent({
        response: throwError(() => ({ status: 400 }))
      });

      fillForCreate();

      await component.onSubmit();

      expect(close).not.toHaveBeenCalled();
      expect(isSubmitting()).toBe(false);

      await component.onSubmit();

      expect(postAccess).toHaveBeenCalledTimes(2);
    });

    it('says the grant was refused', async () => {
      await createComponent({
        response: throwError(() => ({ status: 400 }))
      });

      fillForCreate();

      await component.onSubmit();

      expect(alert).toHaveBeenCalledWith({
        title: 'Oops! Could not grant access.'
      });
    });
  });

  describe('updating access', () => {
    it('sends one request for two presses', async () => {
      await createComponent({
        access: createAccessData({ alias: 'A friend', id: 'access-id' }),
        response: new Observable()
      });

      (
        component as unknown as {
          accessForm: { patchValue: (value: unknown) => void };
        }
      ).accessForm.patchValue({ permissions: 'READ_RESTRICTED' });

      await component.onSubmit();
      await component.onSubmit();

      expect(putAccess).toHaveBeenCalledTimes(1);
    });

    it('releases the guard when the update is refused', async () => {
      await createComponent({
        access: createAccessData({ alias: 'A friend', id: 'access-id' }),
        response: throwError(() => ({ status: 400 }))
      });

      (
        component as unknown as {
          accessForm: { patchValue: (value: unknown) => void };
        }
      ).accessForm.patchValue({ permissions: 'READ_RESTRICTED' });

      await component.onSubmit();

      expect(isSubmitting()).toBe(false);
      expect(alert).toHaveBeenCalledWith({
        title: 'Oops! Could not update access.'
      });
    });
  });
});
