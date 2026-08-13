import { ImpersonationStorageService } from '@ghostfolio/client/services/impersonation-storage.service';
import { UserService } from '@ghostfolio/client/services/user/user.service';
import { DataService } from '@ghostfolio/ui/services';

import { Clipboard } from '@angular/cdk/clipboard';
import { ComponentFixture, TestBed } from '@angular/core/testing';
// No Jest setup file installs `$localize`, and this module's own strings compile
// to calls on it. Its position is load-bearing: this group is evaluated before
// the relative import below, which is the subject of this spec.
import '@angular/localize/init';
import { MatSnackBar } from '@angular/material/snack-bar';
import ms from 'ms';
import { BehaviorSubject, NEVER, of, throwError } from 'rxjs';

import { GfAiChatModuleComponent } from './ai-chat.module.component';

// `@ionic/angular/standalone` re-exports `@ionic/core`, whose ES modules ship
// under a plain `.js` extension. A real standalone stand-in is used rather than a
// bare class because Angular validates every entry of an `imports` array, and it
// carries the same selector so the rendered markup keeps its shape. The decorator
// is applied as a function because this factory is hoisted above this file's own
// imports, so no class declared here would exist yet.
jest.mock('@ionic/angular/standalone', () => {
  const angularCore =
    jest.requireActual<typeof import('@angular/core')>('@angular/core');

  return {
    IonIcon: angularCore.Component({ selector: 'ion-icon', template: '' })(
      class IonIcon {}
    )
  };
});

/**
 * The AI chat module, on the two conditions under which what it shows is decided by
 * something other than the answer it got: a request that never arrives, and a
 * portfolio that is not the signed-in one.
 *
 * Without a deadline a response that never settles is indistinguishable from one
 * that is merely slow: the card keeps its loading skeleton for as long as the page
 * stays open, the copy action stays disabled, the failure state - which is written
 * and translated - is unreachable, and nothing is written to the console. Such a
 * failure is invisible in every channel a viewer or a developer would look at,
 * which is precisely what makes it worth a test: a hang leaves no trace to notice a
 * regression by.
 *
 * The deadline is exercised with fake timers rather than by waiting, and the
 * request is driven by observables this suite controls, because "never settles"
 * is the condition that has to be reproducible for any of this to mean anything.
 *
 * The second condition is impersonation, and it is the one case in which the module
 * must produce nothing at all. A prompt request carries two things that have to
 * agree about whose portfolio is being described: the filters this module sends, and
 * the identity the endpoint resolves them against. On an impersonated surface the
 * filters name the impersonated user's accounts and tags while the endpoint resolves
 * them against the authenticated user - so the generated prose describes the viewer's
 * own holdings under filter chips that say it describes somebody else's. That is not
 * a redacted or empty answer the viewer could recognise as such; it is a confidently
 * wrong one, which is why the request is withheld rather than merely relabelled. The
 * endpoint is deliberately not the thing under test: honouring impersonation there
 * would turn Ghostfolio's value-redaction guarantee - something that can be applied
 * to a numeric field and cannot be applied to a paragraph of generated prose - into a
 * disclosure hole.
 */
