import {
  KEY_STAY_SIGNED_IN,
  SettingsStorageService
} from '@ghostfolio/client/services/settings-storage.service';
import { TokenStorageService } from '@ghostfolio/client/services/token-storage.service';
import { GfDialogHeaderComponent } from '@ghostfolio/ui/dialog-header';

import { ChangeDetectionStrategy, Component, Inject } from '@angular/core';
import { FormControl, ReactiveFormsModule, Validators } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import {
  MatCheckboxChange,
  MatCheckboxModule
} from '@angular/material/checkbox';
import {
  MAT_DIALOG_DATA,
  MatDialogModule,
  MatDialogRef
} from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { IonIcon } from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import { eyeOffOutline, eyeOutline } from 'ionicons/icons';

// A value import rather than `import type`, matching the sibling dialogs. The
// decorated constructor parameter below is downlevelled to a `static
// ctorParameters` member that names this type, and `import type` erases the
// binding it names - so the component throws `ReferenceError` the moment it is
// instantiated under the spec transform, which is what kept it untestable. The
// module holds only interfaces, so the import contributes nothing to the bundle.
import { LoginWithAccessTokenDialogParams } from './interfaces/interfaces';

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    GfDialogHeaderComponent,
    IonIcon,
    MatButtonModule,
    MatCheckboxModule,
    MatDialogModule,
    MatFormFieldModule,
    MatInputModule,
    ReactiveFormsModule
  ],
  selector: 'gf-login-with-access-token-dialog',
  styleUrls: ['./login-with-access-token-dialog.scss'],
  templateUrl: './login-with-access-token-dialog.html'
})
export class GfLoginWithAccessTokenDialogComponent {
  public accessTokenFormControl = new FormControl(
    this.data.accessToken,
    Validators.required
  );
  public isAccessTokenHidden = true;

  public constructor(
    @Inject(MAT_DIALOG_DATA) public data: LoginWithAccessTokenDialogParams,
    public dialogRef: MatDialogRef<GfLoginWithAccessTokenDialogComponent>,
    private settingsStorageService: SettingsStorageService,
    private tokenStorageService: TokenStorageService
  ) {
    addIcons({ eyeOffOutline, eyeOutline });
  }

  /**
   * Records that this browser is the one starting an external sign-in.
   *
   * These two links are the only places the application begins a Google or OpenID
   * Connect flow, and the identity provider returns the resulting token to the
   * address bar. Without a record of having asked, the root host cannot tell that
   * token apart from one somebody sent in a link - and adopting a sent token hands
   * the sender's account to the visitor, whose portfolio entries then land in it.
   *
   * Written synchronously in the click handler, before the anchor's own navigation
   * takes the browser to the provider. Session storage survives that journey and
   * comes back with the tab, which is what makes this a proof about *this*
   * browser rather than a flag anybody can set.
   *
   * A sign-in abandoned at the provider leaves the mark behind; it expires on its
   * own, and the root host spends it whether or not it was used.
   */
  public onStartExternalSignIn() {
    this.tokenStorageService.markExternalSignInStarted();
  }

  public onChangeStaySignedIn(aValue: MatCheckboxChange) {
    this.settingsStorageService.setSetting(
      KEY_STAY_SIGNED_IN,
      aValue.checked?.toString()
    );
  }

  public onClose() {
    this.dialogRef.close();
  }

  /**
   * Signs in with the security token that was entered.
   *
   * The refusal is now reported. Pressing Enter on an empty field reaches this
   * method, and the early return used to be the entire response: no message, no
   * change, nothing to read. Marking the control touched is what renders the error
   * Material has been holding all along, so the field states what it wants instead
   * of appearing to ignore the visitor.
   */
  public onLoginWithAccessToken() {
    if (this.accessTokenFormControl.valid) {
      this.dialogRef.close({
        accessToken: this.accessTokenFormControl.value
      });

      return;
    }

    this.accessTokenFormControl.markAsTouched();
  }
}
