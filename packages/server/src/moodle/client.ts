/**
 * Internal Moodle Web Services API client.
 *
 * All Moodle API calls MUST go through this class. Tool handlers
 * must never call fetch() against Moodle directly — that keeps
 * auth, error handling, and retry logic centralized.
 *
 * Security: the Moodle token is sent in a form-encoded POST body,
 * never in the URL query string, so it cannot leak into server,
 * proxy, or analytics access logs.
 */
export interface MoodleAPICall {
  /** Web service function name, e.g. "core_course_get_courses" */
  wsfunction: string;
  /** Request parameters (courseid, userid, etc.) */
  params?: Record<string, string | number>;
  /** Expected response key in the JSON body (Moodle wraps responses) */
  responseKey?: string;
}

export interface MoodleError {
  exception?: string;
  errorcode?: string;
  message?: string;
  debuginfo?: string;
}

export class MoodleClient {
  private baseUrl: string;
  private token: string;

  constructor(baseUrl: string, token: string) {
    // Strip trailing slash for clean URL building
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.token = token;
  }

  getBaseUrl(): string {
    return this.baseUrl;
  }

  /**
   * Execute a Moodle Web Services API call.
   * Returns the parsed response body (already unwrapped from Moodle's envelope).
   */
  async call<T = unknown>(call: MoodleAPICall): Promise<T> {
    // Token travels in the POST body, never in the URL.
    const body = this.buildBody(call);
    const url = `${this.baseUrl}/webservice/rest/server.php`;

    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
      // The server is already resolved from baseUrl; this request is
      // same-origin by construction and does not follow cross-origin
      // redirects that could forward the token elsewhere.
      redirect: "error",
    });

    if (!res.ok) {
      throw new MoodleAPIError(
        `HTTP ${res.status} on ${call.wsfunction}: ${res.statusText}`,
        res.status
      );
    }

    let bodyJson: unknown;
    try {
      bodyJson = await res.json();
    } catch (e) {
      throw new MoodleAPIError(
        `Invalid JSON response from ${call.wsfunction}`
      );
    }

    // Moodle returns errors in the body even on HTTP 200
    if (isMoodleError(bodyJson)) {
      throw new MoodleAPIError(
        `Moodle error on ${call.wsfunction}: ${(bodyJson as MoodleError).message ?? "unknown"}`,
        undefined,
        bodyJson as MoodleError
      );
    }

    // Unwrap from Moodle's envelope if a response key is specified
    if (call.responseKey && typeof bodyJson === "object" && bodyJson !== null) {
      const wrapped = bodyJson as Record<string, unknown>;
      if (call.responseKey in wrapped) {
        return wrapped[call.responseKey] as T;
      }
    }

    return bodyJson as T;
  }

  /**
   * Build the form-encoded POST body. The token is a body field, so it
   * never appears in any URL, log line, or error message.
   */
  private buildBody(call: MoodleAPICall): string {
    const params = new URLSearchParams({
      wstoken: this.token,
      wsfunction: call.wsfunction,
      moodlewsrestformat: "json",
    });

    if (call.params) {
      for (const [key, val] of Object.entries(call.params)) {
        params.set(key, String(val));
      }
    }

    return params.toString();
  }
}

export class MoodleAPIError extends Error {
  public readonly httpStatus?: number;
  public readonly moodleError?: MoodleError;

  constructor(
    message: string,
    httpStatus?: number,
    moodleError?: MoodleError
  ) {
    super(message);
    this.name = "MoodleAPIError";
    this.httpStatus = httpStatus;
    this.moodleError = moodleError;
  }
}

function isMoodleError(body: unknown): boolean {
  return (
    typeof body === "object" &&
    body !== null &&
    ("exception" in body || "errorcode" in body)
  );
}
