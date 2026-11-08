import { createHash, randomBytes } from "node:crypto";

type Fetch = typeof fetch;

export interface OAuthTokens {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number; // ms since epoch
}

export interface OAuthSettings {
  gitlabUrl: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

/** A PKCE verifier and its challenge. */
export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

/** "Sign in with GitLab" using the authorization-code flow with PKCE. */
export class GitLabOAuth {
  constructor(
    private readonly s: OAuthSettings,
    private readonly fetchImpl: Fetch = fetch,
  ) {}

  private get base(): string {
    return this.s.gitlabUrl.replace(/\/$/, "");
  }

  authorizeUrl(state: string, challenge: string): string {
    const q = new URLSearchParams({
      client_id: this.s.clientId,
      redirect_uri: this.s.redirectUri,
      response_type: "code",
      scope: "api", // read the MR, fetch its code, comment and approve
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
    });
    return `${this.base}/oauth/authorize?${q}`;
  }

  exchange(code: string, verifier: string): Promise<OAuthTokens> {
    return this.token({
      grant_type: "authorization_code",
      code,
      redirect_uri: this.s.redirectUri,
      code_verifier: verifier,
    });
  }

  refresh(refreshToken: string): Promise<OAuthTokens> {
    return this.token({ grant_type: "refresh_token", refresh_token: refreshToken, redirect_uri: this.s.redirectUri });
  }

  private async token(params: Record<string, string>): Promise<OAuthTokens> {
    const res = await this.fetchImpl(`${this.base}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({ client_id: this.s.clientId, client_secret: this.s.clientSecret, ...params }),
    });
    if (!res.ok) throw new Error(`GitLab sign-in failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
    const t = (await res.json()) as { access_token: string; refresh_token?: string; expires_in?: number };
    return {
      accessToken: t.access_token,
      refreshToken: t.refresh_token ?? null,
      expiresAt: Date.now() + (t.expires_in ?? 7200) * 1000,
    };
  }
}
