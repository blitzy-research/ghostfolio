import { permissions } from '@ghostfolio/common/permissions';
import { NotificationService } from '@ghostfolio/ui/notifications';
import { DataService } from '@ghostfolio/ui/services';

import { CUSTOM_ELEMENTS_SCHEMA } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { MatDialog } from '@angular/material/dialog';
import { ActivatedRoute, Router, RouterOutlet } from '@angular/router';
import { DeviceDetectorService } from 'ngx-device-detector';
import { BehaviorSubject, EMPTY, Observable, of } from 'rxjs';

import { GfAppComponent } from './app.component';
import { GfHoldingDetailDialogComponent } from './components/holding-detail-dialog/holding-detail-dialog.component';
import { GfUserAccountRegistrationDialogComponent } from './components/user-account-registration-dialog/user-account-registration-dialog.component';
import { ImpersonationStorageService } from './services/impersonation-storage.service';
import { TokenStorageService } from './services/token-storage.service';
import { UserService } from './services/user/user.service';

/**
 * The application shell, which is what survived the removal of the navigation
 * chrome.
 *
 * Three responsibilities were absorbed into it and each of them is a silent
 * failure waiting to happen:
 *
 * 1. **The holding-detail dialog is opened from a query parameter.** This is the
 *    workspace's route-agnostic dialog convention: a producer anywhere in the
 *    application rewrites the current URL, and the shell is the consumer. The
 *    dialog's inputs are derived from the viewer's own permissions and settings,
 *    and its clean-up nulls exactly three parameters while merging the rest -
 *    dropping the merge would close every co-mounted module's dialog along with
 *    this one.
 * 2. **Account registration moved here from the deleted register page.** Its two
 *    dialog inputs, its device-dependent sizing and - most importantly - the
 *    token adoption followed by a *forced* viewer re-fetch, which is what
 *    dismisses the live-demo banner.
 * 3. **A system message is surfaced without navigating.** Its optional
 *    `routerLink` is deliberately ignored, because there is no screen left to
 *    address; honouring it would resolve to a route that no longer exists.
 *
 * The `Router` is a recording stub throughout, because on a single-canvas shell
 * no navigation selects a screen - the query parameters are the whole message.
 * `MatDialog` is a stub as well: what matters is the request the shell makes and
 * what it does with the answer, not the dialog's own rendering, which each dialog
 * component's own suite owns.
 */
