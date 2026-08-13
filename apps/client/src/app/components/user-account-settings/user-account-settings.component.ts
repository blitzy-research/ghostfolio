import {
  KEY_STAY_SIGNED_IN,
  KEY_TOKEN,
  SettingsStorageService
} from '@ghostfolio/client/services/settings-storage.service';
import { UserService } from '@ghostfolio/client/services/user/user.service';
import { WebAuthnService } from '@ghostfolio/client/services/web-authn.service';
import { ConfirmationDialogType } from '@ghostfolio/common/enums';
import {
  downloadAsFile,
  reportSanitizedError
} from '@ghostfolio/common/helper';
import { User } from '@ghostfolio/common/interfaces';
import { hasPermission, permissions } from '@ghostfolio/common/permissions';
import { NotificationService } from '@ghostfolio/ui/notifications';
import { DataService } from '@ghostfolio/ui/services';

import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  CUSTOM_ELEMENTS_SCHEMA,
  DestroyRef,
  OnInit
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import {
  FormBuilder,
  FormsModule,
  ReactiveFormsModule,
  Validators
} from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelect, MatSelectModule } from '@angular/material/select';
import {
  MatSlideToggleChange,
  MatSlideToggleModule
} from '@angular/material/slide-toggle';
import { MatSnackBar } from '@angular/material/snack-bar';
import { RouterModule } from '@angular/router';
import { IonIcon } from '@ionic/angular/standalone';
import { format, parseISO } from 'date-fns';
import { addIcons } from 'ionicons';
import { eyeOffOutline, eyeOutline } from 'ionicons/icons';
import ms from 'ms';
import { EMPTY, throwError } from 'rxjs';
import { catchError } from 'rxjs/operators';

/**
 * The stable event identifier a refused settings write is reported under.
 *
 * Fixed so it stays searchable, and carrying the reason only - never the response -
 * because a settings write names what the viewer was changing.
 */
const USER_SETTING_WRITE_FAILED_EVENT = 'GF-USER-SETTING-WRITE-FAILED';

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    FormsModule,
    IonIcon,
    MatButtonModule,
    MatCardModule,
    MatFormFieldModule,
    MatInputModule,
    MatSelectModule,
    MatSlideToggleModule,
    ReactiveFormsModule,
    RouterModule
  ],
  schemas: [CUSTOM_ELEMENTS_SCHEMA],
  selector: 'gf-user-account-settings',
  styleUrls: ['./user-account-settings.scss'],
  templateUrl: './user-account-settings.html'
})
export class GfUserAccountSettingsComponent implements OnInit {
  public appearancePlaceholder = $localize`Auto`;
  public baseCurrency: string;
  public currencies: string[] = [];
  public deleteOwnUserForm = this.formBuilder.group({
    accessToken: ['', Validators.required]
  });
  public hasPermissionToDeleteOwnUser: boolean;
  public hasPermissionToUpdateUserSettings: boolean;
  public isAccessTokenHidden = true;
  public isFingerprintSupported = this.doesBrowserSupportAuthn();
  public isWebAuthnEnabled: boolean;
  public language = document.documentElement.lang;
  public locales = [
    'ca',
    'de',
    'de-CH',
    'en-GB',
    'en-US',
    'es',
    'fr',
    'it',
    'ko',
    'nl',
    'pl',
    'pt',
    'tr',
    'uk',
    'zh'
  ];
  public user: User;

  public constructor(
    private changeDetectorRef: ChangeDetectorRef,
    private dataService: DataService,
    private destroyRef: DestroyRef,
    private formBuilder: FormBuilder,
    private notificationService: NotificationService,
    private settingsStorageService: SettingsStorageService,
    private snackBar: MatSnackBar,
    private userService: UserService,
    public webAuthnService: WebAuthnService
  ) {
    const { baseCurrency, currencies } = this.dataService.fetchInfo();

    this.baseCurrency = baseCurrency;
    this.currencies = currencies;

    this.userService.stateChanged
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((state) => {
        if (state?.user) {
          this.user = state.user;

          this.hasPermissionToDeleteOwnUser = hasPermission(
            this.user.permissions,
            permissions.deleteOwnUser
          );

          this.hasPermissionToUpdateUserSettings = hasPermission(
            this.user.permissions,
            permissions.updateUserSettings
          );

          this.locales.push(this.user.settings.locale);
          this.locales = Array.from(new Set(this.locales)).sort();

          this.changeDetectorRef.markForCheck();
        }
      });

    addIcons({ eyeOffOutline, eyeOutline });
  }

