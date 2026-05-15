/**
 * API Key Authenticator — validates x-api-key header for HTTP transport.
 *
 * Used in Streamable HTTP mode where the server is exposed over the network.
 * The expected API key is loaded from config.json (server.apiKey) or the
 * MOODLE_API_KEY environment variable.
 */

import { Authenticator, AuthResult } from "./authenticator.js";

export class ApiKeyAuthenticator implements Authenticator {
  private expectedKey: string;

  constructor(apiKey: string) {
    if (!apiKey || apiKey.length < 16) {
      throw new Error(
        "API key too short (< 16 chars). Generate a strong key and set MOODLE_API_KEY in .env."
      );
    }
    this.expectedKey = apiKey;
  }

  async authenticate(request: unknown): Promise<AuthResult> {
    // Extract x-api-key from request headers
    // The MCP SDK passes the raw HTTP request as context
    const req = request as Record<string, unknown> | undefined;
    const headers = (req?.headers ?? req?.["headers"]) as Record<string, string> | undefined;

    if (!headers) {
      throw new Error("No request headers — authentication required for HTTP transport.");
    }

    const providedKey = headers["x-api-key"] ?? headers["X-Api-Key"];

    if (!providedKey) {
      throw new Error("Missing x-api-key header. Include your API key in the request.");
    }

    // Constant-time comparison (basic — adequate for this use case)
    if (!timingSafeEqual(providedKey, this.expectedKey)) {
      throw new Error("Invalid API key.");
    }

    return { authenticated: true, identity: "api-key" };
  }
}

/**
 * Constant-time string comparison.
 * Prevents timing attacks on the API key comparison.
 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}