describe('GfAiChatModuleComponent', () => {
  /** Matches `PROMPT_REQUEST_TIMEOUT` in the component under test. */
  const promptRequestTimeout = ms('30 seconds');

  let component: GfAiChatModuleComponent;
  let fetchPrompt: jest.Mock;
  let fixture: ComponentFixture<GfAiChatModuleComponent>;

  /**
   * The impersonation channel, as a subject rather than a constant so that entering
   * and leaving impersonation can both be exercised on one instance - the transition
   * is where the interesting behaviour is, not the steady state. It is a
   * `BehaviorSubject`, so a value pushed before the first render is delivered on
   * subscription and the module comes up already impersonating.
   */
  let impersonationSubject: BehaviorSubject<string>;

  /** The module's whole visible text, with runs of whitespace collapsed. */
  const renderedText = () =>
    (fixture.nativeElement as HTMLElement).textContent.replace(/\s+/g, ' ');

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

  beforeEach(async () => {
    jest.useFakeTimers();

    // Never settles by default: the pathological case is the subject here, and
    // the tests that need a response opt into one explicitly.
    fetchPrompt = jest.fn().mockReturnValue(NEVER);

    impersonationSubject = new BehaviorSubject<string>(null);

    await TestBed.configureTestingModule({
      imports: [GfAiChatModuleComponent],
      providers: [
        // Stubbed for the same reason as the snack bar: the clipboard is only
        // reached by the copy action, which this suite asserts the state of rather
        // than the effect of.
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
        // Stubbed rather than imported: the snack bar is only reached by the copy
        // action, and instantiating the real one would pull in an overlay this
        // suite has no assertions about.
        { provide: MatSnackBar, useValue: { open: jest.fn() } },
        { provide: UserService, useValue: { getFilters: () => [] } }
      ]
    }).compileComponents();

    fixture = TestBed.createComponent(GfAiChatModuleComponent);
    component = fixture.componentInstance;
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('asks for the analysis prompt once as soon as it is shown', () => {
    fixture.detectChanges();

    expect(fetchPrompt).toHaveBeenCalledTimes(1);
    expect(fetchPrompt).toHaveBeenCalledWith({ filters: [], mode: 'analysis' });
    expect(component.isLoading).toBe(true);
  });

  it('holds its loading state while the request is still within the deadline', () => {
    fixture.detectChanges();

    jest.advanceTimersByTime(promptRequestTimeout - 1);
    fixture.detectChanges();

    // Reporting a failure early would turn a slow backend into a broken one.
    expect(component.hasError).toBe(false);
    expect(component.isLoading).toBe(true);
  });

  it('gives up on a request that never settles and surfaces its failure state', () => {
    fixture.detectChanges();

    jest.advanceTimersByTime(promptRequestTimeout);
    fixture.detectChanges();

    expect(component.hasError).toBe(true);
    expect(component.isLoading).toBe(false);

    // Asserted through the rendered text as well, because the branch being
    // reached is only useful if it is the branch the viewer actually sees.
    expect(renderedText()).toContain('Oops! Something went wrong.');
    expect(renderedText()).toContain('Please try again later.');
  });

  it('does not retry the request it gave up on', () => {
    fixture.detectChanges();

    jest.advanceTimersByTime(promptRequestTimeout * 4);

    expect(fetchPrompt).toHaveBeenCalledTimes(1);
  });

  it('re-enables the copy action only once a prompt is in hand', () => {
    fixture.detectChanges();

    const copyButton = (fixture.nativeElement as HTMLElement).querySelector(
      'button[mat-stroked-button]'
    );

    expect(copyButton.hasAttribute('disabled')).toBe(true);

    jest.advanceTimersByTime(promptRequestTimeout);
    fixture.detectChanges();

    // Still disabled in the failure state: there is nothing to copy.
    expect(copyButton.hasAttribute('disabled')).toBe(true);
  });

  it('renders a prompt that arrives inside the deadline', () => {
    fetchPrompt.mockReturnValue(of({ prompt: 'Analyse this portfolio' }));

    fixture.detectChanges();

    expect(component.hasError).toBe(false);
    expect(component.isLoading).toBe(false);
    expect(component.prompt).toBe('Analyse this portfolio');
    expect(renderedText()).toContain('Analyse this portfolio');
  });

  it('keeps reacting to mode changes after a request has timed out', () => {
    fixture.detectChanges();

    jest.advanceTimersByTime(promptRequestTimeout);
    fixture.detectChanges();

    expect(component.hasError).toBe(true);

    fetchPrompt.mockReturnValue(of({ prompt: 'Portfolio prompt' }));
    component.promptModeFormControl.setValue('portfolio');
    fixture.detectChanges();

    // The deadline lives on the inner request, so expiring it must not terminate
    // the stream of mode changes - otherwise one hang would leave the module
    // permanently inert.
    expect(fetchPrompt).toHaveBeenCalledTimes(2);
    expect(fetchPrompt).toHaveBeenLastCalledWith({
      filters: [],
      mode: 'portfolio'
    });
    expect(component.hasError).toBe(false);
    expect(component.prompt).toBe('Portfolio prompt');
  });

  it('keeps reacting to mode changes after a request has failed outright', () => {
    fetchPrompt.mockReturnValue(throwError(() => new Error('offline')));

    fixture.detectChanges();

    expect(component.hasError).toBe(true);

    fetchPrompt.mockReturnValue(of({ prompt: 'Portfolio prompt' }));
    component.promptModeFormControl.setValue('portfolio');
    fixture.detectChanges();

    expect(component.hasError).toBe(false);
    expect(component.prompt).toBe('Portfolio prompt');
  });

  it('abandons the deadline of a request the viewer has superseded', () => {
    fixture.detectChanges();

    // The first request is still hanging when the mode changes, so `switchMap`
    // unsubscribes from it and its timer must go with it. A timer that outlived
    // its request would drop the module into the failure state while a perfectly
    // healthy newer request was on screen.
    fetchPrompt.mockReturnValue(of({ prompt: 'Portfolio prompt' }));
    component.promptModeFormControl.setValue('portfolio');
    fixture.detectChanges();

    jest.advanceTimersByTime(promptRequestTimeout * 2);
    fixture.detectChanges();

    expect(component.hasError).toBe(false);
    expect(component.prompt).toBe('Portfolio prompt');
  });

  it('cancels the pending deadline when the module is torn down', () => {
    fixture.detectChanges();
    fixture.destroy();

    jest.advanceTimersByTime(promptRequestTimeout * 2);

    // A module removed from the canvas must not keep a timer alive, nor write to
    // a component whose view is gone.
    expect(component.hasError).toBe(false);
    expect(jest.getTimerCount()).toBe(0);
  });
  /**
   * The prompt box, which scrolls sideways.
   *
   * A markdown pipe table row is 126 characters and no width this module reaches can
   * hold one, so the document is kept at its natural width and the box scrolls. That
   * makes it a scroll container - and a scroll container that cannot take focus cannot be
   * scrolled from the keyboard at all, so everything past the right edge was reachable
   * with a pointer and by no other means.
   */
  describe('the prompt box', () => {
    const renderWithPrompt = () => {
      fetchPrompt.mockReturnValue(of({ prompt: 'A | B\n--- | ---\n1 | 2' }));

      fixture.detectChanges();

      return fixture.nativeElement.querySelector('.prompt-container');
    };

    it('can be reached from the keyboard', () => {
      expect(renderWithPrompt().getAttribute('tabindex')).toBe('0');
    });

    it('says what it holds, so landing on it is worthwhile', () => {
      const promptBox = renderWithPrompt();

      expect(promptBox.getAttribute('role')).toBe('region');
      expect(promptBox.getAttribute('aria-label')).toBe('Generated AI prompt');
    });

    it('is a preformatted element, because the table depends on it', () => {
      // A pipe table is aligned by padding cells with spaces, so it reads as a table
      // only in a face where every character is the same width.
      expect(renderWithPrompt().tagName).toBe('PRE');
    });
  });

  describe('while viewing another portfolio', () => {
    /** Brings the module up already impersonating, with a prompt available. */
    const renderWhileImpersonating = () => {
      fetchPrompt.mockReturnValue(of({ prompt: 'Analyse this portfolio' }));

      impersonationSubject.next('IMPERSONATION_ID');

      fixture.detectChanges();
    };

    it('requests no prompt at all', () => {
      renderWhileImpersonating();

      // A request here would return prose about the signed-in portfolio described
      // as though it were the one on screen.
      expect(fetchPrompt).not.toHaveBeenCalled();
      expect(component.hasImpersonationId).toBe(true);
      expect(component.prompt).toBeUndefined();
    });

    it('leaves no loading state behind', () => {
      renderWhileImpersonating();

      // Withholding the request must not leave the placeholder up forever, which is
      // why the guard sits ahead of the state-setting step rather than at the
      // request itself.
      expect(component.isLoading).toBe(false);
      expect(component.hasError).toBe(false);
    });

    it('says so, in place of the prompt', () => {
      renderWhileImpersonating();

      expect(unavailableNotice()).toBeTruthy();
    });

    it('requests no prompt when the mode is changed', () => {
      renderWhileImpersonating();

      component.promptModeFormControl.setValue('portfolio');
      fixture.detectChanges();

      expect(fetchPrompt).not.toHaveBeenCalled();
      expect(component.isLoading).toBe(false);
    });

    it('starts no deadline it would have to cancel', () => {
      renderWhileImpersonating();

      jest.advanceTimersByTime(promptRequestTimeout * 2);
      fixture.detectChanges();

      // The withheld request has no timer, so the failure state must stay
      // unreachable however long the module is left on screen.
      expect(component.hasError).toBe(false);
      expect(unavailableNotice()).toBeTruthy();
    });
  });

  describe('entering and leaving impersonation', () => {
    it('drops a prompt fetched for the signed-in portfolio', () => {
      fetchPrompt.mockReturnValue(of({ prompt: 'Analyse this portfolio' }));

      fixture.detectChanges();

      expect(component.prompt).toBe('Analyse this portfolio');

      impersonationSubject.next('IMPERSONATION_ID');
      fixture.detectChanges();

      // Dropped rather than left standing under a notice that contradicts it.
      expect(component.prompt).toBeUndefined();
      expect(unavailableNotice()).toBeTruthy();
    });

    it('asks again once impersonation ends', () => {
      fetchPrompt.mockReturnValue(of({ prompt: 'Analyse this portfolio' }));

      impersonationSubject.next('IMPERSONATION_ID');

      fixture.detectChanges();

      expect(fetchPrompt).not.toHaveBeenCalled();

      impersonationSubject.next(null);
      fixture.detectChanges();

      // The mode control has not changed, so nothing would be emitted on its own -
      // the module has to re-ask, or it would sit empty until the viewer touched the
      // toggle.
      expect(fetchPrompt).toHaveBeenCalledTimes(1);
      expect(component.prompt).toBe('Analyse this portfolio');
      expect(unavailableNotice()).toBeFalsy();
    });
  });
});
