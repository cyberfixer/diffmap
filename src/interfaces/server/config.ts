export interface ServerConfig {
  gitlabUrl: string; // e.g. https://gitlab.company.com
  clientId: string; // GitLab OAuth application id
  clientSecret: string;
  publicUrl: string; // where this service is reached, e.g. https://map.company.com
  port: number;
  cacheDir: string; // where project git copies are kept
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
    cacheDir: env.CACHE_DIR ?? "/data/repos",
  };
}
