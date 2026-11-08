export interface ServerConfig {
  gitlabUrl: string; // e.g. https://gitlab.company.com
  clientId: string; // GitLab OAuth application id
  clientSecret: string;
  publicUrl: string; // where this service is reached, e.g. https://map.company.com
  port: number;
  cacheDir: string; // where project git copies are kept
  dataDir: string; // "viewed" marks (and the repo cache by default)
  analysisWorkers: number; // analyses that may run at the same time
  indexJob: string; // CI job that builds the exact index
  indexArtifact: string; // the index file that job saves
}

/** Read settings from environment variables; throws with a clear list of what is missing. */
export function configFromEnv(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const missing = ["GITLAB_URL", "GITLAB_CLIENT_ID", "GITLAB_CLIENT_SECRET", "PUBLIC_URL"].filter((k) => !env[k]);
  if (missing.length) throw new Error(`Missing environment variables: ${missing.join(", ")}`);
  return {
    gitlabUrl: env.GITLAB_URL!.replace(/\/$/, ""),
    clientId: env.GITLAB_CLIENT_ID!,
    clientSecret: env.GITLAB_CLIENT_SECRET!,
    publicUrl: env.PUBLIC_URL!.replace(/\/$/, ""),
    port: Number(env.PORT ?? 8080),
    dataDir: env.DATA_DIR ?? "/data",
    cacheDir: env.CACHE_DIR ?? `${env.DATA_DIR ?? "/data"}/repos`,
    analysisWorkers: Math.max(1, Number(env.ANALYSIS_WORKERS ?? 2) || 2),
    indexJob: env.INDEX_JOB ?? "diffmap-index",
    indexArtifact: env.INDEX_ARTIFACT ?? "index.scip",
  };
}
