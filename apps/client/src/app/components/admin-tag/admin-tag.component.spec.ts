import { UserService } from '@ghostfolio/client/services/user/user.service';
import { NotificationService } from '@ghostfolio/ui/notifications';
import { DataService } from '@ghostfolio/ui/services';

import { ComponentFixture, TestBed } from '@angular/core/testing';
import { MatDialog } from '@angular/material/dialog';
import { ActivatedRoute, Router } from '@angular/router';
import { StatusCodes } from 'http-status-codes';
import { DeviceDetectorService } from 'ngx-device-detector';
import { BehaviorSubject, Observable, of, throwError } from 'rxjs';

import { GfAdminTagComponent } from './admin-tag.component';

// Cut because it is only ever handed to `MatDialog.open`, which is a stub here, and
// because it drags a reactive form tree in behind it for no benefit.
jest.mock(
  './create-or-update-tag-dialog/create-or-update-tag-dialog.component',
  () => ({
    GfCreateOrUpdateTagDialogComponent: class {}
  })
);

/**
 * What the administration screen does when a tag write is refused.
 *
 * A tag is unique per owner by database constraint, so a repeated name is the failure
 * this screen invites most often - and it is the one its viewer can fix in a second, by
 * choosing a different name. Neither write had a failure handler, so the rejection left
 * by the application-wide route: a generic "something went wrong" notice that names
 * nothing, a dialog already dismissed and taking the typed name with it, and a list left
 * exactly as it was. For a create, an unchanged list is indistinguishable from success,
 * which is the part worth pinning: the viewer had no way to tell whether the tag existed.
 *
 * Three claims are made below and each is a separate failure mode:
 *
 * 1. A conflict is named, and named with the tag the viewer typed.
 * 2. Any other refusal is *not* named that way, because inviting somebody to rename a
 *    tag over a database that is unreachable wastes their time.
 * 3. The list is re-read on the failure path, so what is on screen afterwards is what
 *    the server holds rather than an absence the viewer has to interpret.
 */