  public ngOnInit() {
    this.update();
  }

  public isCommunityLanguage() {
    return !['de', 'en'].includes(this.language);
  }

  /**
   * @param aKey the settings key the selection writes.
   * @param aValue the option that was chosen.
   * @param aSource the selection itself, so a refused write can put it back. Optional
   * because the value alone is enough to make the write, and the specs exercise the
   * write without standing up a Material selection to carry.
   */
  public onChangeUserSetting(
    aKey: string,
    aValue: string,
    aSource?: MatSelect
  ) {
    this.writeUserSetting(
      { [aKey]: aValue },
      () => {
        if (aKey === 'language') {
          if (aValue) {
            window.location.href = `../${aValue}/`;
          } else {
            window.location.href = '../';
          }
        }
      },
      () => {
        if (aSource) {
          aSource.value = this.getReconciledSettingValue(aKey);
        }
      }
    );
  }

  public onCloseAccount() {
    this.notificationService.confirm({
      confirmFn: () => {
        this.dataService
          .deleteOwnUser({
            accessToken: this.deleteOwnUserForm.get('accessToken').value
          })
          .pipe(
            catchError(() => {
              this.notificationService.alert({
                title: $localize`Oops! Incorrect Security Token.`
              });

              return EMPTY;
            }),
            takeUntilDestroyed(this.destroyRef)
          )
          .subscribe(() => {
            this.userService.signOut();

            document.location.href = `/${document.documentElement.lang}`;
          });
      },
      confirmType: ConfirmationDialogType.Warn,
      title: $localize`Do you really want to close your Ghostfolio account?`
    });
  }

  public onExperimentalFeaturesChange(aEvent: MatSlideToggleChange) {
    this.writeUserSetting(
      { isExperimentalFeatures: aEvent.checked },
      undefined,
      () => {
        aEvent.source.checked =
          this.getReconciledSettingValue('isExperimentalFeatures') === true;
      }
    );
  }

  public onExport() {
    this.dataService
      .fetchExport()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((data) => {
        for (const activity of data.activities) {
          delete activity.id;
        }

        downloadAsFile({
          content: data,
          fileName: `ghostfolio-export-${format(
            parseISO(data.meta.date),
            'yyyyMMddHHmm'
          )}.json`,
          format: 'json'
        });
      });
  }

  public onRestrictedViewChange(aEvent: MatSlideToggleChange) {
    this.writeUserSetting(
      { isRestrictedView: aEvent.checked },
      undefined,
      () => {
        aEvent.source.checked =
          this.getReconciledSettingValue('isRestrictedView') === true;
      }
    );
  }

  public async onSignInWithFingerprintChange(aEvent: MatSlideToggleChange) {
    if (aEvent.checked) {
      try {
        await this.registerDevice();
      } catch {
        aEvent.source.checked = false;

        this.changeDetectorRef.markForCheck();
      }
    } else {
      this.notificationService.confirm({
        confirmFn: () => {
          this.deregisterDevice();
        },
        discardFn: () => {
          this.update();
        },
        confirmType: ConfirmationDialogType.Warn,
        title: $localize`Do you really want to remove this sign in method?`
      });
    }
  }

  private deregisterDevice() {
    this.webAuthnService
      .deregister()
      .pipe(
        catchError(() => {
          this.update();

          return EMPTY;
        }),
        takeUntilDestroyed(this.destroyRef)
      )
      .subscribe(() => {
        this.update();
      });
  }

  private doesBrowserSupportAuthn() {
    // Authn is built on top of PublicKeyCredential: https://stackoverflow.com/a/55868189
    return typeof PublicKeyCredential !== 'undefined';
  }

