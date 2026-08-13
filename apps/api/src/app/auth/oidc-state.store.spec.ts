import { OidcStateStore } from './oidc-state.store';

/**
 * The unpredictability of the OpenID Connect `state` handle.
 *
 * The handle travels to the identity provider and back through the browser, and
 * verifying it on return is what tells a callback belonging to a flow this server
 * started apart from one an attacker composed. A guessable handle is therefore not
 * a weaker `state`; it is no `state` at all, because an attacker who can predict it
 * can present a callback the store will accept.
 *
 * These assertions are about the *properties* a handle must have rather than about
 * a particular generator, so they keep holding if the generator is replaced - and
 * they fail for the one it replaced, which produced handles from two `Math.random()`
 * outputs and a timestamp.
 */
describe('OidcStateStore', () => {
  /** How the store hands its generated handle back to its caller. */
  const store = (oidcStateStore: OidcStateStore) => {
    return new Promise<string>((resolve, reject) => {
      oidcStateStore.store(
        undefined,
        undefined,
        undefined,
        { nonce: 'nonce' },
        (error, handle) => {
          return error ? reject(error) : resolve(handle);
        }
      );
    });
  };

  let oidcStateStore: OidcStateStore;

  beforeEach(() => {
    oidcStateStore = new OidcStateStore();
  });

  it('issues a distinct handle every time', async () => {
    const handles = await Promise.all(
      Array.from({ length: 250 }, () => {
        return store(oidcStateStore);
      })
    );

    // A collision would let one flow's callback be accepted for another's state.
    expect(new Set(handles).size).toBe(handles.length);
  });

  it('issues a handle with at least 128 bits of entropy behind it', async () => {
    const handle = await store(oidcStateStore);

    // 22 base64url characters carry 132 bits, so this is the floor rather than a
    // guess at the current length. The generator it replaced produced roughly 26
    // characters drawn from `Math.random()`, which carries no cryptographic entropy
    // at all however long it is - hence the alphabet assertion below alongside this
    // one.
    expect(handle.length).toBeGreaterThanOrEqual(22);
    expect(handle).toMatch(/^[\w-]+$/);
  });

  it('does not derive the handle from the clock', async () => {
    const before = Date.now();
    const handle = await store(oidcStateStore);

    // The previous generator appended `Date.now().toString(36)` verbatim, which
    // made a third of the handle knowable to anybody who knew roughly when the
    // flow started. No timestamp from the surrounding second may appear.
    for (let offset = -1000; offset <= 1000; offset += 1) {
      expect(handle).not.toContain((before + offset).toString(36));
    }
  });

  it('is not reproducible from a seeded Math.random', async () => {
    // Pinned rather than merely stubbed: if the generator consulted `Math.random()`
    // at all, every handle produced under this spy would be the same string.
    const mathRandom = jest.spyOn(Math, 'random').mockReturnValue(0.5);

    try {
      const [first, second] = await Promise.all([
        store(oidcStateStore),
        store(oidcStateStore)
      ]);

      expect(first).not.toBe(second);
      expect(mathRandom).not.toHaveBeenCalled();
    } finally {
      mathRandom.mockRestore();
    }
  });

  it('accepts a handle it issued exactly once', async () => {
    const handle = await store(oidcStateStore);

    const verify = () => {
      return new Promise<unknown>((resolve, reject) => {
        oidcStateStore.verify(undefined, handle, (error, context) => {
          return error ? reject(error) : resolve(context);
        });
      });
    };

    // Single use is the other half of what makes `state` meaningful: a handle that
    // stayed valid would let one intercepted callback be replayed.
    expect(await verify()).toEqual({ nonce: 'nonce' });
    expect(await verify()).toBeUndefined();
  });

  it('accepts no handle it never issued', async () => {
    await store(oidcStateStore);

    const context = await new Promise<unknown>((resolve, reject) => {
      oidcStateStore.verify(
        undefined,
        'a-handle-nobody-issued',
        (error, ctx) => {
          return error ? reject(error) : resolve(ctx);
        }
      );
    });

    expect(context).toBeUndefined();
  });
});
