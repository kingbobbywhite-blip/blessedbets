/**
 * Reading what this app's own server routes send back.
 *
 * The routes always answer in JSON, so the pages read every response as JSON
 * -- and a response that is not JSON threw a parser error straight onto the
 * screen: "Unexpected token '<', "<!DOCTYPE "... is not valid JSON". That
 * sentence is what an expired sign-in looks like on a protected deployment,
 * where the host answers with its login page before the route ever runs, and
 * what a request the host cut off for time looks like. Neither is the feed and
 * neither is a key, and nothing in the sentence says so.
 */

export class ApiResponseError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
    this.name = "ApiResponseError"
  }
}

/** What a response that is not JSON most likely is, in words. */
export function describeNonJson(status: number, text: string): string {
  const body = text.slice(0, 2000)
  if (status === 401 || status === 403 || /vercel authentication|authentication required|sso-api|log in to vercel/i.test(body)) {
    return `This site asked for a sign-in instead of answering (HTTP ${status}). The login that protects this deployment has expired in this browser: reload the page, sign in again, and retry. Nothing is wrong with the feed or its key.`
  }
  if (status === 504 || status === 408 || /FUNCTION_INVOCATION_TIMEOUT|timed out/i.test(body)) {
    return `The server ran out of time before the feed finished answering (HTTP ${status}). Try again; if it keeps happening, lower Games per pull in Settings.`
  }
  if (status >= 500) {
    return `The app's server failed before it could answer (HTTP ${status}). Try again in a minute; if it keeps happening, reload the page.`
  }
  return `The app's server sent back something that was not data (HTTP ${status}). Reload the page and try again.`
}

/**
 * The JSON body of a response from one of this app's routes.
 *
 * Throws an ApiResponseError that says what happened when the body is not
 * JSON. A JSON body is returned whatever the status: the routes report their
 * own failures as JSON with an `error` field, and callers read that.
 */
export async function readApiJson<T = Record<string, unknown>>(res: Response): Promise<T> {
  const text = await res.text()
  try {
    return JSON.parse(text) as T
  } catch {
    throw new ApiResponseError(describeNonJson(res.status, text), res.status)
  }
}