describe('GfAdminTagComponent', () => {
  const tag = { id: 'TAG_ID', name: 'Emergency Fund', userId: 'USER_ID' };

  /** Every alert raised, in order. The message is the whole of the behaviour. */
  let alertCalls: { title: string }[];

  let component: ComponentFixture<GfAdminTagComponent>['componentInstance'];
  let fetchTags: jest.Mock;
  let fixture: ComponentFixture<GfAdminTagComponent>;

  /** The answer the next `postTag` will give. */
  let postTagResponse: Observable<unknown>;

  /** The answer the next `putTag` will give. */
  let putTagResponse: Observable<unknown>;

  /** What the dialog reports on closing, which is what the write is given. */
  let dialogResult: unknown;

  /** Reports collected from `reportSanitizedError`, which writes to the console. */
  let reports: string[];

  const createComponent = async () => {
    alertCalls = [];
    reports = [];

    fetchTags = jest.fn(() => of([tag]));

    const dataServiceMock = {
      deleteTag: jest.fn(() => of(null)),
      fetchTags,
      postTag: jest.fn(() => postTagResponse),
      putTag: jest.fn(() => putTagResponse),
      updateInfo: jest.fn()
    };

    await TestBed.configureTestingModule({
      imports: [GfAdminTagComponent],
      providers: [
        {
          provide: ActivatedRoute,
          useValue: { queryParams: new BehaviorSubject({}) }
        },
        { provide: DataService, useValue: dataServiceMock },
        {
          provide: DeviceDetectorService,
          useValue: { getDeviceInfo: () => ({ deviceType: 'desktop' }) }
        },
        {
          provide: MatDialog,
          useValue: {
            open: jest.fn(() => ({ afterClosed: () => of(dialogResult) }))
          }
        },
        {
          provide: NotificationService,
          useValue: {
            alert: (params: { title: string }) => {
              alertCalls.push(params);
            },
            confirm: jest.fn()
          }
        },
        {
          provide: Router,
          useValue: { navigate: jest.fn(() => Promise.resolve(true)) }
        },
        { provide: UserService, useValue: { get: jest.fn(() => of({})) } }
      ]
    }).compileComponents();

    fixture = TestBed.createComponent(GfAdminTagComponent);
    component = fixture.componentInstance;

    fixture.detectChanges();

    return component;
  };

  /**
   * Opens the create form and lets it close carrying a tag.
   *
   * The write is reached only through that closing value, so it is the only way in -
   * and going through it rather than calling the write directly is what keeps this a
   * test of the screen rather than of a private method.
   */
  const submitCreate = async () => {
    fetchTags.mockClear();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (component as any).openCreateTagDialog();

    await fixture.whenStable();
  };

  const submitUpdate = async () => {
    fetchTags.mockClear();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (component as any).openUpdateTagDialog({ id: tag.id, name: tag.name });

    await fixture.whenStable();
  };

  beforeEach(() => {
    dialogResult = { id: null, name: tag.name };
    postTagResponse = of(tag);
    putTagResponse = of(tag);

    // `reportSanitizedError` writes through `console.error`. Collected rather than
    // silenced, because what it is allowed to carry is itself asserted below.
    jest.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      reports.push(args.map(String).join(' '));
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('a name that is already taken', () => {
    it('names the tag that was refused', async () => {
      postTagResponse = throwError(() => ({ status: StatusCodes.CONFLICT }));

      await createComponent();
      await submitCreate();

      expect(alertCalls).toEqual([
        { title: `A tag named ${tag.name} already exists.` }
      ]);
    });

    it('says the same for a rename onto a taken name', async () => {
      putTagResponse = throwError(() => ({ status: StatusCodes.CONFLICT }));
      dialogResult = { id: tag.id, name: tag.name };

      await createComponent();
      await submitUpdate();

      expect(alertCalls).toEqual([
        { title: `A tag named ${tag.name} already exists.` }
      ]);
    });

    it('treats a rejected request the same way', async () => {
      // The server refuses an own-tag creator addressing somebody else with a 400. It
      // is not a uniqueness conflict, but from where the viewer stands the tag they
      // asked for still cannot exist under that name, so the same wording serves.
      postTagResponse = throwError(() => ({ status: StatusCodes.BAD_REQUEST }));

      await createComponent();
      await submitCreate();

      expect(alertCalls).toEqual([
        { title: `A tag named ${tag.name} already exists.` }
      ]);
    });
  });

  describe('a refusal that is not a conflict', () => {
    it('offers to try again instead of blaming the name', async () => {
      postTagResponse = throwError(() => ({ status: 500 }));

      await createComponent();
      await submitCreate();

      // Deliberately not the duplicate wording: nothing about the name is wrong, and
      // renaming would not help.
      expect(alertCalls).toEqual([
        { title: 'The tag could not be saved. Please try again.' }
      ]);
    });

    it('survives a rejection carrying no status at all', async () => {
      postTagResponse = throwError(() => 'refused');

      await createComponent();
      await submitCreate();

      expect(alertCalls).toEqual([
        { title: 'The tag could not be saved. Please try again.' }
      ]);
    });
  });

  describe('what the screen shows afterwards', () => {
    it('re-reads the list when a write is refused', async () => {
      postTagResponse = throwError(() => ({ status: StatusCodes.CONFLICT }));

      await createComponent();
      await submitCreate();

      // The point of re-reading: the list on screen is whatever the server holds,
      // rather than a list the viewer has to guess about.
      expect(fetchTags).toHaveBeenCalledTimes(1);
    });

    it('re-reads the list when a write is accepted', async () => {
      await createComponent();
      await submitCreate();

      expect(alertCalls).toEqual([]);
      expect(fetchTags).toHaveBeenCalledTimes(1);
    });

    it('says nothing when the form is dismissed without a tag', async () => {
      dialogResult = null;

      await createComponent();
      await submitCreate();

      // Nothing was asked for, so nothing failed and nothing needs re-reading.
      expect(alertCalls).toEqual([]);
      expect(fetchTags).not.toHaveBeenCalled();
    });
  });

  describe('what is written to the log', () => {
    it('carries the event and the status and nothing else', async () => {
      postTagResponse = throwError(() => ({
        message: `duplicate key value violates unique constraint for ${tag.name}`,
        status: StatusCodes.CONFLICT,
        url: '/api/v1/tags'
      }));

      await createComponent();
      await submitCreate();

      expect(reports).toEqual([`GF-TAG-WRITE-FAILED (status 409)`]);
      expect(reports.join(' ')).not.toContain('/api/v1/tags');
      expect(reports.join(' ')).not.toContain('unique constraint');
    });

    it('logs nothing when the write is accepted', async () => {
      await createComponent();
      await submitCreate();

      expect(reports).toEqual([]);
    });
  });
});
