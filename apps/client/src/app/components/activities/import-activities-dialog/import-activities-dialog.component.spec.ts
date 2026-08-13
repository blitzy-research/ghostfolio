import { ImportActivitiesService } from '@ghostfolio/client/services/import-activities.service';
import type { User } from '@ghostfolio/common/interfaces';
import { DataService } from '@ghostfolio/ui/services';

import { ComponentFixture, TestBed } from '@angular/core/testing';
import { MatDialogRef, MAT_DIALOG_DATA } from '@angular/material/dialog';
import { MatSnackBar } from '@angular/material/snack-bar';
import type { MatStepper } from '@angular/material/stepper';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { DeviceDetectorService } from 'ngx-device-detector';
import { Observable, of, throwError } from 'rxjs';

import { GfImportActivitiesDialogComponent } from './import-activities-dialog.component';

/**
 * The import dialog, and the three ways it could stop responding.
 *
 * Reading the file was the worst of them. Only `FileReader`'s `load` handler was ever
 * wired up, so a file the browser cannot read - revoked while the picker was open, on a
 * disconnected volume, refused by the operating system - and a read the viewer aborts
 * both left `load` unfired. The indefinite "Validating data…" notice the dialog opens
 * stayed up for good, the stepper never advanced, and nothing was waiting, so no timeout
 * would ever have caught it.
 *
 * The dividend read and the holdings read had the same shape: each disables the control
 * that started it and neither had a failure handler, so a refusal left the dialog
 * permanently unusable without saying anything.
 *
 * And the import itself closed the dialog from a `finally`, which threw away a validated
 * selection - the one thing here that cannot be cheaply reproduced - at the exact moment
 * it became useful.
 */