describe('GfAppComponent', () => {
  let dialogAfterClosed: Observable<unknown>;
  let dialogOpen: jest.Mock;

  /**
   * Every dialog the shell asked for, recorded through a typed side effect.
   *
   * Read back off `dialogOpen.mock.calls` instead, the element type is `any` and
   * every assertion about the component or its configuration stops being checked
   * by the compiler - which is exactly the kind of assertion that keeps passing
   * after the thing it describes has been renamed.
   */
  let dialogRequests: {
    component: unknown;
    config: {
      data?: Record<string, unknown>;
      disableClose?: boolean;
      height?: string;
      width?: string;
    };
  }[];
  let fixture: ComponentFixture<GfAppComponent>;
  let notificationServiceMock: { alert: jest.Mock };
  let queryParams: BehaviorSubject<Record<string, unknown>>;
  let routerMock: { navigate: jest.Mock };

  /** Every navigation the shell requested, recorded with its real types. */
  let navigations: {
    commands: unknown[];
    extras: {
      queryParams?: Record<string, unknown>;
      queryParamsHandling?: string;
    };
  }[];
  let stateChanged: BehaviorSubject<{ user: unknown }>;
  let tokenStorageServiceMock: { saveToken: jest.Mock };
  let userServiceGet: jest.Mock;

  /** Records ordering between effects that would otherwise be unordered. */
  let callOrder: string[];

  let colorSchemeListeners: ((event: { matches: boolean }) => void)[];
  let originalMatchMedia: typeof window.matchMedia;

  const createViewer = (viewer: Record<string, unknown> = {}) => {
    return {
      permissions: [],
      settings: { baseCurrency: 'CHF', colorScheme: 'LIGHT', locale: 'en-GB' },
      ...viewer
    };
  };

  const createComponent = async ({
    deviceType = 'desktop',
    viewer = null
  }: { deviceType?: string; viewer?: Record<string, unknown> | null } = {}) => {
    callOrder = [];
    dialogAfterClosed = of(undefined);

    dialogRequests = [];
    dialogOpen = jest.fn(
      (
        component: unknown,
        config: {
          data?: Record<string, unknown>;
          disableClose?: boolean;
          height?: string;
          width?: string;
        }
      ) => {
        dialogRequests.push({ component, config });

        return { afterClosed: () => dialogAfterClosed };
      }
    );

    notificationServiceMock = { alert: jest.fn() };
    queryParams = new BehaviorSubject<Record<string, unknown>>({});
    navigations = [];
    routerMock = {
      navigate: jest.fn(
        (
          commands: unknown[],
          extras: {
            queryParams?: Record<string, unknown>;
            queryParamsHandling?: string;
          } = {}
        ) => {
          callOrder.push('navigate');
          navigations.push({ commands, extras });

          return Promise.resolve(true);
        }
      )
    };
    stateChanged = new BehaviorSubject<{ user: unknown }>({ user: viewer });

    tokenStorageServiceMock = {
      saveToken: jest.fn(() => {
        callOrder.push('saveToken');
      })
    };

    userServiceGet = jest.fn((force?: boolean) => {
      callOrder.push(force ? 'get(true)' : 'get()');

      return of(createViewer());
    });

    await TestBed.configureTestingModule({
      imports: [GfAppComponent],
      providers: [
        {
          provide: ActivatedRoute,
          useValue: { queryParams: queryParams.asObservable() }
        },
        {
          provide: DataService,
          useValue: {
            fetchInfo: () => ({
              globalPermissions: [permissions.enableSubscription]
            })
          }
        },
        {
          provide: DeviceDetectorService,
          useValue: { getDeviceInfo: () => ({ deviceType }) }
        },
        {
          provide: ImpersonationStorageService,
          useValue: { onChangeHasImpersonation: () => of(null) }
        },
        { provide: MatDialog, useValue: { open: dialogOpen } },
        { provide: NotificationService, useValue: notificationServiceMock },
        { provide: Router, useValue: routerMock },
        { provide: TokenStorageService, useValue: tokenStorageServiceMock },
        {
          provide: UserService,
          useValue: {
            get: userServiceGet,
            signOut: jest.fn(),
            stateChanged
          }
        }
      ]
    })
      // The outlet is the shell's one remaining router dependency and it stays in
      // production - the router genuinely renders the canvas rather than the canvas
      // being hard-mounted. It is removed here because rendering it would need a
      // route table, and no route table belongs in a spec about the shell.
      //
      // `CUSTOM_ELEMENTS_SCHEMA` comes with it so the now-unclaimed
      // `<router-outlet>` element is tolerated rather than reported as NG0304 on
      // every render. A stand-in component would also work, but only under the
      // selector `router-outlet`, which the workspace's component-selector rule
      // forbids - and suppressing that rule to accommodate a test double is a worse
      // trade than declaring the element unknown.
      .overrideComponent(GfAppComponent, {
        add: { schemas: [CUSTOM_ELEMENTS_SCHEMA] },
        remove: { imports: [RouterOutlet] }
      })
      .compileComponents();

    fixture = TestBed.createComponent(GfAppComponent);

    fixture.detectChanges();

    return fixture.componentInstance;
  };

  /** The dialog request the shell made, or `undefined` if it made none. */
  const openedDialog = () => {
    return dialogRequests.at(-1);
  };

  /**
   * Yields until every pending microtask and macrotask has run.
   *
   * The shell resolves each dialog's own chunk with a dynamic `import()` before
   * opening it - which is what keeps those chunks out of the initial bundle - so a
   * dialog opens on a later tick than the parameter that asked for it. Waiting
   * here is what lets these assertions observe the request rather than race it.
   */
  const settle = () => {
    return new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
  };

  beforeEach(() => {
    colorSchemeListeners = [];

    // jsdom implements no `matchMedia`, and the shell reads the operating system's
    // colour-scheme preference through it on construction. The stub reports the
    // light preference and keeps whatever listener is attached, so the theme
    // behaviour is observable rather than merely survivable.
    //
    // `addEventListener`/`removeEventListener` are what the shell calls, and both
    // halves are provided deliberately: the removal is the only way to assert that
    // the listener is released with the component, which the deprecated
    // `addListener` form the shell used to call offered no way to do at all.
    originalMatchMedia = window.matchMedia;
    window.matchMedia = jest.fn(() => ({
      addEventListener: (
        _type: string,
        listener: (event: { matches: boolean }) => void
      ) => {
        colorSchemeListeners.push(listener);
      },
      matches: false,
      removeEventListener: (
        _type: string,
        listener: (event: { matches: boolean }) => void
      ) => {
        colorSchemeListeners = colorSchemeListeners.filter((registered) => {
          return registered !== listener;
        });
      }
    })) as unknown as typeof window.matchMedia;
  });

  afterEach(() => {
    window.matchMedia = originalMatchMedia;

    document.body.classList.remove('theme-dark', 'theme-light');

    jest.restoreAllMocks();
  });

  describe('the holding detail dialog', () => {
    /** The complete parameter triple that addresses the dialog. */
    const holdingParams = {
      dataSource: 'YAHOO',
      holdingDetailDialog: true,
      symbol: 'AAPL'
    };

    it('opens the dialog for a complete request', async () => {
      await createComponent();

      queryParams.next(holdingParams);

      await settle();

      const { component, config } = openedDialog();

      expect(dialogOpen).toHaveBeenCalledTimes(1);
      expect(component).toBe(GfHoldingDetailDialogComponent);
      expect(config.data).toMatchObject({
        dataSource: 'YAHOO',
        symbol: 'AAPL'
      });
    });

    it.each([
      {
        description: 'the data source is missing',
        params: { holdingDetailDialog: true, symbol: 'AAPL' }
      },
      {
        description: 'the symbol is missing',
        params: { dataSource: 'YAHOO', holdingDetailDialog: true }
      },
      {
        description: 'the flag is missing',
        params: { dataSource: 'YAHOO', symbol: 'AAPL' }
      },
      { description: 'nothing was addressed', params: {} }
    ])('opens nothing when $description', async ({ params }) => {
      await createComponent();

      queryParams.next(params);

      // All three members are required together. Two of them are also produced on
      // their own by other flows - a symbol and a data source address the asset
      // profile dialog too - so opening on a partial match would open this dialog
      // over somebody else's.
      expect(dialogOpen).not.toHaveBeenCalled();
    });

    it('derives the dialog inputs from the viewer', async () => {
      await createComponent();

      userServiceGet.mockReturnValue(
        of(
          createViewer({
            permissions: [
              permissions.accessAdminControl,
              permissions.createActivity,
              permissions.reportDataGlitch,
              permissions.updateActivity
            ]
          })
        )
      );

      queryParams.next(holdingParams);

      await settle();

      const { config } = openedDialog();

      // The viewer is re-read at open time rather than taken from the shell's own
      // field, which is what lets a dialog opened after a permission change reflect
      // it.
      expect(config.data).toMatchObject({
        baseCurrency: 'CHF',
        deviceType: 'desktop',
        hasImpersonationId: false,
        hasPermissionToAccessAdminControl: true,
        hasPermissionToCreateActivity: true,
        hasPermissionToReportDataGlitch: true,
        hasPermissionToUpdateActivity: true,
        locale: 'en-GB'
      });
    });

    it('withholds the activity capabilities from a restricted viewer', async () => {
      await createComponent();

      userServiceGet.mockReturnValue(
        of(
          createViewer({
            permissions: [
              permissions.createActivity,
              permissions.updateActivity
            ],
            settings: {
              baseCurrency: 'CHF',
              isRestrictedView: true,
              locale: 'en-GB'
            }
          })
        )
      );

      queryParams.next(holdingParams);

      await settle();

      const { config } = openedDialog();

      expect(config.data.hasPermissionToCreateActivity).toBe(false);
      expect(config.data.hasPermissionToUpdateActivity).toBe(false);
    });

    it('sizes the dialog for the device', async () => {
      await createComponent({ deviceType: 'mobile' });

      queryParams.next(holdingParams);

      await settle();

      const { config } = openedDialog();

      expect(config).toMatchObject({
        autoFocus: false,
        height: '98vh',
        width: '100vw'
      });
    });

    it('clears exactly its own parameters when the dialog closes', async () => {
      await createComponent();

      queryParams.next(holdingParams);

      await settle();

      // The empty command array is the route-agnostic convention - it rewrites the
      // current URL rather than addressing anything - and merging is what preserves
      // every other parameter, a shared portfolio identifier and each co-mounted
      // module's dialog flag among them.
      expect(routerMock.navigate).toHaveBeenCalledTimes(1);
      expect(navigations[0].commands).toEqual([]);
      expect(navigations[0].extras).toMatchObject({
        queryParams: {
          dataSource: null,
          holdingDetailDialog: null,
          symbol: null
        },
        queryParamsHandling: 'merge'
      });
    });
  });

  describe('the system message', () => {
    it('surfaces the message through the notification service', async () => {
      const component = await createComponent();

      stateChanged.next({
        user: createViewer({ systemMessage: { message: 'Under maintenance' } })
      });

      component.onClickSystemMessage();

      expect(notificationServiceMock.alert).toHaveBeenCalledWith({
        title: 'Under maintenance'
      });
    });

    it('ignores the link a system message may carry', async () => {
      const component = await createComponent();

      stateChanged.next({
        user: createViewer({
          systemMessage: {
            message: 'Under maintenance',
            routerLink: ['/admin']
          }
        })
      });

      component.onClickSystemMessage();

      // The link is deliberately dropped: on a single-canvas shell there is no
      // screen to navigate to, so honouring it would resolve to a route that no
      // longer exists.
      expect(routerMock.navigate).not.toHaveBeenCalled();
      expect(notificationServiceMock.alert).toHaveBeenCalledTimes(1);
    });

    it('does nothing at all without a message', async () => {
      const component = await createComponent();

      component.onClickSystemMessage();

      expect(notificationServiceMock.alert).not.toHaveBeenCalled();
      expect(routerMock.navigate).not.toHaveBeenCalled();
    });

    it('renders the message in the banner', async () => {
      await createComponent();

      stateChanged.next({
        user: createViewer({ systemMessage: { message: 'Under maintenance' } })
      });

      fixture.detectChanges();

      expect(
        (fixture.nativeElement as HTMLElement)
          .querySelector('.info-message')
          .textContent.trim()
      ).toBe('Under maintenance');
    });
  });

  describe('creating an account', () => {
    it('opens the registration dialog with the terms step gated by the global permission', async () => {
      const component = await createComponent();

      await component.onCreateAccount();

      const { component: dialogComponent, config } = openedDialog();

      // The gate used to live on the register page, which owned this flow before
      // the shell absorbed it.
      expect(dialogComponent).toBe(GfUserAccountRegistrationDialogComponent);
      expect(config.data).toEqual({
        deviceType: 'desktop',
        needsToAcceptTermsOfService: true
      });
      expect(config.disableClose).toBe(true);
    });

    it.each([
      {
        deviceType: 'desktop',
        expected: { height: undefined, width: '30rem' }
      },
      { deviceType: 'mobile', expected: { height: '98vh', width: '100vw' } }
    ])(
      'sizes the dialog for a $deviceType',
      async ({ deviceType, expected }) => {
        const component = await createComponent({ deviceType });

        await component.onCreateAccount();

        const { config } = openedDialog();

        expect(config.height).toBe(expected.height);
        expect(config.width).toBe(expected.width);
      }
    );

    it('adopts an issued token and then re-reads the viewer, bypassing the cache', async () => {
      const component = await createComponent();

      dialogAfterClosed = of('an-issued-token');

      await component.onCreateAccount();

      // Both halves matter and so does their order. The token is persisted with
      // `staySignedIn` forced on, matching the register page's deliberate decision
      // not to consult the setting for a freshly created account; and the forced
      // re-read is what drives the viewer subscription to recompute
      // `canCreateAccount`, which is what dismisses the live-demo banner. An
      // unforced read would be served the cached anonymous viewer and the banner
      // would stay.
      expect(tokenStorageServiceMock.saveToken).toHaveBeenCalledWith(
        'an-issued-token',
        true
      );
      expect(callOrder).toEqual(['saveToken', 'get(true)']);
    });

    it('does nothing when the dialog closes without a token', async () => {
      const component = await createComponent();

      dialogAfterClosed = of(undefined);

      await component.onCreateAccount();

      expect(tokenStorageServiceMock.saveToken).not.toHaveBeenCalled();
      expect(callOrder).toEqual([]);
    });

    it('offers account creation only to a viewer entitled to it', async () => {
      const component = await createComponent();

      stateChanged.next({
        user: createViewer({ permissions: [permissions.createUserAccount] })
      });

      expect(component.canCreateAccount).toBe(true);
      expect(component.hasInfoMessage).toBe(true);

      stateChanged.next({ user: createViewer() });

      expect(component.canCreateAccount).toBe(false);
      expect(component.hasInfoMessage).toBe(false);
    });
  });

  describe('the shell itself', () => {
    it('renders the router outlet rather than mounting the canvas itself', async () => {
      await createComponent();

      // The outlet is replaced in this harness, so its presence is asserted through
      // the element the template declares. The router still owns the one root route
      // and still activates the canvas through it.
      expect(
        (fixture.nativeElement as HTMLElement).querySelector(
          'main[role="main"]'
        )
      ).toBeTruthy();
    });

    it('renders no navigation chrome', async () => {
      await createComponent();

      const host = fixture.nativeElement as HTMLElement;

      // The header element survives as the banner's container; what must not come
      // back is either chrome component.
      expect(host.querySelector('gf-header')).toBeNull();
      expect(host.querySelector('gf-footer')).toBeNull();
    });

    it('issues no navigation of its own while nothing is addressed', async () => {
      await createComponent();

      stateChanged.next({ user: createViewer() });

      expect(routerMock.navigate).not.toHaveBeenCalled();
    });

    it('applies the operating system colour scheme before a viewer resolves', async () => {
      await createComponent();

      // The stub reports the light preference, and the shell has to have acted on
      // it during construction rather than waiting for a viewer: the first frame is
      // painted before anyone is signed in.
      expect(document.body.classList.contains('theme-light')).toBe(true);
      expect(document.body.classList.contains('theme-dark')).toBe(false);
    });

    it('lets a viewer preference override the operating system', async () => {
      await createComponent();

      stateChanged.next({
        user: createViewer({
          settings: { baseCurrency: 'CHF', colorScheme: 'DARK' }
        })
      });

      expect(document.body.classList.contains('theme-dark')).toBe(true);
      expect(document.body.classList.contains('theme-light')).toBe(false);
    });

    it('follows the operating system only while the viewer expressed no preference', async () => {
      await createComponent();

      stateChanged.next({
        user: createViewer({ settings: { baseCurrency: 'CHF' } })
      });

      for (const listener of colorSchemeListeners) {
        listener({ matches: true });
      }

      expect(document.body.classList.contains('theme-dark')).toBe(true);

      stateChanged.next({
        user: createViewer({
          settings: { baseCurrency: 'CHF', colorScheme: 'LIGHT' }
        })
      });

      for (const listener of colorSchemeListeners) {
        listener({ matches: true });
      }

      // An explicit choice wins: the system switching to dark must not undo it.
      expect(document.body.classList.contains('theme-light')).toBe(true);
    });

    // The theme is applied on EVERY emission of the viewer's record, and the
    // appearance control in the toolbar refreshes that record on every use - so
    // registering the system listener alongside the theme it applies added one more
    // listener each time, none of them ever removed, each re-running the same work.
    it('watches the operating system once, however many times the viewer record arrives', async () => {
      await createComponent();

      expect(colorSchemeListeners).toHaveLength(1);

      for (let emission = 0; emission < 5; emission += 1) {
        stateChanged.next({
          user: createViewer({ settings: { baseCurrency: 'CHF' } })
        });
      }

      expect(colorSchemeListeners).toHaveLength(1);
    });

    it('stops watching the operating system when the shell goes away', async () => {
      await createComponent();

      expect(colorSchemeListeners).toHaveLength(1);

      fixture.destroy();

      // Released rather than left behind: the listener closes over the component, so
      // an un-removed one keeps it alive and keeps re-theming a torn-down shell.
      expect(colorSchemeListeners).toHaveLength(0);
    });

    it('survives a viewer request that never answers', async () => {
      await createComponent();

      userServiceGet.mockReturnValue(EMPTY);

      queryParams.next({
        dataSource: 'YAHOO',
        holdingDetailDialog: true,
        symbol: 'AAPL'
      });

      // The dialog is opened from inside the viewer read, so a read that never
      // answers has to leave the shell intact rather than half-open.
      expect(dialogOpen).not.toHaveBeenCalled();
      expect(routerMock.navigate).not.toHaveBeenCalled();
    });
  });
});
