import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import {
  HostError,
  type LinePosition,
  type MergeRequestHostPort,
  type ReviewProgressPort,
} from "../../application/ports/merge-request.port.js";
import type { ReviewMergeRequestUseCase } from "../../application/use-cases/review-merge-request.js";
import type { SyntaxHighlighterPort } from "../../application/ports/syntax-highlighter.port.js";
import { pkcePair, type OAuthTokens } from "../../infrastructure/gitlab/gitlab-oauth.js";
import { renderHtml } from "../html/render-html.js";
import type { ServerConfig } from "./config.js";
import { errorPage, homePage, loadingPage, signInPage } from "./pages.js";
import { SessionStore, type Session } from "./sessions.js";
import type { HostProfile } from "./host-profile.js";
import { redactSecrets, sensitiveValues } from "./safe-log.js";

export interface OAuthPort {
  authorizeUrl(state: string, challenge: string): string;
  exchange(code: string, verifier: string): Promise<OAuthTokens>;
  refresh(refreshToken: string): Promise<OAuthTokens>;
}

export interface AppDeps {
  config: ServerConfig;
  /** Sign-in through the host's OAuth application; absent in view mode (personal tokens instead). */
  oauth?: OAuthPort;
  /** A code-host client acting with the given (refreshing) token. */
  hostFor: (token: () => Promise<string>) => MergeRequestHostPort;
  review: ReviewMergeRequestUseCase;
  /** Where each user's "viewed" marks are kept. */
  viewed: ReviewProgressPort;
  highlighters?: SyntaxHighlighterPort[];
  sessions?: SessionStore;
  log?: (msg: string) => void;
}

const COOKIE = "diffmap_session";
const MR_API = /^\/api\/(.+?)\/-\/merge_requests\/(\d+)\/(discussions|approve|unapprove|viewed|status|discussions\/([^/]+)\/notes)$/;
const MAX_BODY = 64 * 1024;

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

const decodePath = (p: string): string => p.split("/").map(decodeURIComponent).join("/");
const encodePath = (p: string): string => p.split("/").map(encodeURIComponent).join("/");

/** Only same-site paths may be used as a place to return to after sign-in. */
const safeReturn = (p: string | null): string => (p && p.startsWith("/") && !p.startsWith("//") ? p : "/");

/** Find the project and number of a review in a pasted link or path (e.g. ".../-/merge_requests/42", ".../pull/42"). */
export function parseReviewLink(input: string, host: HostProfile): { projectPath: string; number: number } | null {
  let path = input.trim();
  try {
    path = new URL(path).pathname;
  } catch {
    /* not a full URL: treat it as a path */
  }
  return host.parsePath(path.replace(/^\/?/, "/"));
}

function cookies(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

/** A small HTML form body (application/x-www-form-urlencoded). */
async function readForm(req: IncomingMessage): Promise<URLSearchParams> {
  if (!(req.headers["content-type"] ?? "").startsWith("application/x-www-form-urlencoded")) {
    throw new HttpError(415, "Expected a form.");
  }
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 8 * 1024) throw new HttpError(413, "Too long.");
    chunks.push(c as Buffer);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}

/** Scopes a personal access token needs in view mode (either the read pair, or the broad api scope). */
function missingScopes(scopes: string[]): string[] {
  if (scopes.includes("api")) return [];
  return ["read_api", "read_repository"].filter((s) => !scopes.includes(s));
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (!(req.headers["content-type"] ?? "").startsWith("application/json")) {
    throw new HttpError(415, "Expected a JSON body.");
  }
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(413, "Comment is too long.");
    chunks.push(c as Buffer);
  }
  try {
    const v = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    if (typeof v !== "object" || v === null || Array.isArray(v)) throw new Error();
    return v as Record<string, unknown>;
  } catch {
    throw new HttpError(400, "Body is not valid JSON.");
  }
}

function readPosition(v: unknown): LinePosition | undefined {
  if (v === undefined || v === null) return undefined;
  const p = v as Record<string, unknown>;
  const line = (x: unknown) => (x === null || x === undefined ? null : Number.isInteger(x) && (x as number) > 0 ? (x as number) : NaN);
  const oldLine = line(p.oldLine);
  const newLine = line(p.newLine);
  if (typeof p.path !== "string" || !p.path || Number.isNaN(oldLine) || Number.isNaN(newLine) || (oldLine === null && newLine === null)) {
    throw new HttpError(400, "Invalid line position.");
  }
  return { path: p.path, oldLine, newLine };
}