describe('GfImportActivitiesDialogComponent', () => {
  let component: GfImportActivitiesDialogComponent;
  let fixture: ComponentFixture<GfImportActivitiesDialogComponent>;
  let close: jest.Mock;
  let importSelectedActivities: jest.Mock;
  let reports: unknown[][];
  let snackBarDismissals: number;
  let snackBarMessages: string[];

  /**
   * The reader the component builds, captured so a test can drive the outcome the browser
   * would have produced. `FileReader` is constructed inside the method under test, so the
   * constructor is what has to be reached.
   */
  let capturedReader: {
    error?: unknown;
    onabort?: () => void;
    onerror?: () => void;
    onload?: (event: unknown) => void;
    readAsText: jest.Mock;
  };

  let originalFileReader: typeof FileReader;

  const stepper = {
    next: jest.fn(),
    reset: jest.fn()
  } as unknown as MatStepper;

  const createComponent = async ({
    activityTypes,
    holdingsResponse = of({ holdings: [] }),
    dividendsResponse = of({ activities: [] })
  }: {
    activityTypes?: string[];
    holdingsResponse?: Observable<unknown>;
    dividendsResponse?: Observable<unknown>;
  } = {}) => {
    close = jest.fn();
    importSelectedActivities = jest.fn(() => Promise.resolve(undefined));
    reports = [];
    snackBarDismissals = 0;
    snackBarMessages = [];

    jest.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      reports.push(args);
    });

    TestBed.resetTestingModule();

    await TestBed.configureTestingModule({
      imports: [GfImportActivitiesDialogComponent],
      providers: [
        provideNoopAnimations(),
        {
          provide: DataService,
          useValue: {
            fetchDividendsImport: () => dividendsResponse,
            fetchPortfolioHoldings: () => holdingsResponse
          }
        },
        {
          provide: DeviceDetectorService,
          useValue: { getDeviceInfo: () => ({ deviceType: 'desktop' }) }
        },
        {
          provide: ImportActivitiesService,
          useValue: {
            importCsv: () => Promise.resolve({}),
            importJson: () => Promise.resolve({}),
            importSelectedActivities
          }
        },
        {
          provide: MAT_DIALOG_DATA,
          useValue: {
            activityTypes,
            deviceType: 'desktop',
            user: {
              accounts: [],
              settings: { locale: 'en' }
            } as unknown as User
          }
        },
        { provide: MatDialogRef, useValue: { close } },
        {
          provide: MatSnackBar,
          useValue: {
            dismiss: () => {
              snackBarDismissals += 1;
            },
            open: (message: string) => {
              snackBarMessages.push(message);

              return { onAction: () => of(undefined) };
            }
          }
        }
      ]
    })
      // The stepper, the activities table and the file-drop target all belong to the
      // steps this spec never renders, and each drags in its own dependencies. What is
      // under test is the component's own handling, which is reachable directly.
      .overrideComponent(GfImportActivitiesDialogComponent, {
        set: { template: '' }
      })
      .compileComponents();

    fixture = TestBed.createComponent(GfImportActivitiesDialogComponent);
    component = fixture.componentInstance;

    fixture.detectChanges();

    return component;
  };

  /** Drives the file read the way the picker would, and returns the reader. */
  const readFile = () => {
    (
      component as unknown as {
        handleFile: (params: { file: File; stepper: MatStepper }) => void;
      }
    ).handleFile({
      stepper,
      file: { name: 'activities.json' } as File
    });

    return capturedReader;
  };

  beforeEach(() => {
    capturedReader = undefined;

    originalFileReader = window.FileReader;

    window.FileReader = function () {
      capturedReader = {
        readAsText: jest.fn()
      } as unknown as typeof capturedReader;

      return capturedReader;
    } as unknown as typeof FileReader;
  });

  afterEach(() => {
    window.FileReader = originalFileReader;

    jest.restoreAllMocks();
  });

  describe('a file the browser cannot read', () => {
    it('ends, rather than validating for ever', async () => {
      await createComponent();

      const reader = readFile();

      expect(snackBarMessages[0]).toContain('Validating data');

      reader.error = { name: 'NotReadableError' };
      reader.onerror();

      // The three things that were missing: the notice comes down, the reason is
      // listed, and the stepper moves on so the dialog is usable again.
      expect(snackBarDismissals).toBe(1);
      expect(component.errorMessages).toEqual([
        'The file could not be read. Please check the file and try again.'
      ]);
      expect(stepper.next).toHaveBeenCalled();
    });

    it('is reported without naming the file', async () => {
      await createComponent();

      const reader = readFile();

      reader.error = { name: 'NotReadableError' };
      reader.onerror();

      expect(reports).toEqual([['GF-ACTIVITIES-IMPORT-FILE-READ-FAILED']]);
      expect(JSON.stringify(reports)).not.toContain('activities.json');
    });
  });

  describe('a read the viewer cancels', () => {
    it('ends the same way, and says so plainly', async () => {
      await createComponent();

      const reader = readFile();

      reader.onabort();

      expect(snackBarDismissals).toBe(1);
      expect(component.errorMessages).toEqual([
        'Reading the file was cancelled.'
      ]);
      expect(stepper.next).toHaveBeenCalled();
    });

    it('is not reported as a fault, because nothing failed', async () => {
      await createComponent();

      readFile().onabort();

      expect(reports).toEqual([]);
    });
  });

  describe('a dividend read that fails', () => {
    it('gives the control back', async () => {
      await createComponent({
        activityTypes: ['DIVIDEND'],
        dividendsResponse: throwError(() => ({ status: 500 }))
      });

      component.assetProfileForm
        .get('assetProfileIdentifier')
        .setValue({ dataSource: 'YAHOO', symbol: 'AAPL' });

      component.onLoadDividends(stepper);

      // It was disabled to stop a second request and stayed that way: the viewer could
      // neither retry nor choose a different holding.
      expect(
        component.assetProfileForm.get('assetProfileIdentifier').disabled
      ).toBe(false);
      expect(snackBarMessages.join(' ')).toContain(
        'The dividends could not be loaded.'
      );
      expect(reports).toEqual([
        ['GF-ACTIVITIES-IMPORT-DIVIDENDS-FAILED (status 500)']
      ]);
    });
  });

  describe('a holdings read that fails', () => {
    it('settles both the flag and the control', async () => {
      await createComponent({
        activityTypes: ['DIVIDEND'],
        holdingsResponse: throwError(() => ({ status: 500 }))
      });

      // The flag draws the placeholder and the control was disabled until the list
      // arrived, so leaving either as it was left the dialog permanently unusable.
      expect(component.isLoading).toBe(false);
      expect(
        component.assetProfileForm.get('assetProfileIdentifier').disabled
      ).toBe(false);
      expect(snackBarMessages.join(' ')).toContain(
        'Your holdings could not be loaded.'
      );
    });
  });

  describe('an import that fails', () => {
    beforeEach(async () => {
      await createComponent();

      component.selectedActivities = [{ id: 'activity-a' }] as never;
      importSelectedActivities.mockReturnValue(
        Promise.reject(new Error('refused'))
      );
    });

    it('keeps the dialog, and the selection with it', async () => {
      await component.onImportActivities();

      // The selection took a file, a parse and a set of choices to produce. Closing
      // here is what made a retry start from the file picker.
      expect(close).not.toHaveBeenCalled();
      expect(component.selectedActivities).toHaveLength(1);
    });

    it('says what happened, and that nothing was added', async () => {
      await component.onImportActivities();

      expect(component.errorMessage).toBe(
        'The import could not be completed. Nothing has been added to your activities. Please try again.'
      );
      expect(component.isImporting).toBe(false);
    });

    it('takes down the progress notice it raised', async () => {
      await component.onImportActivities();

      // Opened without a duration, so it would otherwise have stayed up beside the
      // failure message contradicting it.
      expect(snackBarDismissals).toBe(1);
    });

    it('lets the viewer try the same selection again', async () => {
      await component.onImportActivities();

      importSelectedActivities.mockReturnValue(Promise.resolve(undefined));

      await component.onImportActivities();

      expect(importSelectedActivities).toHaveBeenCalledTimes(2);
      expect(close).toHaveBeenCalled();
      expect(component.errorMessage).toBeUndefined();
    });

    it('is reported without naming what was being imported', async () => {
      await component.onImportActivities();

      expect(reports).toEqual([['GF-ACTIVITIES-IMPORT-SELECTED-FAILED']]);
    });
  });

  describe('an import that succeeds', () => {
    it('closes', async () => {
      await createComponent();

      component.selectedActivities = [{ id: 'activity-a' }] as never;

      await component.onImportActivities();

      expect(close).toHaveBeenCalled();
      expect(component.errorMessage).toBeUndefined();
    });

    it('sends one request for two presses', async () => {
      await createComponent();

      component.selectedActivities = [{ id: 'activity-a' }] as never;

      // A request that never settles, which is the window a second press lands in.
      importSelectedActivities.mockReturnValue(new Promise(() => undefined));

      void component.onImportActivities();
      void component.onImportActivities();

      expect(importSelectedActivities).toHaveBeenCalledTimes(1);
    });
  });
});
