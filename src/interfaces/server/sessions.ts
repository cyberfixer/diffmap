import { randomBytes } from "node:crypto";
import type { Person } from "../../application/ports/merge-request.port.js";
import type { OAuthTokens } from "../../infrastructure/gitlab/gitlab-oauth.js";

export interface Session {
  id: string;
  user: Person;
  tokens: OAuthTokens;
  lastSeen: number;
}

interface PendingLogin {
  verifier: string;
  returnTo: string;
  at: number;
}

const IDLE_MS = 7 * 24 * 3600 * 1000; // forget sessions unused for a week
const PENDING_MS = 10 * 60 * 1000; // a sign-in must finish within 10 minutes

/**
 * Signed-in users, kept in memory on purpose: restarting the service signs
 * everyone out, and GitLab tokens are never written to disk.
 */
export class SessionStore {
  private sessions = new Map<string, Session>();
  private pending = new Map<string, PendingLogin>();

  create(user: Person, tokens: OAuthTokens): Session {
    const s: Session = { id: randomBytes(32).toString("base64url"), user, tokens, lastSeen: Date.now() };
    this.sessions.set(s.id, s);
    return s;
  }

  get(id: string | undefined): Session | null {
    if (!id) return null;
    const s = this.sessions.get(id);
    if (!s) return null;
    if (Date.now() - s.lastSeen > IDLE_MS) {
      this.sessions.delete(id);
      return null;
    }
    s.lastSeen = Date.now();
    return s;
  }

  delete(id: string | undefined): void {
    if (id) this.sessions.delete(id);
  }

  startLogin(verifier: string, returnTo: string): string {
    const state = randomBytes(24).toString("base64url");
    this.pending.set(state, { verifier, returnTo, at: Date.now() });
    return state;
  }

  finishLogin(state: string): PendingLogin | null {
    const p = this.pending.get(state);
    this.pending.delete(state);
    return p && Date.now() - p.at < PENDING_MS ? p : null;
  }

  /** Drop expired entries; call now and then. */
  sweep(): void {
    const now = Date.now();
    for (const [k, s] of this.sessions) if (now - s.lastSeen > IDLE_MS) this.sessions.delete(k);
    for (const [k, p] of this.pending) if (now - p.at > PENDING_MS) this.pending.delete(k);
  }
}
