import ms from 'ms';
import { randomBytes } from 'node:crypto';

/**
 * Custom state store for OIDC authentication that doesn't rely on express-session.
 * This store manages OAuth2 state parameters in memory with automatic cleanup.
 */
export class OidcStateStore {
  private readonly STATE_EXPIRY_MS = ms('10 minutes');

  private stateMap = new Map<
    string,
    {
      appState?: unknown;
      ctx: { issued?: Date; maxAge?: number; nonce?: string };
      meta?: unknown;
      timestamp: number;
    }
  >();

  /**
   * Store request state.
   * Signature matches passport-openidconnect SessionStore
   */
  public store(
    _req: unknown,
    _meta: unknown,
    appState: unknown,
    ctx: { maxAge?: number; nonce?: string; issued?: Date },
    callback: (err: Error | null, handle?: string) => void
  ) {
    try {
      // Generate a unique handle for this state
      const handle = this.generateHandle();

      this.stateMap.set(handle, {
        appState,
        ctx,
        meta: _meta,
        timestamp: Date.now()
      });

      // Clean up expired states
      this.cleanup();

      callback(null, handle);
    } catch (error) {
      callback(error as Error);
    }
  }

  /**
   * Verify request state.
   * Signature matches passport-openidconnect SessionStore
   */
  public verify(
    _req: unknown,
    handle: string,
    callback: (
      err: Error | null,
      appState?: unknown,
      ctx?: { maxAge?: number; nonce?: string; issued?: Date }
    ) => void
  ) {
    try {
      const data = this.stateMap.get(handle);

      if (!data) {
        return callback(null, undefined, undefined);
      }

      if (Date.now() - data.timestamp > this.STATE_EXPIRY_MS) {
        // State has expired
        this.stateMap.delete(handle);
        return callback(null, undefined, undefined);
      }

      // Remove state after verification (one-time use)
      this.stateMap.delete(handle);

      callback(null, data.ctx, data.appState);
    } catch (error) {
      callback(error as Error);
    }
  }

  /**
   * Clean up expired states
   */
  private cleanup() {
    const now = Date.now();
    const expiredKeys: string[] = [];

    for (const [key, value] of this.stateMap.entries()) {
      if (now - value.timestamp > this.STATE_EXPIRY_MS) {
        expiredKeys.push(key);
      }
    }

    for (const key of expiredKeys) {
      this.stateMap.delete(key);
    }
  }

  /**
   * Generate a cryptographically secure random handle.
   *
   * The handle is the OAuth2 `state` parameter: it travels to the identity
   * provider and back through the browser, and verifying it on return is what
   * distinguishes a callback belonging to a flow this server started from one an
   * attacker composed. Its unpredictability is therefore the whole of its value.
   *
   * `Math.random()` cannot supply that, whatever the comment above it says. It is
   * not a cryptographic generator, and V8 seeds and advances an xorshift128+ state
   * from which observing a small number of outputs is enough to recover the state
   * and compute the rest - so a handle built from two of its outputs plus a
   * timestamp is guessable, and a guessable `state` is no `state` at all.
   *
   * 32 bytes from the platform's CSPRNG, rendered base64url so the value is safe
   * in a URL without escaping.
   */
  private generateHandle() {
    return randomBytes(32).toString('base64url');
  }
}
