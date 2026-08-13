import { GfFileDropDirective } from '@ghostfolio/client/directives/file-drop/file-drop.directive';
import { ImportActivitiesService } from '@ghostfolio/client/services/import-activities.service';
import {
  CreateAccountWithBalancesDto,
  CreateAssetProfileWithMarketDataDto,
  CreateTagDto
} from '@ghostfolio/common/dtos';
import { reportSanitizedError } from '@ghostfolio/common/helper';
import { Activity, PortfolioPosition } from '@ghostfolio/common/interfaces';
import { GfSymbolPipe } from '@ghostfolio/common/pipes';
import { GfActivitiesTableComponent } from '@ghostfolio/ui/activities-table';
import { GfDialogFooterComponent } from '@ghostfolio/ui/dialog-footer';
import { GfDialogHeaderComponent } from '@ghostfolio/ui/dialog-header';
import { DataService } from '@ghostfolio/ui/services';

import {
  StepperOrientation,
  StepperSelectionEvent
} from '@angular/cdk/stepper';
import { CommonModule } from '@angular/common';
import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  DestroyRef,
  inject
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import {
  FormBuilder,
  FormGroup,
  ReactiveFormsModule,
  Validators
} from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import {
  MAT_DIALOG_DATA,
  MatDialogModule,
  MatDialogRef
} from '@angular/material/dialog';
import { MatExpansionModule } from '@angular/material/expansion';
import { MatFormFieldModule } from '@angular/material/form-field';
import { PageEvent } from '@angular/material/paginator';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatSelectModule } from '@angular/material/select';
import { MatSnackBar } from '@angular/material/snack-bar';
import { SortDirection } from '@angular/material/sort';
import { MatStepper, MatStepperModule } from '@angular/material/stepper';
import { MatTableDataSource } from '@angular/material/table';
import { IonIcon } from '@ionic/angular/standalone';
import { AssetClass } from '@prisma/client';
import { addIcons } from 'ionicons';
import { cloudUploadOutline, warningOutline } from 'ionicons/icons';
import { isArray, sortBy } from 'lodash';
import ms from 'ms';
import { DeviceDetectorService } from 'ngx-device-detector';

import { ImportStep } from './enums/import-step';
import type { ImportActivitiesDialogParams } from './interfaces/interfaces';

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'd-flex flex-column h-100' },
  imports: [
    CommonModule,
    GfActivitiesTableComponent,
    GfDialogFooterComponent,
    GfDialogHeaderComponent,
    GfFileDropDirective,
    GfSymbolPipe,
    IonIcon,
    MatButtonModule,
    MatDialogModule,
    MatExpansionModule,
    MatFormFieldModule,
    MatProgressSpinnerModule,
    MatSelectModule,
    MatStepperModule,
    ReactiveFormsModule
  ],
  selector: 'gf-import-activities-dialog',
  styleUrls: ['./import-activities-dialog.scss'],
  templateUrl: 'import-activities-dialog.html'
})
export class GfImportActivitiesDialogComponent {
  public accounts: CreateAccountWithBalancesDto[] = [];
  public activities: Activity[] = [];
  public assetProfileForm: FormGroup;
  public assetProfiles: CreateAssetProfileWithMarketDataDto[] = [];
  public dataSource: MatTableDataSource<Activity>;
  public details: any[] = [];
  public deviceType: string;
  public dialogTitle = $localize`Import Activities`;
  public errorMessages: string[] = [];
  public holdings: PortfolioPosition[] = [];
  public importStep: ImportStep = ImportStep.UPLOAD_FILE;
  /**
   * Why the last import attempt did not go through, stated beside the control that
   * produced it.
   *
   * Held here rather than raised as a notice because the selection it applies to is still
   * on the screen and still submittable - the message and the retry belong together.
   */
  public errorMessage: string;

  /** Whether an import is in flight, so the control cannot be pressed twice. */
  public isImporting = false;

  public isLoading = false;
  public mode: 'DIVIDEND';
  public pageIndex = 0;
  public pageSize = 8;
  public selectedActivities: Activity[] = [];
  public sortColumn = 'date';
  public sortDirection: SortDirection = 'desc';
  public stepperOrientation: StepperOrientation;
  public tags: CreateTagDto[] = [];
  public totalItems: number;

