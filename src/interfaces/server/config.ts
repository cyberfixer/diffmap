import { githubProfile, gitlabProfile, type HostProfile } from "./host-profile.js";

export interface ServerConfig {
  codeHost: "gitlab" | "github";
  hostUrl: string; // web address of the code host, e.g. https://gitlab.company.com or https://github.com
  host: HostProfile; // names, URL shapes and wording of that host
  /**
   * "full": sign in through an OAuth application of the host; comment and approve.
   * "view": no application needed; each person signs in with their own
   * personal access token and can only look (no comments, no approvals).
   */
  mode: "full" | "view";
  clientId: string; // OAuth application id ("" in view mode)
  clientSecret: string; // "" in view mode
  publicUrl: string; // where this service is reached, e.g. https://map.company.com
  port: number;
  cacheDir: string; // where project git copies are kept
  cacheMaxBytes: number; // above this, least recently used projects are removed
  dataDir: string; // "viewed" marks (and the repo cache by default)
  analysisWorkers: number; // analyses that may run at the same time
  indexJob: string; // CI job (GitLab) or artifact (GitHub Actions) with the exact index
  indexArtifact: string; // the index file inside it
}

/**
 * Read settings from environment variables; throws with a clear list of what is missing.
 * CODE_HOST picks the host (gitlab, the default, or github); its settings use
 * that prefix: GITLAB_URL / GITLAB_CLIENT_ID / GITLAB_CLIENT_SECRET, or
 * GITHUB_URL (default https://github.com) / GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET.
 * Without a client ID and secret the service runs in view mode.
 */
export function configFromEnv(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const codeHost = (env.CODE_HOST ?? "gitlab").toLowerCase();
  if (codeHost !== "gitlab" && codeHost !== "github") throw new Error(`CODE_HOST must be gitlab or github, not "${env.CODE_HOST}".`);
  const P = codeHost === "gitlab" ? "GITLAB" : "GITHUB";

  const hostUrl = (env[`${P}_URL`] ?? (codeHost === "github" ? "https://github.com" : "")).replace(/\/$/, "");
  const missing = [...(hostUrl ? [] : [`${P}_URL`]), ...(env.PUBLIC_URL ? [] : ["PUBLIC_URL"])];
  if (missing.length) throw new Error(`Missing environment variables: ${missing.join(", ")}`);

  const id = env[`${P}_CLIENT_ID`] ?? "";
  const secret = env[`${P}_CLIENT_SECRET`] ?? "";
  if (!!id !== !!secret) {
    throw new Error(`Set both ${P}_CLIENT_ID and ${P}_CLIENT_SECRET (full mode), or neither (view-only mode).`);
  }
  return {
    codeHost,
    hostUrl,
    host: codeHost === "gitlab" ? gitlabProfile(hostUrl) : githubProfile(hostUrl),
    mode: id ? "full" : "view",
    clientId: id,
    clientSecret: secret,
    publicUrl: env.PUBLIC_URL!.replace(/\/$/, ""),
    port: Number(env.PORT ?? 8080),
    dataDir: env.DATA_DIR ?? "/data",
    cacheDir: env.CACHE_DIR ?? `${env.DATA_DIR ?? "/data"}/repos`,
    cacheMaxBytes: gigabytes(env.CACHE_MAX_GB, 15),
    analysisWorkers: Math.max(1, Number(env.ANALYSIS_WORKERS ?? 2) || 2),
    indexJob: env.INDEX_JOB ?? "diffmap-index",
    indexArtifact: env.INDEX_ARTIFACT ?? "index.scip",
  };
}

/** A size in GB from the environment ("0" or "off" means no limit). */
function gigabytes(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback * 1024 ** 3;
  if (/^(0|off|none)$/i.test(value.trim())) return Infinity;
  const n = Number(value);
  if (!(n > 0)) throw new Error(`CACHE_MAX_GB must be a number of GB (e.g. 15), or 0 for no limit; got "${value}".`);
  return n * 1024 ** 3;
}
