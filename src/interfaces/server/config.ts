export interface ServerConfig {
  gitlabUrl: string; // e.g. https://gitlab.company.com
  /**
   * "full": sign in with a GitLab application (OAuth); comment and approve.
   * "view": no application needed; each person signs in with their own
   * personal access token and can only look (no comments, no approvals).
   */
  mode: "full" | "view";
  clientId: string; // GitLab OAuth application id ("" in view mode)
  clientSecret: string; // "" in view mode
  publicUrl: string; // where this service is reached, e.g. https://map.company.com
  port: number;
  cacheDir: string; // where project git copies are kept
  dataDir: string; // "viewed" marks (and the repo cache by default)
  analysisWorkers: number; // analyses that may run at the same time
  indexJob: string; // CI job that builds the exact index
  indexArtifact: string; // the index file that job saves
}

/**
 * Read settings from environment variables; throws with a clear list of what is missing.
 * Without GITLAB_CLIENT_ID and GITLAB_CLIENT_SECRET the service runs in view mode.
 */
export function configFromEnv(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const missing = ["GITLAB_URL", "PUBLIC_URL"].filter((k) => !env[k]);
  if (missing.length) throw new Error(`Missing environment variables: ${missing.join(", ")}`);
  const hasId = !!env.GITLAB_CLIENT_ID;
  const hasSecret = !!env.GITLAB_CLIENT_SECRET;
  if (hasId !== hasSecret) {
    throw new Error("Set both GITLAB_CLIENT_ID and GITLAB_CLIENT_SECRET (full mode), or neither (view-only mode).");
  }
  return {
    mode: hasId ? "full" : "view",
    gitlabUrl: env.GITLAB_URL!.replace(/\/$/, ""),
    clientId: env.GITLAB_CLIENT_ID ?? "",
    clientSecret: env.GITLAB_CLIENT_SECRET ?? "",
    publicUrl: env.PUBLIC_URL!.replace(/\/$/, ""),
    port: Number(env.PORT ?? 8080),
    dataDir: env.DATA_DIR ?? "/data",
    cacheDir: env.CACHE_DIR ?? `${env.DATA_DIR ?? "/data"}/repos`,
    analysisWorkers: Math.max(1, Number(env.ANALYSIS_WORKERS ?? 2) || 2),
    indexJob: env.INDEX_JOB ?? "diffmap-index",
    indexArtifact: env.INDEX_ARTIFACT ?? "index.scip",
  };
}
