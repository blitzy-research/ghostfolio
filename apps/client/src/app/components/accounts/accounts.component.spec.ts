import { ImpersonationStorageService } from '@ghostfolio/client/services/impersonation-storage.service';
import { UserService } from '@ghostfolio/client/services/user/user.service';
import type { User } from '@ghostfolio/common/interfaces';
import { GfAccountsTableComponent } from '@ghostfolio/ui/accounts-table';
import { NotificationService } from '@ghostfolio/ui/notifications';
import { DataService } from '@ghostfolio/ui/services';

import { Component, EventEmitter, Input, Output } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
// Static strings in this tree are marked for translation, which compiles to
// `$localize` calls evaluated at module scope. Nothing installs that global in a
// jsdom environment - `apps/client/src/polyfills.ts` installs it for the
// application and no test setup file stands in for it - so it is installed here,
// exactly as the dashboard specs do.
import '@angular/localize/init';
import { MatDialog } from '@angular/material/dialog';
import { ActivatedRoute, Router } from '@angular/router';
import type { Params } from '@angular/router';
import type { Account as AccountModel } from '@prisma/client';
import { DeviceDetectorService } from 'ngx-device-detector';
// The dialogs this module opens reference validated data transfer objects as
// runtime values, and those objects are decorated with `class-transformer`, which
// reads decorator metadata through the reflection API. `polyfills.ts` installs it
// for the application; nothing installs it for a jsdom test environment, so it is
// installed here for the same reason as the localization global above.
import 'reflect-metadata';
import { BehaviorSubject, of } from 'rxjs';

// Reached through the client-side re-export rather than the shared entry point,
// and the position is the reason: this group is evaluated after the localization
// global above, whereas naming `@ghostfolio/common/dashboard` in the first group
// would evaluate its translated metadata map before that global exists. The
// symbol is identical either way.
import { DashboardModuleType } from '../../dashboard/enums/dashboard-module-type';
import { GfAccountsComponent } from './accounts.component';

// Cuts the one import chain that would otherwise evaluate the shared route
// metadata - and therefore call `$localize` - before the global above is
// installed: the viewer store holds a reference to this dialog so it can hand the
// class to `MatDialog.open`. The store is supplied here as a stub, so neither the
// dialog nor the path that opens it is reachable from this spec.
jest.mock(
  '@ghostfolio/client/components/subscription-interstitial-dialog/subscription-interstitial-dialog.component',
  () => {
    return { GfSubscriptionInterstitialDialogComponent: class {} };
  }
);

/**
 * Stands in for the shared accounts table.
 *
 * It declares every input the host binds and every output the host listens to,
 * which is the whole of that contract. It matters here for a second reason as
 * well: the real table is the one producer of an account detail request that
 * deliberately does not name a module, which is why this module owns the
 * unqualified form of that flag.
 */
@Component({ selector: 'gf-accounts-table', template: '' })
class GfTestAccountsTableComponent {
  @Input() public accounts: AccountModel[];
  @Input() public activitiesCount: number;
  @Input() public baseCurrency: string;
  @Input() public locale: string;
  @Input() public showActions: boolean;
  @Input() public totalBalanceInBaseCurrency: number;
  @Input() public totalValueInBaseCurrency: number;

  @Output() public accountDeleted = new EventEmitter<string>();
  @Output() public accountToUpdate = new EventEmitter<AccountModel>();
  @Output() public transferBalance = new EventEmitter<void>();
}

/**
 * Specification for the accounts module's query parameter contract.
 *
 * The application resolves to a single canvas, so every mounted module observes
 * the same address at the same moment: a bare `createDialog`, `editDialog` or
 * `transferBalanceDialog` is seen by the activities module, the account access
 * module and this one simultaneously. Those flags are therefore only honoured when
 * the producer names the module it addressed.
 *
 * `accountDetailDialog` is the single documented exception and is pinned here as
 * carefully as the rule itself, because it is the one place where accepting an
 * unqualified address is correct rather than a lapse: the shared accounts table
 * this module hosts issues that flag without a qualifier, so this module is its
 * default owner. The allocations module, which also knows how to open that dialog,
 * requires its own name instead - which is what keeps exactly one module reacting
 * to any given address.
 */