/** The diffmap web service: sign-in with the code host, review maps, comments and approvals. */
export function createApp(deps: AppDeps): Server {
  const { config } = deps;
  const host = config.host;
  const sessions = deps.sessions ?? new SessionStore();
  // Every log line goes through redactSecrets: no query string or sign-in code is ever written.
  const write = deps.log ?? ((m: string) => console.log(m));
  const log = (m: string, values: string[] = []) => write(redactSecrets(m, values));
  const secure = config.publicUrl.startsWith("https://");
  const refreshing = new WeakMap<Session, Promise<void>>();

  /** The session's access token, refreshed shortly before it expires. */
  const tokenFor = (s: Session) => async (): Promise<string> => {
    if (deps.oauth && s.tokens.refreshToken && s.tokens.expiresAt - Date.now() < 60_000) {
      let p = refreshing.get(s);
      if (!p) {
        p = deps.oauth.refresh(s.tokens.refreshToken).then((t) => {
          s.tokens = t;
        });
        refreshing.set(s, p);
        p.finally(() => refreshing.delete(s)).catch(() => {});
      }
      await p;
    }
    return s.tokens.accessToken;
  };

  const send = (res: ServerResponse, status: number, body: string, type = "text/html; charset=utf-8", extra: Record<string, string | string[]> = {}) => {
    res.writeHead(status, {
      "Content-Type": type,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "same-origin",
      "Content-Security-Policy":
        "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline' https://fonts.googleapis.com; " +
        "font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; form-action 'self'; frame-ancestors 'none'",
      ...extra,
    });
    res.end(body);
  };
  const json = (res: ServerResponse, status: number, data: unknown) => send(res, status, JSON.stringify(data), "application/json");
  const redirect = (res: ServerResponse, to: string, extra: Record<string, string | string[]> = {}) => {
    res.writeHead(302, { Location: to, "Cache-Control": "no-store", ...extra });
    res.end();
  };
  const cookie = (value: string, maxAge: number) =>
    `${COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", config.publicUrl);
    const path = url.pathname;
    const method = req.method ?? "GET";
    const session = sessions.get(cookies(req)[COOKIE]);
    const loginUrl = (returnTo: string) => `/auth/login?returnTo=${encodeURIComponent(returnTo)}`;

    if (method === "GET" && path === "/healthz") return send(res, 200, "ok", "text/plain");

    const viewOnly = config.mode === "view" || !deps.oauth;

    // ── view mode: sign in with your own personal access token ──
    if (viewOnly && method === "GET" && (path === "/auth/login" || path === "/auth/callback")) {
      return send(res, 200, signInPage(host, safeReturn(url.searchParams.get("returnTo")), "view"));
    }
    if (viewOnly && method === "POST" && path === "/auth/token") {
      const origin = req.headers.origin;
      if (origin && origin !== new URL(config.publicUrl).origin) throw new HttpError(403, "Request from another site refused.");
      const form = await readForm(req);
      const returnTo = safeReturn(form.get("returnTo"));
      const token = (form.get("token") ?? "").trim();
      const retry = (msg: string) => send(res, 400, signInPage(host, returnTo, "view", msg));
      if (!/^[\w.-]{10,200}$/.test(token)) return retry(`That doesn't look like a ${host.name} access token.`);
      const client = deps.hostFor(async () => token);
      let user;
      try {
        user = await client.currentUser();
      } catch (err) {
        if (err instanceof HostError && (err.status === 401 || err.status === 403)) {
          return retry(`${host.name} did not accept this token. Check that it is not expired or revoked.`);
        }
        throw err;
      }
      const scopes = await client.tokenScopes?.();
      const missing = scopes ? missingScopes(scopes) : [];
      if (missing.length) return retry(`This token is missing the scope${missing.length > 1 ? "s" : ""} ${missing.join(" and ")}.`);
      // Kept in memory only, like OAuth tokens; never refreshed (it is the user's own token).
      const s = sessions.create(user, { accessToken: token, refreshToken: null, expiresAt: Number.MAX_SAFE_INTEGER });
      log(`sign-in (view mode): @${user.username}`);
      return redirect(res, returnTo, { "Set-Cookie": cookie(s.id, 7 * 24 * 3600) });
    }

    // ── sign-in through the host's OAuth application ──
    if (method === "GET" && path === "/auth/login" && deps.oauth) {
      const { verifier, challenge } = pkcePair();
      const state = sessions.startLogin(verifier, safeReturn(url.searchParams.get("returnTo")));
      return redirect(res, deps.oauth.authorizeUrl(state, challenge));
    }
    if (method === "GET" && path === "/auth/callback" && deps.oauth) {
      if (url.searchParams.get("error")) {
        return send(res, 403, errorPage("Sign-in cancelled", url.searchParams.get("error_description") ?? `${host.name} did not sign you in.`));
      }
      const pending = sessions.finishLogin(url.searchParams.get("state") ?? "");
      const code = url.searchParams.get("code");
      if (!pending || !code) return send(res, 400, errorPage("Sign-in expired", "Please try signing in again."));
      const tokens = await deps.oauth.exchange(code, pending.verifier);
      const user = await deps.hostFor(async () => tokens.accessToken).currentUser();
      const s = sessions.create(user, tokens);
      log(`sign-in: @${user.username}`);
      return redirect(res, pending.returnTo, { "Set-Cookie": cookie(s.id, 7 * 24 * 3600) });
    }
    if (method === "POST" && path === "/auth/logout") {
      sessions.delete(session?.id);
      return redirect(res, "/", { "Set-Cookie": cookie("", 0) });
    }

    // ── pages ──
    if (method === "GET" && path === "/") {
      return send(res, 200, session ? homePage(session.user, host) : signInPage(host, "/", viewOnly ? "view" : "full"));
    }
    if (method === "GET" && path === "/go") {
      if (!session) return redirect(res, loginUrl(path + url.search));
      const link = parseReviewLink(url.searchParams.get("url") ?? "", host);
      if (!link) return send(res, 400, homePage(session.user, host, `That doesn't look like a ${host.reviewName} link.`));
      return redirect(res, host.pathFor(link.projectPath, link.number));
    }

    const api = path.match(MR_API);
    if (api && method === "GET" && api[3] === "status") {
      if (!session) return json(res, 401, { error: "Not signed in." });
      const token = tokenFor(session);
      return json(res, 200, await deps.review.progress(deps.hostFor(token), await token(), decodePath(api[1]), Number(api[2])));
    }
    if (api && method === "POST" && api[3] !== "status") {
      if (!session) return json(res, 401, { error: "Not signed in." });
      const projectPath = decodePath(api[1]);
      const iid = Number(api[2]);
      const host = deps.hostFor(tokenFor(session));
      const body = await readJson(req);
      if (api[3] === "viewed") {
        if (typeof body.symbolId !== "string" || !body.symbolId || typeof body.viewed !== "boolean") {
          throw new HttpError(400, "Expected { symbolId, viewed }.");
        }
        const mr = await host.getMergeRequest(projectPath, iid); // checks access, gives the canonical path
        const viewed = await deps.viewed.setViewed(session.user.username, mr.projectPath, iid, body.symbolId, body.viewed);
        return json(res, 200, { viewed });
      }
      if (viewOnly) throw new HttpError(403, "View-only mode: comments and approvals are turned off.");
      if (api[3] === "approve" || api[3] === "unapprove") {
        return json(res, 200, await deps.review.setApproval(host, projectPath, iid, api[3] === "approve"));
      }
      const text = typeof body.body === "string" ? body.body.trim() : "";
      if (!text) throw new HttpError(400, "The comment is empty.");
      if (api[4]) {
        return json(res, 201, await host.reply(projectPath, iid, decodeURIComponent(api[4]), text));
      }
      const position = readPosition(body.position);
      const code = typeof body.code === "string" ? body.code.slice(0, 2000) : undefined;
      // Lines from files outside the diff can never carry a diff comment on the host.
      const general = body.outside === true;
      return json(res, 201, await deps.review.comment(host, projectPath, iid, { body: text, position, code, general }));
    }

    const page = method === "GET" && !path.startsWith("/api/") ? host.parsePath(path) : null;
    if (page) {
      if (!session) return redirect(res, loginUrl(path));
      const projectPath = page.projectPath;
      const iid = page.number;
      const token = tokenFor(session);
      const review = await deps.review.open(deps.hostFor(token), await token(), projectPath, iid);
      const apiBase = `/api/${encodePath(review.mr.projectPath)}/-/merge_requests/${iid}`;
      if (!review.ready) {
        // Show the download/analysis progress; the page reloads itself when ready.
        return send(res, 200, loadingPage(`${host.refPrefix}${iid} · ${review.mr.title}`, `${apiBase}/status`, review.status));
      }
      log(`map: ${review.mr.projectPath}!${iid} for @${session.user.username}`);
      const html = renderHtml(review.result, deps.highlighters ?? [], {
        mr: {
          readOnly: viewOnly,
          hostName: host.name,
          refPrefix: host.refPrefix,
          mr: review.mr,
          discussions: review.discussions,
          approvals: review.approvals,
          user: session.user,
          apiBase,
          indexState: review.indexState,
          viewed: await deps.viewed.getViewed(session.user.username, review.mr.projectPath, iid),
        },
      });
      return send(res, 200, html);
    }

    return send(res, 404, errorPage("Page not found", "Open a merge request link, or go to the start page."));
  }

  return createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      const isApi = (req.url ?? "").startsWith("/api/");
      let status = 500;
      let message = "Something went wrong. Check the service logs.";
      if (err instanceof HttpError) {
        status = err.status;
        message = err.message;
      } else if (err instanceof HostError) {
        status = err.status === 401 ? 401 : err.status === 403 || err.status === 404 ? 404 : 502;
        message =
          status === 401
            ? `Your ${host.name} sign-in is no longer valid.`
            : status === 404
              ? `That ${host.reviewName} doesn't exist, or your ${host.name} account can't see it.`
              : `${host.name} returned an error.`;
      }
      if (status >= 500) {
        const path = (req.url ?? "/").split("?")[0];
        log(`error: ${req.method} ${path}: ${err instanceof Error ? err.stack ?? err.message : String(err)}`, sensitiveValues(req.url));
      }
      if (res.headersSent) return res.end();
      if (isApi) return json(res, status, { error: message });
      if (status === 401) return redirect(res, `/auth/login?returnTo=${encodeURIComponent(safeReturn(req.url ?? "/"))}`);
      send(res, status, errorPage(status === 404 ? "Not found" : "Could not open the map", message));
    });
  });
}
