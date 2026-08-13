import { GfAccessTableComponent } from '@ghostfolio/client/components/access-table/access-table.component';
import { UserService } from '@ghostfolio/client/services/user/user.service';
import type { Access, User } from '@ghostfolio/common/interfaces';
import { NotificationService } from '@ghostfolio/ui/notifications';
import { DataService } from '@ghostfolio/ui/services';

import { Component, EventEmitter, Input, Output } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
// Static strings in this tree are marked for translation, which compiles to
// `$localize` calls evaluated at module scope. Nothing installs that global in a
// jsdom environment - `apps/client/src/polyfills.ts` installs it for the
// application and no test setup file stands in for it - so it is installed here,
// exactly as the sibling module specs do.
import '@angular/localize/init';
import { MatDialog } from '@angular/material/dialog';
import { ActivatedRoute, Router } from '@angular/router';
import type { Params } from '@angular/router';
import { DeviceDetectorService } from 'ngx-device-detector';
// The dialog this module opens references a validated data transfer object as a
// runtime value, and that object is decorated with `class-transformer`, which reads
// decorator metadata through the reflection API. `polyfills.ts` installs it for the
// application; nothing installs it for a jsdom test environment.
import 'reflect-metadata';
import { BehaviorSubject, Subject, of } from 'rxjs';

// Reached through the client-side re-export rather than the shared entry point,
// and the position is the reason: this group is evaluated after the localization
// global above, whereas naming `@ghostfolio/common/dashboard` in the first group
// would evaluate its translated metadata map before that global exists. The symbol
// is identical either way.
import { DashboardModuleType } from '../../dashboard/enums/dashboard-module-type';
import { GfUserAccountAccessComponent } from './user-account-access.component';

// Cuts the one import chain that would otherwise evaluate the shared route
// metadata - and therefore call `$localize` - before the global above is installed:
// the viewer store holds a reference to this dialog so it can hand the class to
// `MatDialog.open`. The store is supplied here as a stub, so neither the dialog nor
// the path that opens it is reachable from this spec.
jest.mock(
  '@ghostfolio/client/components/subscription-interstitial-dialog/subscription-interstitial-dialog.component',
  () => {
    return { GfSubscriptionInterstitialDialogComponent: class {} };
  }
);

/**
 * Stands in for the shared access table.
 *
 * It declares every input the host binds and every output the host listens to,
 * which is the whole of that contract. The real table reaches the clipboard and the
 * notification stack, neither of which this spec is about.
 */
@Component({ selector: 'gf-access-table', template: '' })
class GfTestAccessTableComponent {
  @Input() public accesses: Access[];
  @Input() public showActions: boolean;
  @Input() public user: User;

  @Output() public accessDeleted = new EventEmitter<string>();
  @Output() public accessToUpdate = new EventEmitter<string>();
}

/**
 * This module's query-parameter contract, and above all its idempotence.
 *
 * The application resolves to a single canvas, so every mounted module observes the
 * same address at the same moment, and every producer on it *merges* - which means
 * `route.queryParams` re-emits an unchanged request whenever any OTHER module
 * writes to the URL. A consumer that opens on arrival therefore has to be able to
 * tell a request it has already served from a new one, and this module was the only
 * one of the fifteen consumers on the canvas that could not: each re-emission minted
 * another copy of a dialog that was already open, the count climbed 1 → 2 → 3 → …
 * → 7 across three interactions, every copy was pixel-identical, and their stacked
 * backdrops composited to near-black as the only perceptible tell. Dismissing them
 * needed one Escape per copy, and from the first press the URL was already bare
 * while six modals still blocked the page.
 *
 * Four properties are pinned here, and each is a defect that has actually happened:
 *
 * 1. **One request, one dialog.** However many times the same request is
 *    re-observed, and whether or not a copy has since been dismissed.
 * 2. **A withdrawn request is forgotten.** Keyed on what the URL asks rather than on
 *    the dialog's lifecycle, so the same grant can be edited a second time.
 * 3. **A request that cannot be resolved yet is not discarded.** An `editDialog`
 *    naming a grant arrives before the grants themselves do, because the module is
 *    materialised lazily in response to that very address; it must be honoured when
 *    they land, and cleared only once they are known and the grant genuinely is not
 *    among them.
 * 4. **A dialog is sized from a resolved device.** Both dialogs read `deviceType`,
 *    which resolves in `ngOnInit` - after the constructor, where the first emission
 *    arrives.
 */
