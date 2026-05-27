/**
 * Auth layer — defines the interface. Even though stdio mode
 * doesn't authenticate external callers, we define the abstraction
 * now so future host wrappers or agents can attach identity and
 * policy checks without restructuring tool handlers.
 *
 * Every MCP request passes through `authenticate()` before reaching
 * a tool handler. In stdio mode, it's a no-op.
 */

/**
 * Result of a successful authentication check.
 * Tools can use `identity` for audit logging.
 */
export interface AuthResult {
  authenticated: boolean;
  identity?: string;
}

/**
 * Authenticator interface — implement per transport mode.
 */
export interface Authenticator {
  /**
   * Authenticate an incoming request.
   * Throws on authentication failure; returns AuthResult on success.
   */
  authenticate(request: unknown): Promise<AuthResult>;
}
