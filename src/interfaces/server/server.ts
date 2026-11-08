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

export interface OAuthPort {
  authorizeUrl(state: string, challenge: string): string;
  exchange(code: string, verifier: string): Promise<OAuthTokens>;
  refresh(refreshToken: string): Promise<OAuthTokens>;
}

export interface AppDeps {
  config: ServerConfig;
  oauth: OAuthPort;
  /** A code-host client acting with the given (refreshing) token. */
  hostFor: (token: () => Promise<string>) => MergeRequestHostPort;
  review: ReviewMergeRequestUseCase;
  /** Where each user's "viewed" marks are kept. */
  viewed: ReviewProgressPort;
  highlighters?: SyntaxHighlighterPort[];
  sessions?: SessionStore;
  log?: (msg: string) => void;
}

const COOKIE = "gitmap_session";
const MR_PAGE = /^\/(.+?)\/-\/merge_requests\/(\d+)\/?$/;
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

/** Find "<project path>/-/merge_requests/<iid>" in a pasted link or path. */
export function parseMergeRequestLink(input: string): { projectPath: string; iid: number } | null {
  let path = input.trim();
  try {
    path = new URL(path).pathname;
  } catch {
    /* not a full URL: treat it as a path */
  }
  const m = path.replace(/^\/?/, "/").match(/^\/(.+?)\/-\/merge_requests\/(\d+)/);
  return m ? { projectPath: decodePath(m[1]), iid: Number(m[2]) } : null;
}

function cookies(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
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

/** The gitmap web service: GitLab sign-in, merge request maps, comments and approvals. */
export function createApp(deps: AppDeps): Server {
  const { config } = deps;
  const sessions = deps.sessions ?? new SessionStore();
  const log = deps.log ?? ((m: string) => console.log(m));
  const secure = config.publicUrl.startsWith("https://");
  const refreshing = new WeakMap<Session, Promise<void>>();

  /** The session's access token, refreshed shortly before it expires. */
  const tokenFor = (s: Session) => async (): Promise<string> => {
    if (s.tokens.refreshToken && s.tokens.expiresAt - Date.now() < 60_000) {
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

    // ── sign-in with GitLab ──
    if (method === "GET" && path === "/auth/login") {
      const { verifier, challenge } = pkcePair();
      const state = sessions.startLogin(verifier, safeReturn(url.searchParams.get("returnTo")));
      return redirect(res, deps.oauth.authorizeUrl(state, challenge));
    }
    if (method === "GET" && path === "/auth/callback") {
      if (url.searchParams.get("error")) {
        return send(res, 403, errorPage("Sign-in cancelled", url.searchParams.get("error_description") ?? "GitLab did not sign you in."));
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
      return send(res, 200, session ? homePage(session.user, config.gitlabUrl) : signInPage(config.gitlabUrl, "/"));
    }
    if (method === "GET" && path === "/go") {
      if (!session) return redirect(res, loginUrl(path + url.search));
      const link = parseMergeRequestLink(url.searchParams.get("url") ?? "");
      if (!link) return send(res, 400, homePage(session.user, config.gitlabUrl, "That doesn't look like a merge request link."));
      return redirect(res, `/${encodePath(link.projectPath)}/-/merge_requests/${link.iid}`);
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
      // Lines from files outside the diff can never carry a GitLab diff comment.
      const general = body.outside === true;
      return json(res, 201, await deps.review.comment(host, projectPath, iid, { body: text, position, code, general }));
    }

    const page = path.match(MR_PAGE);
    if (page && method === "GET") {
      if (!session) return redirect(res, loginUrl(path));
      const projectPath = decodePath(page[1]);
      const iid = Number(page[2]);
      const token = tokenFor(session);
      const review = await deps.review.open(deps.hostFor(token), await token(), projectPath, iid);
      const apiBase = `/api/${encodePath(review.mr.projectPath)}/-/merge_requests/${iid}`;
      if (!review.ready) {
        // Show the download/analysis progress; the page reloads itself when ready.
        return send(res, 200, loadingPage(`!${iid} · ${review.mr.title}`, `${apiBase}/status`, review.status));
      }
      log(`map: ${review.mr.projectPath}!${iid} for @${session.user.username}`);
      const html = renderHtml(review.result, deps.highlighters ?? [], {
        mr: {
          mr: review.mr,
          discussions: review.discussions,
          approvals: review.approvals,
          user: session.user,
          apiBase,
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
            ? "Your GitLab sign-in is no longer valid."
            : status === 404
              ? "That merge request doesn't exist, or your GitLab account can't see it."
              : "GitLab returned an error.";
      }
      if (status >= 500) log(`error: ${req.method} ${req.url}: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
      if (res.headersSent) return res.end();
      if (isApi) return json(res, status, { error: message });
      if (status === 401) return redirect(res, `/auth/login?returnTo=${encodeURIComponent(safeReturn(req.url ?? "/"))}`);
      send(res, status, errorPage(status === 404 ? "Not found" : "Could not open the map", message));
    });
  });
}