  /**
   * What this dialog was opened with.
   *
   * Taken through `inject` rather than as a constructor parameter, deliberately. The
   * parameter form makes Angular's runtime reflection depend on
   * `ImportActivitiesDialogParams` being a real value, and it is an interface imported
   * with `import type` - erased at emit - so reflecting this class threw
   * `ReferenceError: ImportActivitiesDialogParams is not defined` wherever the compiler
   * did not erase the reference with it. The ahead-of-time build never reflects, which
   * is why the application was unaffected and only a test ever saw it.
   */
  public readonly data = inject<ImportActivitiesDialogParams>(MAT_DIALOG_DATA);

  public constructor(
    private changeDetectorRef: ChangeDetectorRef,
    private dataService: DataService,
    private destroyRef: DestroyRef,
    private deviceService: DeviceDetectorService,
    private formBuilder: FormBuilder,
    public dialogRef: MatDialogRef<GfImportActivitiesDialogComponent>,
    private importActivitiesService: ImportActivitiesService,
    private snackBar: MatSnackBar
  ) {
    addIcons({ cloudUploadOutline, warningOutline });
  }

  public ngOnInit() {
    this.deviceType = this.deviceService.getDeviceInfo().deviceType;
    this.stepperOrientation =
      this.deviceType === 'mobile' ? 'vertical' : 'horizontal';

    this.assetProfileForm = this.formBuilder.group({
      assetProfileIdentifier: [undefined, Validators.required]
    });

    if (
      this.data?.activityTypes?.length === 1 &&
      this.data?.activityTypes?.[0] === 'DIVIDEND'
    ) {
      this.isLoading = true;

      this.dialogTitle = $localize`Import Dividends`;
      this.mode = 'DIVIDEND';
      this.assetProfileForm.get('assetProfileIdentifier').disable();

      this.dataService
        .fetchPortfolioHoldings({
          filters: [
            {
              id: AssetClass.EQUITY,
              type: 'ASSET_CLASS'
            },
            {
              id: AssetClass.FIXED_INCOME,
              type: 'ASSET_CLASS'
            }
          ],
          range: 'max'
        })
        .pipe(takeUntilDestroyed(this.destroyRef))
        .subscribe({
          error: (error: unknown) => {
            // Both flags are settled here for the same reason: the loading flag draws
            // the placeholder and the control was disabled until the list arrived, so
            // leaving either as it was left the dialog permanently unusable with
            // nothing said. Re-enabled empty, which the required validator already
            // handles - the viewer can close, or retry by reopening.
            this.assetProfileForm.get('assetProfileIdentifier').enable();

            this.isLoading = false;

            reportSanitizedError('GF-ACTIVITIES-IMPORT-HOLDINGS-FAILED', error);

            this.snackBar.open(
              $localize`Your holdings could not be loaded.` +
                ' ' +
                $localize`Please try again later.`,
              undefined,
              { duration: ms('6 seconds') }
            );

            this.changeDetectorRef.markForCheck();
          },
          next: ({ holdings }) => {
            this.holdings = sortBy(holdings, ({ name }) => {
              return name.toLowerCase();
            });
            this.assetProfileForm.get('assetProfileIdentifier').enable();

            this.isLoading = false;

            this.changeDetectorRef.markForCheck();
          }
        });
    }
  }

  public onCancel() {
    this.dialogRef.close();
  }

  /**
   * Imports the selected activities, and closes ONLY once that worked.
   *
   * It used to close either way, from a `finally`. That threw away the one thing the
   * viewer could not cheaply reproduce - a validated selection, arrived at by choosing a
   * file, waiting for it to be parsed and picking rows out of the result - and it did so
   * at the exact moment it became useful, leaving a six-second notice as the only trace
   * of what had happened. Retrying meant starting from the file picker.
   *
   * So the dialog now survives a failure, holding the selection, with the reason stated
   * beside the control that produced it. The server-side counterpart of this is in
   * `ImportService.import`, which removes the asset profiles a failed import created and
   * left unreferenced - together they mean a retry starts from a clean state rather than
   * accumulating litter with each attempt.
   */
  public async onImportActivities() {
    if (this.isImporting) {
      return;
    }

    this.errorMessage = undefined;
    this.isImporting = true;

    this.changeDetectorRef.markForCheck();

    try {
      this.snackBar.open('⏳ ' + $localize`Importing data...`);

      await this.importActivitiesService.importSelectedActivities({
        accounts: this.accounts,
        activities: this.selectedActivities,
        assetProfiles: this.assetProfiles,
        tags: this.tags
      });

      this.snackBar.open(
        '✅ ' + $localize`Import has been completed`,
        undefined,
        {
          duration: ms('3 seconds')
        }
      );

      this.isImporting = false;

      this.dialogRef.close();
    } catch (error) {
      this.snackBar.dismiss();

      this.errorMessage = $localize`The import could not be completed. Nothing has been added to your activities. Please try again.`;
      this.isImporting = false;

      reportSanitizedError('GF-ACTIVITIES-IMPORT-SELECTED-FAILED', error);

      this.changeDetectorRef.markForCheck();
    }
  }

