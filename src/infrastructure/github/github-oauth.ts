import type { OAuthTokens } from "../gitlab/gitlab-oauth.js";

type Fetch = typeof fetch;

export interface GitHubOAuthSettings {
  githubUrl: string; // https://github.com or a GitHub Enterprise address
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

/** "Sign in with GitHub" through an OAuth App (authorization code, with PKCE). */
export class GitHubOAuth {
  constructor(
    private readonly s: GitHubOAuthSettings,
    private readonly fetchImpl: Fetch = fetch,
  ) {}

  private get base(): string {
    return this.s.githubUrl.replace(/\/$/, "");
  }

  authorizeUrl(state: string, challenge: string): string {
    const q = new URLSearchParams({
      client_id: this.s.clientId,
      redirect_uri: this.s.redirectUri,
      scope: "repo", // read private repositories, comment and review
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
      allow_signup: "false",
    });
    return `${this.base}/login/oauth/authorize?${q}`;
  }

  exchange(code: string, verifier: string): Promise<OAuthTokens> {
    return this.token({ code, redirect_uri: this.s.redirectUri, code_verifier: verifier });
  }

  /** Only for apps whose tokens expire; OAuth App tokens normally don't. */
  refresh(refreshToken: string): Promise<OAuthTokens> {
    return this.token({ grant_type: "refresh_token", refresh_token: refreshToken });
  }

  private async token(params: Record<string, string>): Promise<OAuthTokens> {
    const res = await this.fetchImpl(`${this.base}/login/oauth/access_token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({ client_id: this.s.clientId, client_secret: this.s.clientSecret, ...params }),
    });
    const t = (await res.json().catch(() => ({}))) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
      error?: string;
      error_description?: string;
    };
    // GitHub answers 200 with an "error" field when the code is bad.
    if (!res.ok || !t.access_token) throw new Error(`GitHub sign-in failed: ${t.error_description ?? t.error ?? res.status}`);
    return {
      accessToken: t.access_token,
      refreshToken: t.refresh_token ?? null,
      expiresAt: t.expires_in ? Date.now() + t.expires_in * 1000 : Number.MAX_SAFE_INTEGER,
    };
  }
}