describe('GfAccountsComponent', () => {
  let component: GfAccountsComponent;
  let dialogMock: { open: jest.Mock };
  let fixture: ComponentFixture<GfAccountsComponent>;
  let queryParamsSubject: BehaviorSubject<Params>;
  let routerMock: { navigate: jest.Mock };
  let stateChangedSubject: BehaviorSubject<{ user: User }>;

  /**
   * A viewer with no permissions at all.
   *
   * Deliberate: without the create permission the floating action button is not
   * rendered, so no router link is instantiated and the address bar is touched
   * only by the code under test.
   */
  const createUser = (aUser: Partial<User> = {}) => {
    return {
      permissions: [],
      settings: {
        baseCurrency: 'USD',
        isRestrictedView: false,
        language: 'en',
        locale: 'en-US'
      },
      ...aUser
    } as User;
  };

  /**
   * One account, so that the module is never in its empty state.
   *
   * An empty list asks for the create dialog by itself, which would put a
   * navigation into every test that did not ask for one.
   */
  const createAccountsResponse = () => {
    return {
      accounts: [{ id: 'ACCOUNT_ID', name: 'Account' } as AccountModel],
      activitiesCount: 1,
      totalBalanceInBaseCurrency: 0,
      totalValueInBaseCurrency: 0
    };
  };

  beforeEach(async () => {
    queryParamsSubject = new BehaviorSubject<Params>({});
    stateChangedSubject = new BehaviorSubject<{ user: User }>({
      user: createUser()
    });

    dialogMock = {
      open: jest.fn(() => {
        return {
          afterClosed: () => {
            return of(null);
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
      imports: [GfAccountsComponent],
      providers: [
        {
          provide: ActivatedRoute,
          useValue: { queryParams: queryParamsSubject }
        },
        {
          provide: DataService,
          useValue: {
            fetchAccounts: jest.fn(() => {
              return of(createAccountsResponse());
            })
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
          provide: ImpersonationStorageService,
          useValue: {
            onChangeHasImpersonation: () => {
              return of(null);
            }
          }
        },
        { provide: MatDialog, useValue: dialogMock },
        { provide: NotificationService, useValue: { alert: jest.fn() } },
        { provide: Router, useValue: routerMock },
        {
          provide: UserService,
          useValue: {
            get: jest.fn(() => {
              return of(createUser());
            }),
            stateChanged: stateChangedSubject
          }
        }
      ]
    })
      .overrideComponent(GfAccountsComponent, {
        add: { imports: [GfTestAccountsTableComponent] },
        remove: { imports: [GfAccountsTableComponent] }
      })
      .compileComponents();

    fixture = TestBed.createComponent(GfAccountsComponent);
    component = fixture.componentInstance;

    fixture.detectChanges();

    // Cleared after initialization so that every test below observes only the
    // addresses it produced itself.
    routerMock.navigate.mockClear();
  });

  describe('creation', () => {
    it('is created', () => {
      expect(component).toBeTruthy();
    });
  });

  describe('generic dialog flag ownership', () => {
    it('ignores an unqualified create request', () => {
      stateChangedSubject.next({
        user: createUser({ permissions: ['createAccount'] })
      });
      dialogMock.open.mockClear();

      queryParamsSubject.next({ createDialog: 'true' });

      // The permission is deliberately granted first, so that a rejection here
      // can only be the missing module name and not a missing permission.
      expect(dialogMock.open).not.toHaveBeenCalled();
    });

    it('ignores a create request addressed to another module', () => {
      stateChangedSubject.next({
        user: createUser({ permissions: ['createAccount'] })
      });
      dialogMock.open.mockClear();

      queryParamsSubject.next({
        createDialog: 'true',
        dialogModule: DashboardModuleType.ACTIVITIES
      });

      expect(dialogMock.open).not.toHaveBeenCalled();
    });

    it('ignores an edit request addressed to another module', () => {
      queryParamsSubject.next({
        accountId: 'ACCOUNT_ID',
        dialogModule: DashboardModuleType.ACTIVITIES,
        editDialog: 'true'
      });

      expect(dialogMock.open).not.toHaveBeenCalled();
    });

    it('ignores a balance transfer request addressed to another module', () => {
      queryParamsSubject.next({
        dialogModule: DashboardModuleType.ACTIVITIES,
        transferBalanceDialog: 'true'
      });

      expect(dialogMock.open).not.toHaveBeenCalled();
    });

    it('answers a create request addressed to this module', () => {
      stateChangedSubject.next({
        user: createUser({ permissions: ['createAccount'] })
      });
      dialogMock.open.mockClear();

      queryParamsSubject.next({
        createDialog: 'true',
        dialogModule: DashboardModuleType.ACCOUNTS
      });

      expect(dialogMock.open).toHaveBeenCalledTimes(1);
    });

    it('answers an edit request addressed to this module', () => {
      queryParamsSubject.next({
        accountId: 'ACCOUNT_ID',
        dialogModule: DashboardModuleType.ACCOUNTS,
        editDialog: 'true'
      });

      expect(dialogMock.open).toHaveBeenCalledTimes(1);
    });

    it('answers a balance transfer request addressed to this module', () => {
      queryParamsSubject.next({
        dialogModule: DashboardModuleType.ACCOUNTS,
        transferBalanceDialog: 'true'
      });

      expect(dialogMock.open).toHaveBeenCalledTimes(1);
    });
  });

  describe('account detail dialog ownership', () => {
    it('answers an unqualified account detail request', () => {
      queryParamsSubject.next({
        accountDetailDialog: 'true',
        accountId: 'ACCOUNT_ID'
      });

      // The documented exception. The shared accounts table this module hosts
      // emits exactly this address, so refusing it would leave a click on an
      // account row doing nothing at all.
      expect(dialogMock.open).toHaveBeenCalledTimes(1);
    });

    it('answers an account detail request addressed to this module', () => {
      queryParamsSubject.next({
        accountDetailDialog: 'true',
        accountId: 'ACCOUNT_ID',
        dialogModule: DashboardModuleType.ACCOUNTS
      });

      expect(dialogMock.open).toHaveBeenCalledTimes(1);
    });

    it('ignores an account detail request addressed to another module', () => {
      queryParamsSubject.next({
        accountDetailDialog: 'true',
        accountId: 'ACCOUNT_ID',
        dialogModule: DashboardModuleType.ALLOCATIONS
      });

      // The allocations module opens this dialog for itself. Answering its
      // address here is what opened the dialog twice for one click.
      expect(dialogMock.open).not.toHaveBeenCalled();
    });
  });

  describe('generic dialog flag production', () => {
    /**
     * The parameters and the merge mode of the last request, without the
     * `relativeTo` snapshot.
     *
     * Every producer here merges relative to its own route, so the extras carry
     * the live `ActivatedRoute` - an object graph with subjects and subscriptions
     * in it. Comparing the extras whole would assert that graph rather than the
     * request, and would fail on any unrelated change to it.
     */
    const lastRequest = () => {
      const [commands, extras] = routerMock.navigate.mock.calls.at(-1);

      return {
        commands,
        queryParams: extras.queryParams,
        queryParamsHandling: extras.queryParamsHandling
      };
    };

    it('names this module when asking to update an account', () => {
      component.onUpdateAccount({ id: 'ACCOUNT_ID' } as AccountModel);

      expect(lastRequest()).toEqual({
        commands: [],
        queryParams: {
          accountId: 'ACCOUNT_ID',
          dialogModule: DashboardModuleType.ACCOUNTS,
          editDialog: true
        },
        queryParamsHandling: 'merge'
      });
    });

    it('names this module when asking to transfer a balance', () => {
      component.onTransferBalance();

      // Named even though this flag has a single consumer, because the request is
      // merged: a `dialogModule` any earlier interaction left on the URL would
      // otherwise survive it and make the handler stand down as addressed
      // elsewhere, leaving the control silently inert.
      expect(lastRequest()).toEqual({
        commands: [],
        queryParams: {
          dialogModule: DashboardModuleType.ACCOUNTS,
          transferBalanceDialog: true
        },
        queryParamsHandling: 'merge'
      });
    });

    it('neutralises every competing flag when asking for a blank create form', () => {
      // The payload the floating action button binds. `accountDetailDialog` and
      // `accountId` are tested *ahead* of `createDialog`, so a stale pair would
      // re-open the detail dialog instead of the create form;
      // `transferBalanceDialog` is tested *after* it, so a stale one would open on
      // top of the form the moment it was dismissed. Merging is what keeps that
      // clear confined to the six keys this module owns, rather than also
      // discarding the shared-portfolio access identifier and the sign-in token
      // hand-off.
      expect(component.createDialogQueryParams).toEqual({
        accountDetailDialog: null,
        accountId: null,
        createDialog: true,
        dialogModule: DashboardModuleType.ACCOUNTS,
        editDialog: null,
        transferBalanceDialog: null
      });
    });
  });

  describe('onboarding', () => {
    it('opens nothing automatically for a viewer holding no accounts', () => {
      (
        TestBed.inject(DataService).fetchAccounts as unknown as jest.Mock
      ).mockReturnValue(
        of({
          accounts: [],
          activitiesCount: 0,
          totalBalanceInBaseCurrency: 0,
          totalValueInBaseCurrency: 0
        })
      );

      stateChangedSubject.next({
        user: createUser({ permissions: ['createAccount'] })
      });
      dialogMock.open.mockClear();
      routerMock.navigate.mockClear();

      component.fetchAccounts();

      // This module used to ask for its create dialog here. The activities module
      // made the same offer for the same viewer at the same moment, and which of
      // the two responses arrived first decided whether one onboarding dialog
      // appeared or two appeared stacked - an outcome the route-per-screen shell
      // could not produce, because only one of the two screens was ever mounted.
      // The offer is now made by the empty state this module renders and by its
      // floating action button, both of which the viewer chooses to act on.
      expect(routerMock.navigate).not.toHaveBeenCalled();
      expect(dialogMock.open).not.toHaveBeenCalled();
    });
  });

  describe('cold placement', () => {
    it('opens one dialog when the same request is re-observed', () => {
      queryParamsSubject.next({
        accountDetailDialog: 'true',
        accountId: 'ACCOUNT_ID'
      });

      // Every producer on the canvas merges rather than replaces, so
      // `route.queryParams` emits again whenever any *other* module writes to the
      // URL. Four prerequisites also re-evaluate the held parameters as they
      // arrive. Both make re-notification the norm rather than the exception.
      queryParamsSubject.next({
        accessId: 'ACCESS_ID',
        accountDetailDialog: 'true',
        accountId: 'ACCOUNT_ID'
      });

      expect(dialogMock.open).toHaveBeenCalledTimes(1);
    });

    it('honours the same request again once the parameters have been cleared', () => {
      queryParamsSubject.next({
        accountDetailDialog: 'true',
        accountId: 'ACCOUNT_ID'
      });

      // What the close handler does: the parameters the dialog travelled on are
      // removed. Observing their absence is what lets the identical request count
      // as new, which is why the guard is keyed on the request the URL is making
      // rather than on the dialog's own lifecycle - `fetchAccounts` re-evaluates
      // the parameters, and every close handler calls it.
      queryParamsSubject.next({});
      queryParamsSubject.next({
        accountDetailDialog: 'true',
        accountId: 'ACCOUNT_ID'
      });

      expect(dialogMock.open).toHaveBeenCalledTimes(2);
    });

    it('does not re-open the dialog that has just closed', () => {
      // The close path in full: the stubbed dialog reports itself closed
      // synchronously, its handler calls `fetchAccounts`, and the stubbed data
      // service answers synchronously too - so the whole cycle runs inside this
      // one emission, with the clearing navigation still unapplied because the
      // router is a stub. That is the tightest form of the race, and it used to
      // reopen the dialog without bound.
      queryParamsSubject.next({
        accountDetailDialog: 'true',
        accountId: 'ACCOUNT_ID'
      });

      expect(dialogMock.open).toHaveBeenCalledTimes(1);
    });
  });
});
