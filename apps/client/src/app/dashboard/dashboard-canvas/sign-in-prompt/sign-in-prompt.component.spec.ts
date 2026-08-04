import { GfDashboardLayoutService } from '@ghostfolio/client/dashboard/services/dashboard-layout.service';
import { SettingsStorageService } from '@ghostfolio/client/services/settings-storage.service';
import { TokenStorageService } from '@ghostfolio/client/services/token-storage.service';
import { UserService } from '@ghostfolio/client/services/user/user.service';
import { permissions } from '@ghostfolio/common/permissions';
import { NotificationService } from '@ghostfolio/ui/notifications';
import { DataService } from '@ghostfolio/ui/services';

import { ComponentFixture, TestBed } from '@angular/core/testing';
import { MatDialog } from '@angular/material/dialog';
import { Router } from '@angular/router';
import { DeviceDetectorService } from 'ngx-device-detector';
import { Observable, of, throwError } from 'rxjs';

import { GfSignInPromptComponent } from './sign-in-prompt.component';

/**
 * The unauthenticated state of the root route, focused on the one outcome it has no
 * second chance at.
 *
 * Both paths here persist a credential *before* the viewer belonging to it is read,
 * which is the right order — the read needs the token to authenticate with — and
 * which makes the read failing the interesting case rather than a footnote. The
 * viewer store keeps whatever it last held when a forced fetch fails, and while this
 * prompt is on screen that is nothing at all, so the canvas is never told to leave
 * its signed-out branch. Without a handler the viewer is then left looking at a
 * sign-in prompt for an account that exists and whose token is already in storage,
 * with no control on screen that can retry: every control here creates or adopts a
 * *new* credential rather than re-reading the current one.
 *
 * Reloading is what recovers it, because it discards every in-memory cache and
 * restarts viewer resolution from the stored token — precisely the step that failed.
 *
 * **The reload is observed rather than intercepted.** jsdom implements
 * `window.location` and its members as `[LegacyUnforgeable]`, so
 * `jest.spyOn(window.location, 'reload')` throws `Cannot assign to read only
 * property 'reload'` — measured, not assumed. What jsdom does emit is a report on
 * its virtual console, arriving as a `console.error`; {@link reloadAttempts}
 * collects those and forwards everything else to the real `console.error`, so a
 * genuine framework error is never swallowed. This is the instrument
 * `core/auth.guard.spec.ts` and the dashboard toolbar's spec already use for the
 * navigations they cannot intercept either.
 *
 * The transition announcement is asserted for ordering rather than for its own sake:
 * between storing a token and resolving its viewer there must be no interval in
 * which a layout write is authorised, and ordering is the only thing that
 * establishes it.
 */
