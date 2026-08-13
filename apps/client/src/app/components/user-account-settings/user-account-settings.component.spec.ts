/**
 * The document is served from a locale base href, exactly as the deployment does:
 * `i18n.locales` declares `baseHref: '/<code>/'` for every locale. The destinations
 * under test are relative, so the base is what gives them meaning - and without it
 * `'../'` resolves to the jsdom default root, i.e. to the page already loaded, and
 * jsdom reports no navigation at all because nothing would change.
 *
 * @jest-environment-options {"url": "http://localhost/en/"}
 */
import { SettingsStorageService } from '@ghostfolio/client/services/settings-storage.service';
import { UserService } from '@ghostfolio/client/services/user/user.service';
import { WebAuthnService } from '@ghostfolio/client/services/web-authn.service';
import { NotificationService } from '@ghostfolio/ui/notifications';
import { DataService } from '@ghostfolio/ui/services';

import { ComponentFixture, TestBed } from '@angular/core/testing';
import type { MatSelect } from '@angular/material/select';
import type { MatSlideToggleChange } from '@angular/material/slide-toggle';
import { MatSnackBar } from '@angular/material/snack-bar';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BehaviorSubject, Observable, of, throwError } from 'rxjs';

import { GfUserAccountSettingsComponent } from './user-account-settings.component';

/**
 * Switching language, which is the one place in this component that leaves the
 * application, and therefore the one place a single-route table could break.
 *
 * Ghostfolio is deployed per locale under a `/<code>/` base href, so changing
 * language means a real document load rather than an Angular navigation. The
 * destination is the locale root, which is the only address this application
 * answers - not `../<code>/<some path>`, which no route resolves.
 *
 * The failure this guards against is quiet and total: a stale path would still be
 * a well-formed URL, the browser would still load it, and the wildcard would still
 * redirect to the canvas - so the user would land somewhere that works while the
 * saved preference pointed at a dead address.
 *
 * The two halves of that claim are checked by different means, deliberately.
 *
 * *That* a departure happens - only for language, after the preference is
 * persisted - is observed at runtime, through jsdom's refusal to navigate, which it
 * reports on the virtual console as an `Error`.
 *
 * *Where* it departs to is asserted from the component's source, because in jsdom
 * it cannot be observed at all, for three separate reasons: the navigation report
 * carries no URL (`Not implemented: navigation (except hash
 * changes)` and nothing more), `Location.href` is `[LegacyUnforgeable]` so
 * redefining it throws `Cannot redefine property: href`, and assigning
 * `window.location` outright is silently ignored. The destination is a string
 * literal that is gone by the time anything is running, so reading the source is
 * the only way to see it - the same reason the router-preservation suite reads
 * `main.ts` as text.
 */
