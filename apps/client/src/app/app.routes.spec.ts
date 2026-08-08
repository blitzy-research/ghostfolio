import { internalRoutes } from '@ghostfolio/common/routes/routes';

import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Title } from '@angular/platform-browser';
import { Route, Router, TitleStrategy, provideRouter } from '@angular/router';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { firstValueFrom, of } from 'rxjs';

import { routes } from './app.routes';
import { AuthGuard } from './core/auth.guard';
import { ModulePreloadService } from './core/module-preload.service';
import { GfDashboardCanvasComponent } from './dashboard/dashboard-canvas/dashboard-canvas.component';
import { PageTitleStrategy } from './services/page-title.strategy';

/**
 * The router contract of the single-canvas shell.
 *
 * Exactly one route renders anything, and the Angular Router itself is fully
 * *preserved* around it. Both halves of that are regressions waiting to happen and
 * neither is visible to a compiler.
 *
 * The route table is asserted directly, because it is an exported array. A second
 * route added for "just this one screen" would compile, would work, and would
 * reintroduce a navigation surface; and a wildcard pointing at a path this
 * application does not serve would send every stale bookmark to a blank screen.
 *
 * The four preserved bootstrap facilities are asserted in two complementary ways,
 * because `apps/client/src/main.ts` cannot be imported: its body is a top-level
 * async function that `fetch`es `/api/v1/info` and calls `bootstrapApplication` as
 * a side effect of being loaded. Importing it from a spec would start the whole
 * application. So:
 *
 *  - the *registrations* are asserted against the text of `main.ts`, which is what
 *    catches a provider being dropped, renamed or reconfigured;
 *  - the *behaviour* of the two facilities that carry logic - the title strategy
 *    and the preloading strategy - is asserted by exercising them, which is what
 *    catches a facility that is registered but does not do its job.
 *
 * Reading a source file in a test is unusual enough to deserve the reason: the
 * alternative is asserting nothing at all about the provider block, and the
 * provider block is precisely what the preservation rule is about.
 */