  public onFilesDropped({
    files,
    stepper
  }: {
    files: FileList;
    stepper: MatStepper;
  }) {
    if (files.length === 0) {
      return;
    }

    this.handleFile({ stepper, file: files[0] });
  }

  public onImportStepChange(event: StepperSelectionEvent) {
    if (event.selectedIndex === ImportStep.UPLOAD_FILE) {
      this.importStep = ImportStep.UPLOAD_FILE;
    } else if (event.selectedIndex === ImportStep.SELECT_ACTIVITIES) {
      this.importStep = ImportStep.SELECT_ACTIVITIES;
    }
  }

  public onLoadDividends(aStepper: MatStepper) {
    this.assetProfileForm.get('assetProfileIdentifier').disable();

    const { dataSource, symbol } = this.assetProfileForm.get(
      'assetProfileIdentifier'
    ).value;

    this.dataService
      .fetchDividendsImport({
        dataSource,
        symbol
      })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        error: (error: unknown) => {
          // The control was disabled a moment ago to stop a second request, and with no
          // failure handler it stayed that way: the viewer could neither retry nor pick
          // a different holding, and the stepper never advanced. Re-enabling it is the
          // fix, and the reason is listed where the dialog lists import problems.
          this.assetProfileForm.get('assetProfileIdentifier').enable();

          reportSanitizedError('GF-ACTIVITIES-IMPORT-DIVIDENDS-FAILED', error);

          this.snackBar.open(
            $localize`The dividends could not be loaded.` +
              ' ' +
              $localize`Please try again later.`,
            undefined,
            { duration: ms('6 seconds') }
          );

          this.changeDetectorRef.markForCheck();
        },
        next: ({ activities }) => {
          this.activities = activities;
          this.dataSource = new MatTableDataSource(activities.reverse());
          this.pageIndex = 0;
          this.totalItems = activities.length;

          aStepper.next();

          this.changeDetectorRef.markForCheck();
        }
      });
  }

  public onPageChanged({ pageIndex }: PageEvent) {
    this.pageIndex = pageIndex;
  }

  public onReset(aStepper: MatStepper) {
    this.details = [];
    this.errorMessage = undefined;
    this.errorMessages = [];
    this.importStep = ImportStep.SELECT_ACTIVITIES;
    this.pageIndex = 0;
    this.assetProfileForm.get('assetProfileIdentifier').enable();

    aStepper.reset();
  }

  public onSelectFile(stepper: MatStepper) {
    const input = document.createElement('input');
    input.accept = 'application/JSON, .csv';
    input.type = 'file';

    input.onchange = (event) => {
      const file = (event.target as HTMLInputElement).files[0];
      this.handleFile({ file, stepper });
    };

    input.click();
  }

  public updateSelection(activities: Activity[]) {
    this.selectedActivities = activities.filter(({ error }) => {
      return !error;
    });
  }

  private async handleFile({
    file,
    stepper
  }: {
    file: File;
    stepper: MatStepper;
  }): Promise<void> {
    this.snackBar.open('⏳ ' + $localize`Validating data...`);

    const reader = new FileReader();

    /**
     * The two outcomes that are not `load`, and the reason this method could hang.
     *
     * Only `onload` was ever wired up. A file the browser cannot read - revoked while
     * the picker was open, on a disconnected volume, or refused by the operating system
     * - and a read the viewer aborts both leave `load` unfired, so the indefinite
     * "Validating data…" notice this method opens stayed up for good, the stepper never
     * advanced, and the dialog offered nothing to press. There is no timeout that would
     * catch it either, because nothing was waiting.
     *
     * Both are answered the same way, and deliberately through the same failure path the
     * dialog already has for an unparseable file: the notice is dismissed, the stepper
     * advances, and the reason is listed where every other import problem is listed.
     */
    reader.onabort = () => {
      this.handleUnreadableFile(
        $localize`Reading the file was cancelled.`,
        stepper
      );
    };

    reader.onerror = () => {
      reportSanitizedError(
        'GF-ACTIVITIES-IMPORT-FILE-READ-FAILED',
        reader.error
      );

      this.handleUnreadableFile(
        $localize`The file could not be read. Please check the file and try again.`,
        stepper
      );
    };

    reader.readAsText(file, 'UTF-8');

    reader.onload = async (readerEvent) => {
      const fileContent = readerEvent.target.result as string;
      const fileExtension = file.name.split('.').pop()?.toLowerCase();

      try {
        if (fileExtension === 'json') {
          const content = JSON.parse(fileContent);

          this.accounts = content.accounts;
          this.assetProfiles = content.assetProfiles;
          this.tags = content.tags;

          if (!isArray(content.activities)) {
            if (isArray(content.orders)) {
              this.handleImportError({
                activities: [],
                error: {
                  error: {
                    message: [`orders needs to be renamed to activities`]
                  }
                }
              });
              return;
            } else {
              throw new Error();
            }
          }

          content.activities = content.activities.map((activity) => {
            if (activity.id) {
              delete activity.id;
            }

            return activity;
          });

          try {
            const { activities } =
              await this.importActivitiesService.importJson({
                accounts: content.accounts,
                activities: content.activities,
                assetProfiles: content.assetProfiles,
                isDryRun: true,
                tags: content.tags
              });

            this.activities = activities;
            this.dataSource = new MatTableDataSource(activities.reverse());
            this.pageIndex = 0;
            this.totalItems = activities.length;
          } catch (error) {
            reportSanitizedError('GF-ACTIVITIES-IMPORT-JSON-FAILED', error);
            this.handleImportError({ error, activities: content.activities });
          }

          return;
        } else if (fileExtension === 'csv') {
          const content = fileContent.split('\n').slice(1);

          try {
            const { activities, assetProfiles } =
              await this.importActivitiesService.importCsv({
                fileContent,
                isDryRun: true,
                userAccounts: this.data.user.accounts
              });

            this.activities = activities;
            this.assetProfiles = assetProfiles;
            this.dataSource = new MatTableDataSource(activities.reverse());
            this.pageIndex = 0;
            this.totalItems = activities.length;
          } catch (error) {
            reportSanitizedError('GF-ACTIVITIES-IMPORT-CSV-FAILED', error);
            this.handleImportError({
              activities: error?.activities ?? content,
              error: {
                error: { message: error?.error?.message ?? [error?.message] }
              }
            });
          }

          return;
        }

        throw new Error();
      } catch (error) {
        reportSanitizedError('GF-ACTIVITIES-IMPORT-FAILED', error);
        this.handleImportError({
          activities: [],
          error: { error: { message: ['Unexpected format'] } }
        });
      } finally {
        this.importStep = ImportStep.SELECT_ACTIVITIES;
        this.snackBar.dismiss();
        this.updateSelection(this.activities);

        stepper.next();

        this.changeDetectorRef.markForCheck();
      }
    };
  }

  /**
   * Ends a file read that produced no content.
   *
   * Routed through the dialog's existing error presentation rather than a notice of its
   * own, so an unreadable file reads the same as an unparseable one - and, critically,
   * so the stepper advances. The alternative was leaving the viewer on the upload step
   * behind a notice that would vanish in six seconds.
   */
  private handleUnreadableFile(aMessage: string, aStepper: MatStepper) {
    this.handleImportError({
      activities: [],
      error: { error: { message: [aMessage] } }
    });

    this.importStep = ImportStep.SELECT_ACTIVITIES;

    this.snackBar.dismiss();

    this.updateSelection(this.activities);

    aStepper.next();

    this.changeDetectorRef.markForCheck();
  }

  private handleImportError({
    activities,
    error
  }: {
    activities: any[];
    error: any;
  }) {
    this.errorMessages = error?.error?.message;

    for (const message of this.errorMessages) {
      if (message.includes('activities.')) {
        let [index] = message.split(' ');
        index = index.replace('activities.', '');
        [index] = index.split('.');

        this.details.push(activities[index]);
      } else {
        this.details.push('');
      }
    }

    this.changeDetectorRef.markForCheck();
  }
}