describe('GfUserAccountAccessComponent', () => {
  const accessId = 'ACCESS_ID';

  let accessesSubject: Subject<Access[]>;
  let component: GfUserAccountAccessComponent;
  let deviceType: string;
  let dialogMock: { open: jest.Mock };
  let dialogClosed: Subject<unknown>;
  let fixture: ComponentFixture<GfUserAccountAccessComponent>;
  let queryParamsSubject: BehaviorSubject<Params>;
  let routerMock: { navigate: jest.Mock };
  let stateChangedSubject: BehaviorSubject<{ user: User }>;

  /**
   * The request the URL makes when a grant is to be edited.
   *
   * `accessDialogId` rather than `accessId`: the latter is the root host's
   * discriminator for a portfolio shared by link, and this dialog no longer
   * travels on it. See `GfAppQueryParams`.
   */
  const editRequest = (aAccessId = accessId) => {
    return {
      accessDialogId: aAccessId,
      dialogModule: DashboardModuleType.ACCOUNT_ACCESS,
      editDialog: 'true'
    };
  };

  /** The request the URL makes when a new grant is to be created. */
  const createRequest = () => {
    return {
      createDialog: 'true',
      dialogModule: DashboardModuleType.ACCOUNT_ACCESS
    };
  };

  const createAccess = (): Access => {
    return {
      alias: 'Shared portfolio',
      grantee: 'Public',
      id: accessId,
      permissions: ['READ_RESTRICTED'],
      type: 'PRIVATE'
    };
  };

  const createUser = (aUser: Partial<User> = {}) => {
    return {
      access: [],
      permissions: ['createAccess', 'updateAccess'],
      settings: {
        baseCurrency: 'USD',
        language: 'en',
        locale: 'en-US'
      },
      ...aUser
    } as User;
  };

  /**
   * Mounts the module, which is what resolves the device and requests the grants.
   *
   * Separate from `beforeEach` so a test can put a request on the stream BEFORE the
   * module exists - the cold-load case, and the only way to observe what the
   * constructor does with an address it cannot yet act on.
   */
  const mount = () => {
    fixture = TestBed.createComponent(GfUserAccountAccessComponent);
    component = fixture.componentInstance;

    fixture.detectChanges();
  };

  /** Answers the outstanding request for the viewer's granted access. */
  const emitAccesses = (accesses: Access[] = [createAccess()]) => {
    accessesSubject.next(accesses);
  };

  beforeEach(async () => {
    accessesSubject = new Subject<Access[]>();
    deviceType = 'desktop';
    dialogClosed = new Subject<unknown>();
    queryParamsSubject = new BehaviorSubject<Params>({});
    stateChangedSubject = new BehaviorSubject<{ user: User }>({
      user: createUser()
    });

    dialogMock = {
      open: jest.fn(() => {
        return {
          afterClosed: () => {
            return dialogClosed.asObservable();
          }
        };
      })
    };

    routerMock = {
      navigate: jest.fn(() => {
        return Promise.resolve(true);
      })
    };

    await TestBed.configureTestingModule({
      imports: [GfUserAccountAccessComponent],
      providers: [
        {
          provide: ActivatedRoute,
          useValue: { queryParams: queryParamsSubject }
        },
        {
          provide: DataService,
          useValue: {
            fetchAccesses: jest.fn(() => {
              return accessesSubject.asObservable();
            }),
            fetchInfo: jest.fn(() => {
              return { globalPermissions: [] };
            })
          }
        },
        {
          provide: DeviceDetectorService,
          useValue: {
            getDeviceInfo: () => {
              return { deviceType };
            }
          }
        },
        { provide: MatDialog, useValue: dialogMock },
        {
          provide: NotificationService,
          useValue: { alert: jest.fn(), confirm: jest.fn() }
        },
        {
          provide: Router,
          useValue: routerMock
        },
        {
          provide: UserService,
          useValue: {
            get: jest.fn(() => {
              return of(createUser());
            }),
            signOut: jest.fn(),
            stateChanged: stateChangedSubject
          }
        }
      ]
    })
      .overrideComponent(GfUserAccountAccessComponent, {
        add: { imports: [GfTestAccessTableComponent] },
        remove: { imports: [GfAccessTableComponent] }
      })
      // Overridden rather than merely provided, because the component's own
      // `imports` name `MatDialogModule`, whose providers would otherwise supply
      // the real dialog service and open a real overlay.
      .overrideProvider(MatDialog, { useValue: dialogMock })
      .compileComponents();
  });

  describe('creation', () => {
    it('is created', () => {
      mount();

      expect(component).toBeTruthy();
    });
  });

  describe('generic dialog flag ownership', () => {
    it('ignores an unqualified create request', () => {
      mount();
      emitAccesses();

      queryParamsSubject.next({ createDialog: 'true' });

      // The permission is granted by the default viewer, so a rejection here can
      // only be the missing module name.
      expect(dialogMock.open).not.toHaveBeenCalled();
    });

    it('ignores a request addressed to another module', () => {
      mount();
      emitAccesses();

      queryParamsSubject.next({
        ...editRequest(),
        dialogModule: DashboardModuleType.ACCOUNTS
      });

      expect(dialogMock.open).not.toHaveBeenCalled();
    });

    it('answers a create request addressed to this module', () => {
      mount();
      emitAccesses();

      queryParamsSubject.next(createRequest());

      expect(dialogMock.open).toHaveBeenCalledTimes(1);
    });

    it('answers an edit request addressed to this module', () => {
      mount();
      emitAccesses();

      queryParamsSubject.next(editRequest());

      expect(dialogMock.open).toHaveBeenCalledTimes(1);

      const [, config] = dialogMock.open.mock.calls[0];

      // The grant itself, resolved from the identifier the URL carried.
      expect(config.data.access).toEqual(
        expect.objectContaining({ id: accessId, alias: 'Shared portfolio' })
      );
    });

    it('opens no create dialog without the permission to create', () => {
      stateChangedSubject.next({ user: createUser({ permissions: [] }) });

      mount();
      emitAccesses();

      queryParamsSubject.next(createRequest());

      expect(dialogMock.open).not.toHaveBeenCalled();
    });
  });

  describe('serving a request exactly once', () => {
    it.each([
      { branch: 'edit', request: editRequest },
      { branch: 'create', request: createRequest }
    ])(
      'opens one $branch dialog however many times the request is re-observed',
      ({ request }) => {
        mount();
        emitAccesses();

        queryParamsSubject.next(request());

        expect(dialogMock.open).toHaveBeenCalledTimes(1);

        for (let emission = 0; emission < 3; emission += 1) {
          // A sibling module writing an unrelated parameter re-emits this request
          // unchanged, because every producer on the canvas merges.
          queryParamsSubject.next({ ...request(), unrelated: `${emission}` });
        }

        expect(dialogMock.open).toHaveBeenCalledTimes(1);
      }
    );

    it('does not treat a dismissal as a further request', () => {
      mount();
      emitAccesses();

      queryParamsSubject.next(editRequest());

      expect(dialogMock.open).toHaveBeenCalledTimes(1);

      // Dismissed. The close handler removes the parameters through a navigation,
      // and until that navigation is applied the URL still asks for the dialog that
      // has just gone - which is what made a dismissal a duplication trigger.
      dialogClosed.next(null);
      queryParamsSubject.next(editRequest());

      expect(dialogMock.open).toHaveBeenCalledTimes(1);
    });

    it('clears exactly the parameters its dialog travelled on', () => {
      mount();
      emitAccesses();

      queryParamsSubject.next(editRequest());
      routerMock.navigate.mockClear();

      dialogClosed.next(null);

      expect(routerMock.navigate).toHaveBeenCalledTimes(1);

      const [commands, extras] = routerMock.navigate.mock.calls[0];

      // An empty command list addresses the current route, which is the canvas -
      // naming a segment is what would discard every other parameter on it.
      expect(commands).toEqual([]);
      expect(extras.queryParamsHandling).toBe('merge');
      // `accessId` is absent on purpose: it belongs to the root host, where it
      // identifies a shared portfolio, so clearing it from here would close
      // somebody's share as a side effect of closing this dialog.
      expect(extras.queryParams).toEqual({
        accessDialogId: null,
        createDialog: null,
        dialogModule: null,
        editDialog: null
      });
    });

    it('reopens after the request is withdrawn and made again', () => {
      mount();
      emitAccesses();

      queryParamsSubject.next(editRequest());

      expect(dialogMock.open).toHaveBeenCalledTimes(1);

      // Withdrawn, which is what the close handler's navigation does to the URL.
      queryParamsSubject.next({});

      expect(dialogMock.open).toHaveBeenCalledTimes(1);

      queryParamsSubject.next(editRequest());

      expect(dialogMock.open).toHaveBeenCalledTimes(2);
    });

    it('opens again when the request moves to another grant', () => {
      const other = { ...createAccess(), id: 'OTHER_ACCESS_ID' };

      mount();
      emitAccesses([createAccess(), other]);

      queryParamsSubject.next(editRequest());
      queryParamsSubject.next(editRequest(other.id));

      expect(dialogMock.open).toHaveBeenCalledTimes(2);
      expect(dialogMock.open.mock.calls[1][1].data.access).toEqual(
        expect.objectContaining({ id: other.id })
      );
    });
  });

  describe('a request that arrives before the module can act on it', () => {
    it('honours an edit request that arrived before the grants did', () => {
      // Seeded before the module exists, which is what a deep link does: the canvas
      // materialises this module in response to an address that is already there.
      queryParamsSubject.next(editRequest());

      mount();

      // Nothing yet - the grant the request names is not known - and nothing
      // discarded either.
      expect(dialogMock.open).not.toHaveBeenCalled();
      expect(routerMock.navigate).not.toHaveBeenCalled();

      emitAccesses();

      expect(dialogMock.open).toHaveBeenCalledTimes(1);
      expect(dialogMock.open.mock.calls[0][1].data.access).toEqual(
        expect.objectContaining({ id: accessId })
      );
    });

    it('clears an edit request naming a grant that is not there', () => {
      queryParamsSubject.next(editRequest('GONE'));

      mount();
      emitAccesses();

      expect(dialogMock.open).not.toHaveBeenCalled();
      expect(routerMock.navigate).toHaveBeenCalledTimes(1);
    });

    it('sizes a dialog from the resolved device rather than from none', () => {
      deviceType = 'mobile';

      queryParamsSubject.next(createRequest());

      mount();
      emitAccesses();

      expect(dialogMock.open).toHaveBeenCalledTimes(1);

      const [, config] = dialogMock.open.mock.calls[0];

      // `deviceType` resolves in `ngOnInit`, after the constructor where this
      // request arrived. Acting on arrival laid the dialog out for a desktop.
      expect(config).toEqual(
        expect.objectContaining({ height: '98vh', width: '100vw' })
      );
    });
  });
});
