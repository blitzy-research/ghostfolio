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
import { catchError, startWith, switchMap, tap } from 'rxjs/operators';

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
  public isLoading = false;
  public prompt: string;
  public promptModeFormControl = new FormControl<AiPromptMode>('analysis');

  public constructor(
    private changeDetectorRef: ChangeDetectorRef,
    private clipboard: Clipboard,
    private dataService: DataService,
    private destroyRef: DestroyRef,
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
