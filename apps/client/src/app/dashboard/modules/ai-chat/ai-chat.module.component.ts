import { ImpersonationStorageService } from '@ghostfolio/client/services/impersonation-storage.service';
import { UserService } from '@ghostfolio/client/services/user/user.service';
import { openExternalWindow } from '@ghostfolio/common/helper';
import type { AiPromptMode } from '@ghostfolio/common/types';
import { DataService } from '@ghostfolio/ui/services';

import { Clipboard } from '@angular/cdk/clipboard';
import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  DestroyRef,
  OnInit
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormControl, ReactiveFormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatSnackBar } from '@angular/material/snack-bar';
import { IonIcon } from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import {
  alertCircleOutline,
  copyOutline,
  documentTextOutline,
  openOutline
} from 'ionicons/icons';
import ms from 'ms';
import { NgxSkeletonLoaderModule } from 'ngx-skeleton-loader';
import { EMPTY } from 'rxjs';
import {
  catchError,
  filter,
  startWith,
  switchMap,
  tap,
  timeout
} from 'rxjs/operators';

/**
 * How long the module waits for a prompt before it gives up on the request.
 *
 * Without a deadline a response that never arrives is indistinguishable from one
 * that is merely slow: the card holds its loading skeleton indefinitely, the
 * copy action stays disabled, and nothing reaches the console - so the failure is
 * invisible in every channel a viewer or a developer would look at. The value is
 * deliberately generous next to the endpoint's normal response time, which is
 * measured in tens of milliseconds, so a slow but working backend is never
 * reported as broken; it exists to bound the pathological case, not to police
 * latency.
 */
const PROMPT_REQUEST_TIMEOUT = ms('30 seconds');

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    IonIcon,
    MatButtonModule,
    MatButtonToggleModule,
    MatProgressSpinnerModule,
    NgxSkeletonLoaderModule,
    ReactiveFormsModule
  ],
  selector: 'gf-ai-chat-module',
  styleUrls: ['./ai-chat.module.scss'],
  templateUrl: './ai-chat.module.html'
})
export class GfAiChatModuleComponent implements OnInit {
  public hasError = false;

  /**
   * Whether the viewer is currently looking at somebody else's portfolio.
   *
   * The one piece of state this module withholds its prompt on. See
   * {@link ngOnInit} for why a prompt cannot be built at all in that mode.
   */
  public hasImpersonationId = false;

  public isLoading = false;
  public prompt: string;
  public promptModeFormControl = new FormControl<AiPromptMode>('analysis');

  public constructor(
    private changeDetectorRef: ChangeDetectorRef,
    private clipboard: Clipboard,
    private dataService: DataService,
    private destroyRef: DestroyRef,
    private impersonationStorageService: ImpersonationStorageService,
    private snackBar: MatSnackBar,
    private userService: UserService
  ) {
    addIcons({
      alertCircleOutline,
      copyOutline,
      documentTextOutline,
      openOutline
    });
  }

  public ngOnInit() {
    // The prompt is withheld entirely while impersonating, and this is a
    // correctness requirement rather than a policy preference.
    //
    // A prompt request carries two things that have to agree about whose
    // portfolio is being described: the filters, and the identity the server
    // resolves them against. This module sends `userService.getFilters()`, which
    // on an impersonated surface names the *impersonated* user's accounts and
    // tags. The AI endpoint resolves them against the authenticated user - it
    // passes `impersonationId: undefined` and `userId: request.user.id` - so the
    // two disagree, and the resulting prose describes the viewer's own holdings
    // while every filter chip on screen says it describes somebody else's. It is
    // not a redacted or empty answer, which the viewer could recognise; it is a
    // confidently wrong one.
    //
    // Reconciling it the other way round - honouring the impersonation - is not
    // available here. The endpoint is not this module's to change, and
    // Ghostfolio withholds another user's monetary values by redacting them from
    // responses, which is something that can be done to a numeric field and
    // cannot be done to a paragraph of generated prose. Passing impersonation
    // through would therefore turn a value-redaction guarantee into a
    // value-disclosure hole.
    //
    // So the module says so instead. The mode toggle and the copy control are
    // withdrawn, and an explicit notice takes the place of the prompt - the same
    // shape every other module uses to withdraw an action while impersonating,
    // `!this.hasImpersonationId && …`, with the difference that here the whole
    // output rather than one button is what has to go.
    this.impersonationStorageService
      .onChangeHasImpersonation()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((impersonationId) => {
        this.hasImpersonationId = !!impersonationId;

        // Anything already on screen belongs to the identity that was current
        // when it was fetched, so it is dropped rather than left standing under a
        // notice that contradicts it. Dropped on the way *out* of impersonation
        // too, because the request below re-runs and the stale prose would
        // otherwise be visible until it answers.
        this.hasError = false;
        this.isLoading = false;
        this.prompt = undefined;

        this.changeDetectorRef.markForCheck();

        if (!this.hasImpersonationId) {
          // Re-asked on the way out, because the mode control has not changed and
          // would otherwise emit nothing at all.
          this.promptModeFormControl.setValue(
            this.promptModeFormControl.value,
            { emitEvent: true }
          );
        }
      });

    // `startWith` emits synchronously, so the loading state is set before the
    // first render instead of flashing the empty state. `switchMap` discards a
    // superseded request, so a slow response for the previous mode can never
    // overwrite the newer one. `catchError` is deliberately nested inside the
    // projected observable: hoisting it into the outer pipe would terminate
    // `valueChanges`, and every later mode change would then silently do
    // nothing.
    this.promptModeFormControl.valueChanges
      .pipe(
        startWith(this.promptModeFormControl.value),
        filter(() => {
          // Placed after `startWith` and before `tap`, so a mode change made
          // while impersonating leaves no loading state behind either.
          return !this.hasImpersonationId;
        }),
        tap(() => {
          this.hasError = false;
          this.isLoading = true;
          this.prompt = undefined;

          this.changeDetectorRef.markForCheck();
        }),
        switchMap((mode) => {
          return this.dataService
            .fetchPrompt({
              mode,
              filters: this.userService.getFilters()
            })
            .pipe(
              // The deadline belongs on the inner observable, immediately ahead
              // of `catchError`, for the same reason `catchError` itself does: a
              // request that never settles is delivered here as an error and
              // handled by the failure branch below, whereas a `timeout` in the
              // outer pipe would time out `valueChanges` and stop the module
              // reacting to any later mode change. Living on the inner
              // subscription also means a superseded request takes its timer with
              // it when `switchMap` unsubscribes, so the countdown always belongs
              // to the request currently on screen, and module teardown cancels
              // it along with the request.
              timeout(PROMPT_REQUEST_TIMEOUT),
              catchError(() => {
                this.hasError = true;
                this.isLoading = false;

                this.changeDetectorRef.markForCheck();

                return EMPTY;
              })
            );
        }),
        takeUntilDestroyed(this.destroyRef)
      )
      .subscribe(({ prompt }) => {
        this.prompt = prompt;
        this.isLoading = false;

        this.changeDetectorRef.markForCheck();
      });
  }

  public onCopyPromptToClipboard() {
    if (!this.prompt) {
      return;
    }

    this.clipboard.copy(this.prompt);

    const snackBarRef = this.snackBar.open(
      '✅ ' + $localize`AI prompt has been copied to the clipboard`,
      $localize`Open Duck.ai` + ' →',
      {
        duration: ms('7 seconds')
      }
    );

    snackBarRef
      .onAction()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => {
        // Opened through the shared helper so the destination is never handed a
        // `window.opener` reference back to this tab.
        openExternalWindow('https://duck.ai');
      });
  }
}