  private registerDevice(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.webAuthnService
        .register()
        .pipe(
          catchError((error: Error) => {
            this.snackBar.open(
              $localize`Oops! There was an error setting up biometric authentication.`,
              undefined,
              {
                duration: ms('3 seconds')
              }
            );

            return throwError(() => {
              return error;
            });
          }),
          takeUntilDestroyed(this.destroyRef)
        )
        .subscribe({
          next: () => {
            this.settingsStorageService.removeSetting(KEY_STAY_SIGNED_IN);
            this.settingsStorageService.removeSetting(KEY_TOKEN);

            this.update();
            resolve();
          },
          error: (error) => {
            reject(error);
          }
        });
    });
  }

  /**
   * Writes one setting, and makes the screen agree with the server whichever way it goes.
   *
   * Every control here is bound to `user.settings`, and Material applies a toggle or a
   * selection to its own view state the moment it is used. So the screen showed the new
   * value immediately and these writes had no failure handler at all: a refused write
   * left the control sitting in its new position over a server that had kept the old
   * one, said nothing, and stayed that way until something else happened to re-read the
   * viewer. For a switch like restricted view - which decides whether figures are shown
   * at all - that is a setting the viewer believes they have changed and have not.
   *
   * Re-reading the viewer is the reconciliation, on BOTH paths, and it is deliberately
   * the same call in each case. On success it is what it always was. On failure it is a
   * genuine rollback against server truth rather than a guess: no previous value has to
   * be remembered, and no assumption is made about how far the write got.
   *
   * The re-read alone is not enough to move the control, though, and that is worth
   * spelling out because it looks as though it should be. Angular writes an `@Input`
   * only when the bound expression's value has CHANGED since it last wrote it, and the
   * click changed the control's own state, not the recorded binding. So a viewer turning
   * an absent setting on and being refused leaves the expression at `undefined` on both
   * sides of the re-read: nothing is written, and the control keeps the position the
   * click gave it, showing on over a server holding off. `aRebindControl` is what closes
   * that gap - it writes the reconciled value straight onto the control instance, the
   * same way the fingerprint toggle already puts itself back when registration fails.
   * It runs on both paths, where on success it is simply a no-op agreeing with itself.
   *
   * @param aSetting the single setting to write.
   * @param aOnSuccess anything that must happen only if the write was accepted.
   * @param aRebindControl puts the control that was used back to what the server holds,
   * called once the re-read has landed so it reads reconciled state.
   */
  private writeUserSetting(
    aSetting: Record<string, boolean | string>,
    aOnSuccess?: () => void,
    aRebindControl?: () => void
  ) {
    this.dataService
      .putUserSetting(aSetting)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        error: (error: unknown) => {
          this.reconcileUserSettings(aRebindControl);

          this.notificationService.alert({
            title: $localize`Your setting could not be saved. Please try again.`
          });

          reportSanitizedError(USER_SETTING_WRITE_FAILED_EVENT, error);
        },
        next: () => {
          this.reconcileUserSettings(() => {
            aRebindControl?.();

            aOnSuccess?.();
          });
        }
      });
  }

  /**
   * What the server holds for one setting, read after a reconciliation.
   *
   * Used to put a control back, so it answers in the shape the control binds to:
   * `null` for an absent value, because the selections that can be cleared carry a
   * `null` option and would otherwise match none of theirs.
   *
   * `language` is the exception and is not read from the viewer at all - it is the
   * locale the document was served under, and it changes only by departing to another
   * one. A refused language write never departs, so the served locale IS the truth.
   *
   * @param aKey the settings key the control writes.
   */
  private getReconciledSettingValue(aKey: string) {
    if (aKey === 'language') {
      return this.language;
    }

    // Indexed by a key the caller names rather than by a literal, so the cast is what
    // lets one accessor serve every control instead of one accessor per setting.
    const settings = this.user?.settings as unknown as Record<string, unknown>;

    return settings?.[aKey] ?? null;
  }

  /**
   * Re-reads the viewer, so what is on the screen is what the server holds.
   *
   * `get(true)` bypasses the cache on purpose: a cached answer would repeat the state
   * this method exists to check.
   */
  private reconcileUserSettings(aAfterwards?: () => void) {
    this.userService
      .get(true)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((user) => {
        this.user = user;

        // Before the mark, so a control put back by `aAfterwards` is picked up by the
        // same pass that renders the reconciled viewer.
        aAfterwards?.();

        this.changeDetectorRef.markForCheck();
      });
  }

  private update() {
    this.isWebAuthnEnabled = this.webAuthnService.isEnabled() ?? false;

    this.changeDetectorRef.markForCheck();
  }
}