describe('GfSignInPromptComponent', () => {
  /** How jsdom reports an attempt to leave the page. */
  const JSDOM_NAVIGATION_REPORT = 'Not implemented: navigation';

  let beginIdentityTransition: jest.Mock;
  let callOrder: string[];
  let component: GfSignInPromptComponent;
  let dialogClose: Observable<string | undefined>;
  let fixture: ComponentFixture<GfSignInPromptComponent>;

  /** Every reload jsdom refused to perform, in order. */
  let reloadAttempts: string[];

  let routerNavigate: jest.Mock;
  let saveToken: jest.Mock;
  let userServiceGet: jest.Mock;

  const createComponent = async ({
    viewer = of({ settings: { language: 'en' } }),
    staySignedIn = 'true'
  }: {
    staySignedIn?: string;
    viewer?: Observable<unknown>;
  } = {}) => {
    callOrder = [];

    beginIdentityTransition = jest.fn(() => {
      callOrder.push('beginIdentityTransition');
    });

    saveToken = jest.fn(() => {
      callOrder.push('saveToken');
    });

    userServiceGet = jest.fn((force?: boolean) => {
      callOrder.push(force ? 'get(true)' : 'get()');

      return viewer;
    });

    routerNavigate = jest.fn(() => {
      return Promise.resolve(true);
    });

    await TestBed.configureTestingModule({
      imports: [GfSignInPromptComponent],
      providers: [
        {
          provide: DataService,
          useValue: {
            fetchInfo: () => {
              return {
                globalPermissions: [permissions.createUserAccount]
              };
            }
          }
        },
        {
          provide: DeviceDetectorService,
          useValue: {
            getDeviceInfo: () => {
              return { deviceType: 'desktop' };
            }
          }
        },
        {
          provide: GfDashboardLayoutService,
          useValue: { beginIdentityTransition }
        },
        {
          provide: MatDialog,
          useValue: {
            open: jest.fn(() => {
              return { afterClosed: () => dialogClose };
            })
          }
        },
        { provide: NotificationService, useValue: { alert: jest.fn() } },
        { provide: Router, useValue: { navigate: routerNavigate } },
        {
          provide: SettingsStorageService,
          useValue: {
            getSetting: jest.fn(() => {
              return staySignedIn;
            })
          }
        },
        { provide: TokenStorageService, useValue: { saveToken } },
        { provide: UserService, useValue: { get: userServiceGet } }
      ]
    }).compileComponents();

    fixture = TestBed.createComponent(GfSignInPromptComponent);
    component = fixture.componentInstance;

    fixture.detectChanges();
  };

  beforeEach(() => {
    dialogClose = of('AUTH_TOKEN');
    reloadAttempts = [];

    // Captured before the spy replaces it, and wrapped rather than bound: the
    // bound-function overload types its result as `any`, which would make the
    // forwarding call at the end of the stub below an unchecked invocation.
    const originalConsoleError = console.error;
    const reportError = (...args: unknown[]) => {
      originalConsoleError.apply(console, args);
    };

    jest.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      const [detail] = args;

      // Recognised by shape rather than with `instanceof`: jsdom raises this from
      // its own realm, so `detail instanceof Error` is false for the very object
      // that arrives.
      const report =
        Object.prototype.toString.call(detail) === '[object Error]'
          ? (detail as Error).message
          : typeof detail === 'string'
            ? detail
            : '';

      if (report.includes(JSDOM_NAVIGATION_REPORT)) {
        reloadAttempts.push(report);

        return;
      }

      // The component's own diagnostic, which every failure path emits before it
      // reloads. Swallowed rather than forwarded so the suite output stays
      // readable, and counted so its presence is assertable.
      if (report.startsWith('Failed to read the ')) {
        callOrder.push('reportFailure');

        return;
      }

      reportError(...args);
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('adopting a newly created account', () => {
    it('announces the transition before the token is stored', async () => {
      await createComponent();

      component.openShowAccessTokenDialog();

      // Ordering is the assertion. Between storing a token and resolving its
      // viewer, a layout write must not be authorisable - announcing the
      // transition first is what withdraws that authorisation.
      expect(callOrder).toEqual([
        'beginIdentityTransition',
        'saveToken',
        'get(true)'
      ]);
    });

    it('stores the token as a persistent credential', async () => {
      await createComponent();

      component.openShowAccessTokenDialog();

      expect(saveToken).toHaveBeenCalledWith('AUTH_TOKEN', true);
    });

    it('recovers by reloading when the viewer cannot be read', async () => {
      await createComponent({ viewer: throwError(() => new Error('offline')) });

      component.openShowAccessTokenDialog();

      // The finding this covers. Without the branch the token stays stored, the
      // viewer stays unresolved and the prompt stays on screen with nothing on it
      // that can retry.
      expect(reloadAttempts).toHaveLength(1);
      expect(callOrder).toContain('reportFailure');
    });

    it('does nothing at all when the dialog is cancelled', async () => {
      dialogClose = of(undefined);

      await createComponent();

      component.openShowAccessTokenDialog();

      expect(callOrder).toEqual([]);
      expect(reloadAttempts).toHaveLength(0);
    });
  });

  describe('adopting a token the viewer supplied', () => {
    it('forces the read, so a cached viewer cannot answer for the new token', async () => {
      await createComponent();

      component.setToken('AUTH_TOKEN');

      // An unforced read is served from the store whenever it holds anything, and
      // the whole purpose of this call is to resolve the viewer belonging to the
      // token stored one line earlier.
      expect(callOrder).toEqual([
        'beginIdentityTransition',
        'saveToken',
        'get(true)'
      ]);
    });

    it('honours the stay-signed-in preference', async () => {
      await createComponent({ staySignedIn: 'false' });

      component.setToken('AUTH_TOKEN');

      expect(saveToken).toHaveBeenCalledWith('AUTH_TOKEN', false);
    });

    it('stays on the canvas when the language already matches', async () => {
      await createComponent({
        viewer: of({ settings: { language: document.documentElement.lang } })
      });

      component.setToken('AUTH_TOKEN');

      expect(routerNavigate).toHaveBeenCalledWith(['/']);
      expect(reloadAttempts).toHaveLength(0);
    });

    it('recovers by reloading when the viewer cannot be read', async () => {
      await createComponent({ viewer: throwError(() => new Error('offline')) });

      component.setToken('AUTH_TOKEN');

      // This method is the sole continuation of the token sign-in path, so an
      // unhandled failure here leaves the token persisted, the viewer unresolved,
      // the canvas signed out and no navigation performed.
      expect(reloadAttempts).toHaveLength(1);
      expect(callOrder).toContain('reportFailure');
      expect(routerNavigate).not.toHaveBeenCalled();
    });
  });
});
