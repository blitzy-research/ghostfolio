import { ImpersonationStorageService } from '@ghostfolio/client/services/impersonation-storage.service';
import { UserService } from '@ghostfolio/client/services/user/user.service';
import { DataService } from '@ghostfolio/ui/services';

import { Clipboard } from '@angular/cdk/clipboard';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { MatSnackBar } from '@angular/material/snack-bar';
import { BehaviorSubject, of } from 'rxjs';

import { GfAiChatModuleComponent } from './ai-chat.module.component';

/**
 * The AI chat module, focused on the one condition under which it must produce
 * nothing at all.
 *
 * A prompt request carries two things that have to agree about whose portfolio is
 * being described: the filters this module sends, and the identity the endpoint
 * resolves them against. On an impersonated surface the filters name the
 * impersonated user's accounts and tags, while the endpoint resolves them against
 * the authenticated user — so the generated prose describes the viewer's own
 * holdings under filter chips that say it describes somebody else's. That is not a
 * redacted or empty answer the viewer could recognise as such; it is a confidently
 * wrong one, which is why the request is withheld rather than merely relabelled.
 *
 * The endpoint is deliberately not the thing under test. It lies outside this
 * refactor's scope, and honouring impersonation there would turn Ghostfolio's
 * value-redaction guarantee — something that can be applied to a numeric field and
 * cannot be applied to a paragraph of generated prose — into a disclosure hole.
 */
describe('GfAiChatModuleComponent', () => {
  let component: GfAiChatModuleComponent;
  let fetchPrompt: jest.Mock;
  let fixture: ComponentFixture<GfAiChatModuleComponent>;
  let impersonationSubject: BehaviorSubject<string>;

  /**
   * Builds the module for a given impersonation state.
   *
   * The impersonation channel is a subject rather than a constant so that entering
   * and leaving impersonation can both be exercised on one instance — the
   * transition is where the interesting behaviour is, not the steady state.
   */
  const createComponent = async (impersonationId: string = null) => {
    fetchPrompt = jest.fn(() => {
      return of({ prompt: 'PROMPT' });
    });

    impersonationSubject = new BehaviorSubject<string>(impersonationId);

    await TestBed.configureTestingModule({
      imports: [GfAiChatModuleComponent],
      providers: [
        { provide: Clipboard, useValue: { copy: jest.fn() } },
        { provide: DataService, useValue: { fetchPrompt } },
        {
          provide: ImpersonationStorageService,
          useValue: {
            onChangeHasImpersonation: () => {
              return impersonationSubject.asObservable();
            }
          }
        },
        { provide: MatSnackBar, useValue: { open: jest.fn() } },
        {
          provide: UserService,
          useValue: {
            getFilters: jest.fn(() => {
              return [];
            })
          }
        }
      ]
    }).compileComponents();

    fixture = TestBed.createComponent(GfAiChatModuleComponent);
    component = fixture.componentInstance;

    fixture.detectChanges();
  };

  /** The notice that stands in for the prompt, located by the text it carries. */
  const unavailableNotice = () => {
    return Array.from(
      (fixture.nativeElement as HTMLElement).querySelectorAll('div')
    ).find((element) => {
      return (
        element.textContent.trim() ===
        'AI prompts are unavailable while viewing another portfolio.'
      );
    });
  };

  describe('while viewing the signed-in portfolio', () => {
    it('requests a prompt and renders it', async () => {
      await createComponent();

      expect(fetchPrompt).toHaveBeenCalledTimes(1);
      expect(component.prompt).toBe('PROMPT');
      expect(component.hasImpersonationId).toBe(false);
      expect(unavailableNotice()).toBeFalsy();
    });
  });

  describe('while viewing another portfolio', () => {
    it('requests no prompt at all', async () => {
      await createComponent('IMPERSONATION_ID');

      // The assertion the finding turns on. A request here would return prose
      // about the signed-in portfolio described as though it were the one on
      // screen.
      expect(fetchPrompt).not.toHaveBeenCalled();
      expect(component.hasImpersonationId).toBe(true);
      expect(component.prompt).toBeUndefined();
    });

    it('leaves no loading state behind', async () => {
      await createComponent('IMPERSONATION_ID');

      // Withholding the request must not leave the placeholder up forever, which
      // is why the guard sits ahead of the state-setting step rather than at the
      // request itself.
      expect(component.isLoading).toBe(false);
      expect(component.hasError).toBe(false);
    });

    it('says so, in place of the prompt', async () => {
      await createComponent('IMPERSONATION_ID');

      expect(unavailableNotice()).toBeTruthy();
    });

    it('requests no prompt when the mode is changed', async () => {
      await createComponent('IMPERSONATION_ID');

      component.promptModeFormControl.setValue('portfolio');
      fixture.detectChanges();

      expect(fetchPrompt).not.toHaveBeenCalled();
      expect(component.isLoading).toBe(false);
    });
  });

  describe('entering and leaving impersonation', () => {
    it('drops a prompt fetched for the signed-in portfolio', async () => {
      await createComponent();

      expect(component.prompt).toBe('PROMPT');

      impersonationSubject.next('IMPERSONATION_ID');
      fixture.detectChanges();

      // Dropped rather than left standing under a notice that contradicts it.
      expect(component.prompt).toBeUndefined();
      expect(unavailableNotice()).toBeTruthy();
    });

    it('asks again once impersonation ends', async () => {
      await createComponent('IMPERSONATION_ID');

      expect(fetchPrompt).not.toHaveBeenCalled();

      impersonationSubject.next(null);
      fixture.detectChanges();

      // The mode control has not changed, so nothing would be emitted on its own -
      // the module has to re-ask, or it would sit empty until the viewer touched
      // the toggle.
      expect(fetchPrompt).toHaveBeenCalledTimes(1);
      expect(component.prompt).toBe('PROMPT');
      expect(unavailableNotice()).toBeFalsy();
    });
  });
});
