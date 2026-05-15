/**
 * Internal Moodle Web Services API client.
 *
 * All Moodle API calls MUST go through this class. Tool handlers
 * must never call fetch() against Moodle directly — that keeps
 * auth, error handling, and retry logic centralized.
 */
export interface MoodleAPICall {
  /** Web service function name, e.g. "core_course_get_courses" */
  wsfunction: string;
  /** Query params to append to the request (courseid, userid, etc.) */
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

  /**
   * Execute a Moodle Web Services API call.
   * Returns the parsed response body (already unwrapped from Moodle's envelope).
   */
  async call<T = unknown>(call: MoodleAPICall): Promise<T> {
    const url = this.buildUrl(call);

    const res = await fetch(url, { method: "POST" });

    if (!res.ok) {
      throw new MoodleAPIError(
        `HTTP ${res.status} on ${call.wsfunction}: ${res.statusText}`,
        res.status
      );
    }

    let body: unknown;
    try {
      body = await res.json();
    } catch (e) {
      throw new MoodleAPIError(
        `Invalid JSON response from ${call.wsfunction}`
      );
    }

    // Moodle returns errors in the body even on HTTP 200
    if (isMoodleError(body)) {
      throw new MoodleAPIError(
        `Moodle error on ${call.wsfunction}: ${(body as MoodleError).message ?? "unknown"}`,
        undefined,
        body as MoodleError
      );
    }

    // Unwrap from Moodle's envelope if a response key is specified
    if (call.responseKey && typeof body === "object" && body !== null) {
      const wrapped = body as Record<string, unknown>;
      if (call.responseKey in wrapped) {
        return wrapped[call.responseKey] as T;
      }
    }

    return body as T;
  }

  private buildUrl(call: MoodleAPICall): string {
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

    return `${this.baseUrl}/webservice/rest/server.php?${params.toString()}`;
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
