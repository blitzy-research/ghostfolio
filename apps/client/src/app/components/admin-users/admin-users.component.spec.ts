import { GfUserDetailDialogComponent } from '@ghostfolio/client/components/user-detail-dialog/user-detail-dialog.component';
import { ImpersonationStorageService } from '@ghostfolio/client/services/impersonation-storage.service';
import { UserService } from '@ghostfolio/client/services/user/user.service';
import { NotificationService } from '@ghostfolio/ui/notifications';
import { AdminService, DataService } from '@ghostfolio/ui/services';

import { ComponentFixture, TestBed } from '@angular/core/testing';
import { MatDialog } from '@angular/material/dialog';
import { DeviceDetectorService } from 'ngx-device-detector';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BehaviorSubject, of } from 'rxjs';

import { GfAdminUsersComponent } from './admin-users.component';

/**
 * Inspecting a user, which used to be a route and is now a dialog.
 *
 * This row action was the one place in the admin surface that navigated by
 * concatenating an identifier onto a route path. That route is gone, and rather
 * than becoming a reveal-module intent - which would surface a module without
 * saying *which* user to show - it opens the user detail dialog directly. That
 * makes this the one producer in the refactor whose remediation is neither a
 * navigation nor an intent, which is precisely why it is worth pinning: the
 * identifier has to survive the change, and a dialog opened without it shows
 * nothing.
 *
 * The suite deliberately provides no `Router`. The component no longer injects one,
 * so its absence is an assertion rather than an omission - a reintroduced router
 * would fail to resolve here.
 */
describe('GfAdminUsersComponent', () => {
  let dialogOpen: jest.Mock;
  let fixture: ComponentFixture<GfAdminUsersComponent>;

  /** Every dialog requested, recorded with its real types. */
  let dialogRequests: {
    component: unknown;
    config: {
      autoFocus?: boolean;
      data?: Record<string, unknown>;
      height?: string;
      width?: string;
    };
  }[];

  const createComponent = async (deviceType = 'desktop') => {
    dialogRequests = [];

    dialogOpen = jest.fn(
      (
        component: unknown,
        config: {
          autoFocus?: boolean;
          data?: Record<string, unknown>;
          height?: string;
          width?: string;
        }
      ) => {
        dialogRequests.push({ component, config });

        return { afterClosed: () => of(undefined) };
      }
    );

    await TestBed.configureTestingModule({
      imports: [GfAdminUsersComponent],
      providers: [
        {
          provide: AdminService,
          useValue: {
            fetchUsers: jest.fn(() => of({ count: 0, users: [] }))
          }
        },
        {
          provide: DataService,
          useValue: { fetchInfo: jest.fn(() => ({ globalPermissions: [] })) }
        },
        {
          provide: DeviceDetectorService,
          useValue: { getDeviceInfo: () => ({ deviceType }) }
        },
        {
          provide: ImpersonationStorageService,
          useValue: {
            onChangeHasImpersonation: () => of(null),
            toggleImpersonation: jest.fn()
          }
        },
        { provide: MatDialog, useValue: { open: dialogOpen } },
        // Reached only by the deletion confirmation, which nothing below triggers.
        { provide: NotificationService, useValue: {} },
        {
          provide: UserService,
          useValue: {
            stateChanged: new BehaviorSubject({
              user: { id: 'admin-1', settings: { locale: 'en-GB' } }
            })
          }
        }
      ]
    })
      // The table, its paginator and its sort header render nothing this suite
      // reads, and reproducing their structural directives without the modules is
      // not possible - so the template is replaced outright and the row handler is
      // invoked directly. The template's own wiring is asserted from its source
      // below, which is what keeps an unbound handler visible.
      .overrideComponent(GfAdminUsersComponent, {
        set: { imports: [], template: '' }
      })
      .compileComponents();

    fixture = TestBed.createComponent(GfAdminUsersComponent);

    fixture.detectChanges();

    return fixture.componentInstance;
  };

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('inspecting a user', () => {
    it('opens the user detail dialog rather than navigating', async () => {
      const component = await createComponent();

      component.onOpenUserDetailDialog('user-42');

      expect(dialogRequests).toHaveLength(1);
      expect(dialogRequests[0].component).toBe(GfUserDetailDialogComponent);
    });

    it('carries the identifier of the row that was activated', async () => {
      const component = await createComponent();

      component.onOpenUserDetailDialog('user-42');

      // The identifier used to travel in the URL. It now travels in the dialog
      // payload, and losing it would open a dialog with nothing to show.
      expect(dialogRequests[0].config.data).toMatchObject({
        currentUserId: 'admin-1',
        userId: 'user-42'
      });
    });

    it.each([
      { deviceType: 'desktop', height: '60vh', width: '50rem' },
      { deviceType: 'mobile', height: '98vh', width: '100vw' }
    ])('sizes the dialog for $deviceType', async ({ deviceType, ...size }) => {
      const component = await createComponent(deviceType);

      component.onOpenUserDetailDialog('user-42');

      expect(dialogRequests[0].config).toMatchObject(size);
    });

    it('opens one dialog per activation', async () => {
      const component = await createComponent();

      component.onOpenUserDetailDialog('user-1');
      component.onOpenUserDetailDialog('user-2');

      expect(dialogRequests.map(({ config }) => config.data.userId)).toEqual([
        'user-1',
        'user-2'
      ]);
    });

    it('requests nothing until a row is activated', async () => {
      await createComponent();

      expect(dialogOpen).not.toHaveBeenCalled();
    });
  });

  describe('route independence', () => {
    /** The template as text, resolved from this spec's own location. */
    const template = readFileSync(join(__dirname, 'admin-users.html'), 'utf8');

    it('wires the handler from the template', () => {
      // The handler is invoked directly above, so this is what proves it is
      // reachable at all - the gap that left another call to action in this
      // refactor bound to nothing.
      expect(template).toContain('onOpenUserDetailDialog(');
    });

    it('routes nowhere from the template', () => {
      expect(template).not.toContain('routerLink');
    });

    it('holds no router at all', () => {
      // Read from the source, because an import is a compile-time fact that has
      // been erased by the time an instance exists. Paired with the suite
      // providing no `Router`, this closes both halves: the component neither
      // declares one nor could resolve one.
      const source = readFileSync(
        join(__dirname, 'admin-users.component.ts'),
        'utf8'
      );

      expect(source).not.toContain('@angular/router');
    });

    it('constructs without a router being available', async () => {
      await expect(createComponent()).resolves.toBeInstanceOf(
        GfAdminUsersComponent
      );
    });
  });
});