describe('the single-canvas router contract', () => {
  /**
   * `main.ts` as text. Resolved from this spec's own location so the assertion
   * cannot silently pass by reading a file that does not exist - `readFileSync`
   * throws instead.
   */
  const mainSource = readFileSync(join(__dirname, '..', 'main.ts'), 'utf8');

  describe('the route table', () => {
    it('declares exactly one screen route and one wildcard', () => {
      // The count is the rule. Anything added here is a second address the
      // application answers at, which is what the canvas replaced.
      expect(routes).toHaveLength(2);
    });

    it('renders the canvas at the root path, behind the route guard', () => {
      const [root] = routes;

      expect(root.path).toBe('');
      expect(root.canActivate).toEqual([AuthGuard]);
      expect(root.component).toBe(GfDashboardCanvasComponent);
    });

    it('declares the root route eagerly, because code splitting moved to the registry', () => {
      const [root] = routes;

      // The route table declares no lazy boundary at all; the module registry's own
      // lazy loaders are where code splitting happens. The root route is the one
      // thing every visit needs, so deferring it would add a round trip and buy
      // nothing.
      expect(root.loadComponent).toBeUndefined();
      expect(root.loadChildren).toBeUndefined();
      expect(root.children).toBeUndefined();
    });

    it('gives the root route a title, so the title strategy stays exercised', () => {
      const [root] = routes;

      // Reusing an already-translated string from the shared route registry rather
      // than introducing a new source message, which would have to be translated
      // into twelve locales to say what this one already says.
      expect(root.title).toBe(internalRoutes.home.title);
      expect(root.title).toBeTruthy();
    });

    it('redirects every other address to the root, not to a deleted path', () => {
      const [, wildcard] = routes;

      // The only path this application serves is the root, so this assertion is
      // the difference between a stale bookmark landing on the canvas and landing
      // on nothing.
      expect(wildcard.path).toBe('**');
      expect(wildcard.redirectTo).toBe('');
      expect(wildcard.pathMatch).toBe('full');
    });

    it('declares no path this application does not serve', () => {
      const declaredPaths = routes.map(({ path }) => path);

      for (const retired of [
        'about',
        'account',
        'accounts',
        'admin',
        'auth',
        'blog',
        'demo',
        'faq',
        'features',
        'home',
        'markets',
        'p',
        'portfolio',
        'pricing',
        'register',
        'resources',
        'start',
        'zen'
      ]) {
        expect(declaredPaths).not.toContain(retired);
      }
    });
  });

  describe('the preserved bootstrap facilities', () => {
    it('keeps the router registered with its original options', () => {
      // Asserted as text because the provider block cannot be imported; see this
      // suite's documentation. Each option is asserted separately so a failure
      // names the one that changed.
      expect(mainSource).toContain('RouterModule.forRoot(routes, {');
      expect(mainSource).toContain("anchorScrolling: 'enabled'");
      expect(mainSource).toContain('preloadingStrategy: ModulePreloadService');
      expect(mainSource).toContain("scrollPositionRestoration: 'top'");
    });

    it('keeps the service worker registered for navigation handling', () => {
      expect(mainSource).toContain(
        "ServiceWorkerModule.register('ngsw-worker.js'"
      );
      expect(mainSource).toContain('enabled: environment.production');
      expect(mainSource).toContain(
        "registrationStrategy: 'registerImmediately'"
      );
    });

    it('keeps the page title strategy provided', () => {
      expect(mainSource).toContain('provide: TitleStrategy');
      expect(mainSource).toContain('useClass: PageTitleStrategy');
    });

    it('keeps the preloading strategy provided as an injectable', () => {
      // Registered twice on purpose, and both are needed: as the router's
      // `preloadingStrategy` above, and as a provider so that reference can be
      // resolved.
      expect(mainSource).toContain('ModulePreloadService,');
    });

    it('registers the routes it imports from the route table under test', () => {
      // Guards against the two halves drifting apart: a spec that pinned the array
      // while the bootstrap passed a different one would prove nothing.
      expect(mainSource).toContain("import { routes } from './app/app.routes'");
    });
  });

  describe('PageTitleStrategy', () => {
    /** A component to activate; the strategy is what is under test, not the view. */
    @Component({ selector: 'gf-test-screen', template: '' })
    class GfTestScreenComponent {}

    let setTitle: jest.Mock;

    /**
     * Navigates a real router over a real route table so the strategy is invoked
     * the way the application invokes it - once per successful navigation, with the
     * router's own state snapshot.
     *
     * A hand-built snapshot was the obvious alternative and is the weaker one: the
     * inherited `buildTitle` reads a resolved title out of `data` under a key the
     * router owns and does not export, so a fake would have had to guess at that
     * key and would have gone on passing if the strategy stopped reading titles
     * altogether.
     */
    const navigateWith = async (aTitle?: string) => {
      setTitle = jest.fn();

      TestBed.configureTestingModule({
        providers: [
          provideRouter([
            { component: GfTestScreenComponent, path: '', title: aTitle }
          ]),
          { provide: Title, useValue: { setTitle } },
          { provide: TitleStrategy, useClass: PageTitleStrategy }
        ]
      });

      await TestBed.inject(Router).navigateByUrl('/');
    };

    it('suffixes a resolved route title', async () => {
      await navigateWith('Overview');

      // Still exercised rather than merely registered: this is the path the root
      // route's own `title` reaches.
      expect(setTitle).toHaveBeenCalledWith('Overview – Ghostfolio');
    });

    it('falls back to the full product title when a route resolves none', async () => {
      await navigateWith();

      expect(setTitle).toHaveBeenCalledWith(
        'Ghostfolio – Open Source Wealth Management Software'
      );
    });

    it('runs on the title the real root route declares', async () => {
      await navigateWith(internalRoutes.home.title);

      // Ties the two halves together: the table's declared title and the strategy's
      // treatment of it are asserted against each other rather than each against a
      // literal of its own.
      expect(setTitle).toHaveBeenCalledWith(
        `${internalRoutes.home.title} – Ghostfolio`
      );
    });
  });

  describe('ModulePreloadService', () => {
    let service: ModulePreloadService;

    beforeEach(() => {
      TestBed.configureTestingModule({ providers: [ModulePreloadService] });

      service = TestBed.inject(ModulePreloadService);
    });

    it('preloads a route that asks to be preloaded', async () => {
      const load = jest.fn(() => of('loaded'));

      await expect(
        firstValueFrom(service.preload({ data: { preload: true } }, load))
      ).resolves.toBe('loaded');
      expect(load).toHaveBeenCalledTimes(1);
    });

    it.each([
      { description: 'no data at all', route: {} as Route },
      { description: 'data without the flag', route: { data: {} } as Route },
      {
        description: 'the flag switched off',
        route: { data: { preload: false } } as Route
      }
    ])('loads nothing for a route with $description', async ({ route }) => {
      const load = jest.fn(() => of('loaded'));

      await expect(
        firstValueFrom(service.preload(route, load))
      ).resolves.toBeNull();
      expect(load).not.toHaveBeenCalled();
    });

    it('is unreachable from the route table, and therefore unchanged by it', () => {
      // The strategy governs `loadChildren` only, and no route declares the flag, so
      // it is inert. Keeping it registered preserves the router wiring without
      // claiming that anything preloads, and this assertion is what keeps that
      // statement true.
      for (const route of routes) {
        expect(route.data?.preload).toBeUndefined();
        expect(route.loadChildren).toBeUndefined();
      }
    });
  });
});