describe('GfUserAccountSettingsComponent', () => {
  /** How jsdom reports an attempt to leave the page. */
  const JSDOM_NAVIGATION_REPORT = 'Not implemented: navigation';

  /** The component as text, resolved from this spec's own location. */
  const componentSource = readFileSync(
    join(__dirname, 'user-account-settings.component.ts'),
    'utf8'
  );

  let fixture: ComponentFixture<GfUserAccountSettingsComponent>;
  let putUserSetting: (setting: Record<string, unknown>) => Observable<unknown>;
  /** Each setting handed to the facade, so the payload is checkable too. */
  let putUserSettingCalls: Record<string, unknown>[];

  /** Ordering between persisting the preference and leaving the page. */
  let callOrder: string[];

  /** How many departures jsdom refused to perform. */
  let departures: number;

  /**
   * A stand-in for the switch that was used, carrying a mutable `checked` exactly as
   * Material's own instance does, so a rollback is observable ON THE CONTROL rather
   * than only in `user.settings` - which is the whole distinction these specs exist to
   * hold, since the model was always being reconciled while the screen went on lying.
   */
  const createToggleEvent = (checked: boolean) => {
    return { checked, source: { checked } } as unknown as MatSlideToggleChange;
  };

  /** The same stand-in for a selection, whose mutable member is `value`. */
  const createSelect = (value: unknown = null) => {
    return { value } as unknown as MatSelect;
  };

  const createComponent = async () => {
    callOrder = [];

    putUserSettingCalls = [];
    putUserSetting = (setting: Record<string, unknown>) => {
      callOrder.push(`putUserSetting:${Object.keys(setting).join(',')}`);
      putUserSettingCalls.push(setting);

      return of({});
    };

    await TestBed.configureTestingModule({
      imports: [GfUserAccountSettingsComponent],
      providers: [
        {
          provide: DataService,
          useValue: {
            fetchInfo: jest.fn(() => ({
              baseCurrency: 'CHF',
              currencies: ['CHF', 'USD']
            })),
            putUserSetting: (setting: Record<string, unknown>) =>
              putUserSetting(setting)
          }
        },
        { provide: MatSnackBar, useValue: { open: jest.fn() } },
        // Reached only by the close-account confirmation, which nothing below
        // triggers. An unimplemented stub is the stricter choice: a call throws.
        { provide: NotificationService, useValue: {} },
        {
          provide: SettingsStorageService,
          useValue: { getSetting: jest.fn(), setSetting: jest.fn() }
        },
        {
          provide: UserService,
          useValue: {
            get: jest.fn(() => {
              callOrder.push('get');

              return of({
                permissions: [],
                settings: { language: 'en', locale: 'en-GB' }
              });
            }),
            stateChanged: new BehaviorSubject({
              user: {
                permissions: [],
                settings: { language: 'en', locale: 'en-GB' }
              }
            })
          }
        },
        {
          provide: WebAuthnService,
          useValue: { isEnabled: jest.fn(() => false) }
        }
      ]
    })
      // No template: this suite is about a document-level departure, and no form
      // control in the view participates in it.
      .overrideComponent(GfUserAccountSettingsComponent, {
        set: { imports: [], template: '' }
      })
      .compileComponents();

    fixture = TestBed.createComponent(GfUserAccountSettingsComponent);

    fixture.detectChanges();

    return fixture.componentInstance;
  };

  beforeEach(() => {
    departures = 0;

    const reportError = console.error.bind(console) as (
      ...args: unknown[]
    ) => void;

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
        callOrder.push('depart');
        departures = departures + 1;

        return;
      }

      reportError(...args);
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('switching language', () => {
    it.each(['de', 'pt', 'zh'])('leaves the page for %s', async (language) => {
      const component = await createComponent();

      component.onChangeUserSetting('language', language);

      // A new locale is served as a different document, so an Angular navigation
      // could not reach it.
      expect(departures).toBe(1);
    });

    it('leaves the page when the language is cleared', async () => {
      const component = await createComponent();

      component.onChangeUserSetting('language', null);

      expect(departures).toBe(1);
    });

    it('persists the preference before leaving', async () => {
      const component = await createComponent();

      component.onChangeUserSetting('language', 'de');

      // Departing first would abandon the write in flight, so the preference would
      // not survive the very reload it triggers.
      expect(callOrder).toEqual(['putUserSetting:language', 'get', 'depart']);

      // And the write is the one the viewer asked for, not merely some write.
      expect(putUserSettingCalls).toEqual([{ language: 'de' }]);
    });

    it('leaves once, not once per re-render', async () => {
      const component = await createComponent();

      component.onChangeUserSetting('language', 'de');

      fixture.detectChanges();

      expect(departures).toBe(1);
    });
  });

  describe('every other setting', () => {
    it.each(['baseCurrency', 'dateRange', 'locale', 'viewMode'])(
      'stays on the page for %s',
      async (key) => {
        const component = await createComponent();

        component.onChangeUserSetting(key, 'any-value');

        // Only a language change is a document-level departure. Reloading for the
        // rest would discard the canvas the viewer is looking at.
        expect(departures).toBe(0);
        expect(callOrder).toEqual([`putUserSetting:${key}`, 'get']);
        expect(putUserSettingCalls).toEqual([{ [key]: 'any-value' }]);
      }
    );

    it('agrees with the control it was given when the write is accepted', async () => {
      const component = await createComponent();
      const source = createSelect('en-GB');

      component.onChangeUserSetting('locale', 'en-GB', source);

      // The rollback runs on both paths on purpose, so there is one path rather than
      // two. On acceptance the reconciled value IS what was chosen, which makes it a
      // no-op agreeing with itself - and that is what stops a success from being
      // reconciled by a second, separate piece of code that could drift.
      expect(callOrder).toEqual(['putUserSetting:locale', 'get']);
      expect(source.value).toBe('en-GB');
    });
  });

  /**
   * What happens to the screen when a settings write is refused.
   *
   * Every control here is bound to `user.settings`, and Material applies a toggle or a
   * selection to its own view state the moment it is used. These writes had no failure
   * handler at all, so a refusal left the control sitting in its new position over a
   * server that had kept the old one, said nothing, and stayed that way. For restricted
   * view - which decides whether figures are shown - that is a setting the viewer
   * believes they have changed and have not.
   */
  describe('a settings write that is refused', () => {
    /**
     * Rebuilt with a refusing facade and a viewer whose settings differ from what was
     * just asked for, so the re-read is observable as a genuine rollback rather than as
     * a no-op.
     */
    const createRefusingComponent = async () => {
      const alert = jest.fn();

      TestBed.resetTestingModule();

      callOrder = [];
      putUserSettingCalls = [];

      await TestBed.configureTestingModule({
        imports: [GfUserAccountSettingsComponent],
        providers: [
          {
            provide: DataService,
            useValue: {
              fetchInfo: jest.fn(() => ({
                baseCurrency: 'CHF',
                currencies: ['CHF', 'USD']
              })),
              putUserSetting: (setting: Record<string, unknown>) => {
                callOrder.push(
                  `putUserSetting:${Object.keys(setting).join(',')}`
                );
                putUserSettingCalls.push(setting);

                return throwError(() => ({ status: 500 }));
              }
            }
          },
          { provide: MatSnackBar, useValue: { open: jest.fn() } },
          { provide: NotificationService, useValue: { alert } },
          {
            provide: SettingsStorageService,
            useValue: { getSetting: jest.fn(), setSetting: jest.fn() }
          },
          {
            provide: UserService,
            useValue: {
              get: jest.fn(() => {
                callOrder.push('get');

                // What the server actually holds: restricted view OFF, which is the
                // opposite of what the toggle was just switched to.
                return of({
                  permissions: [],
                  settings: {
                    baseCurrency: 'CHF',
                    isRestrictedView: false,
                    language: 'en',
                    locale: 'en-GB'
                  }
                });
              }),
              stateChanged: new BehaviorSubject({
                user: {
                  permissions: [],
                  settings: {
                    baseCurrency: 'CHF',
                    isRestrictedView: false,
                    language: 'en',
                    locale: 'en-GB'
                  }
                }
              })
            }
          },
          {
            provide: WebAuthnService,
            useValue: { isEnabled: jest.fn(() => false) }
          }
        ]
      })
        .overrideComponent(GfUserAccountSettingsComponent, {
          set: { imports: [], template: '' }
        })
        .compileComponents();

      const refusingFixture = TestBed.createComponent(
        GfUserAccountSettingsComponent
      );

      refusingFixture.detectChanges();

      return { alert, component: refusingFixture.componentInstance };
    };

    it('re-reads the viewer, which is what rolls the control back', async () => {
      const { component } = await createRefusingComponent();

      callOrder = [];

      component.onRestrictedViewChange(createToggleEvent(true));

      // The control is bound to what comes back, so whatever the server holds is what
      // ends up on the screen. Nothing has to be remembered and nothing is assumed
      // about how far the write got.
      expect(callOrder).toEqual(['putUserSetting:isRestrictedView', 'get']);
      expect(component.user.settings.isRestrictedView).toBe(false);
    });

    it('says so, rather than leaving the viewer to find out', async () => {
      const { alert, component } = await createRefusingComponent();

      component.onRestrictedViewChange(createToggleEvent(true));

      expect(alert).toHaveBeenCalledWith({
        title: 'Your setting could not be saved. Please try again.'
      });
    });

    it.each([
      [
        'a selection',
        (component: GfUserAccountSettingsComponent) =>
          component.onChangeUserSetting('baseCurrency', 'USD', createSelect())
      ],
      [
        'the experimental switch',
        (component: GfUserAccountSettingsComponent) =>
          component.onExperimentalFeaturesChange(createToggleEvent(true))
      ],
      [
        'the restricted view switch',
        (component: GfUserAccountSettingsComponent) =>
          component.onRestrictedViewChange(createToggleEvent(true))
      ]
    ])('reconciles %s the same way', async (_label, use) => {
      const { component } = await createRefusingComponent();

      callOrder = [];

      // Every write goes through one path, so none of them can be the one that was
      // forgotten - which is how these three came to differ in the first place.
      use(component);

      expect(callOrder).toContain('get');
    });

    /**
     * The re-read alone does not move the control, and runtime is what proved it.
     *
     * Angular writes an `@Input` only when the bound expression has CHANGED since it
     * last wrote it, and the click changed the control's own state rather than the
     * recorded binding. Turning an absent setting on and being refused therefore leaves
     * the expression at `undefined` on both sides of the re-read: nothing is written,
     * and the switch keeps the position the click gave it - reading ON over a server
     * holding OFF, in a browser, for as long as the module stays mounted.
     *
     * So these assert on the CONTROL, not on `user.settings`. The model was already
     * being reconciled correctly while the screen went on lying.
     */
    describe('putting the control back', () => {
      it('moves the switch itself, not only the model', async () => {
        const { component } = await createRefusingComponent();
        const event = createToggleEvent(true);

        component.onRestrictedViewChange(event);

        expect(component.user.settings.isRestrictedView).toBe(false);
        expect(event.source.checked).toBe(false);
      });

      it('moves a switch whose setting the server does not hold at all', async () => {
        const { component } = await createRefusingComponent();
        const event = createToggleEvent(true);

        // The exact runtime condition: the reconciled viewer carries no
        // `isExperimentalFeatures` key, so both sides of the re-read read `undefined`
        // and an unchanged binding is written nowhere. Absent means off.
        component.onExperimentalFeaturesChange(event);

        expect(component.user.settings.isExperimentalFeatures).toBeUndefined();
        expect(event.source.checked).toBe(false);
      });

      it('moves the selection back to what the server holds', async () => {
        const { component } = await createRefusingComponent();
        const source = createSelect('USD');

        component.onChangeUserSetting('baseCurrency', 'USD', source);

        expect(source.value).toBe('CHF');
      });

      it('leaves the served locale in place when a language change is refused', async () => {
        const { component } = await createRefusingComponent();
        const source = createSelect('de');

        component.onChangeUserSetting('language', 'de', source);

        // `language` is the locale the document was served under rather than something
        // read back from the viewer, and a refused change never departs - so the
        // served locale IS what the control must go back to.
        expect(source.value).toBe(component.language);
      });

      it('still writes and still reports when no control was handed over', async () => {
        const { alert, component } = await createRefusingComponent();

        // The value alone is enough to make the write, so a caller with no Material
        // selection to hand over must not be made to fail.
        expect(() =>
          component.onChangeUserSetting('baseCurrency', 'USD')
        ).not.toThrow();

        expect(putUserSettingCalls).toEqual([{ baseCurrency: 'USD' }]);
        expect(alert).toHaveBeenCalled();
      });
    });

    it('does not leave the page when a language change is refused', async () => {
      const { component } = await createRefusingComponent();

      component.onChangeUserSetting('language', 'de');

      // Departing would load a locale the server never accepted, and the reload would
      // hide the failure on the way out.
      expect(departures).toBe(0);
    });
  });

  describe('the destination', () => {
    it('is the locale root and nothing more', () => {
      // `../` climbs out of the current `/<code>/` base href and the new code
      // becomes the whole path. Both the prefix and the trailing slash are part of
      // the contract, which is why the literal is matched whole.
      expect(componentSource).toContain(
        'window.location.href = `../${aValue}/`'
      );
    });

    it('falls back to the deployment root when no language is set', () => {
      expect(componentSource).toContain("window.location.href = '../'");
    });

    it.each([
      'account',
      'accounts',
      'admin',
      'home',
      'portfolio',
      'start',
      'zen'
    ])('names no retired %s route', (retired) => {
      // Every internal route name is checked rather than only the account one,
      // because the failure mode is any path segment at all surviving in this
      // string.
      expect(componentSource).not.toContain(`\${aValue}/${retired}`);
    });

    it('builds the destination from no route constant at all', () => {
      // A route constant reappearing here is the regression, whatever it resolves
      // to: the locale root is reachable without one.
      expect(componentSource).not.toContain('internalRoutes');
      expect(componentSource).not.toContain('publicRoutes');
    });
  });
});
