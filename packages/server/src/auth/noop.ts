import { Authenticator, AuthResult } from "./authenticator.js";

/**
 * NoopAuthenticator — passes all requests through unchecked.
 *
 * Used in stdio transport mode where the server runs as a subprocess
 * and authentication is handled by the host process boundary.
 */
export class NoopAuthenticator implements Authenticator {
  async authenticate(_request: unknown): Promise<AuthResult> {
    return { authenticated: true, identity: "stdio" };
  }
}
