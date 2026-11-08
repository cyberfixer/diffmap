/** Query parameters whose values must never reach a log. */
const SECRET_PARAMS = /\b(code|state|token|access_token|refresh_token|id_token|client_secret|password|private_token)=([^&\s"'#]*)/gi;

/**
 * Make a log line safe:
 * - every query string in a URL or path is dropped (`/auth/callback?code=x` -> `/auth/callback?[hidden]`),
 * - any `code=`, `state=`, `token=`... value left anywhere else is hidden,
 * - and the given values (e.g. this request's sign-in code and state) are hidden
 *   wherever they appear, even without a `name=` in front.
 */
export function redactSecrets(text: string, values: (string | null | undefined)[] = []): string {
  let out = text;
  for (const v of values) {
    if (v && v.length >= 4) out = out.split(v).join("[hidden]");
  }
  return out
    .replace(/((?:https?:\/\/[^\s?#"']*)|(?:\/[^\s?#"']*))\?[^\s#"']*?(?=[\s#"']|:\s|:$|$)/g, "$1?[hidden]")
    .replace(SECRET_PARAMS, "$1=[hidden]");
}

/** The sensitive values in a request URL: the OAuth code and state, and any token. */
export function sensitiveValues(url: string | undefined): string[] {
  const q = new URL(url ?? "/", "http://x").searchParams;
  return ["code", "state", "token", "access_token", "refresh_token"].map((k) => q.get(k)).filter((v): v is string => !!v);
}
