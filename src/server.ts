import { ReviewMergeRequestUseCase } from "./application/use-cases/review-merge-request.js";
import { GitLabClient } from "./infrastructure/gitlab/gitlab-client.js";
import { GitLabOAuth } from "./infrastructure/gitlab/gitlab-oauth.js";
import { GitRepoCache } from "./infrastructure/gitlab/git-repo-cache.js";
import { loadLanguageSupport } from "./infrastructure/language-support.js";
import { FileViewedStore } from "./infrastructure/storage/file-viewed-store.js";
import { WorkerAnalyzer } from "./infrastructure/worker/worker-analyzer.js";
import { configFromEnv } from "./interfaces/server/config.js";
import { createApp } from "./interfaces/server/server.js";
import { SessionStore } from "./interfaces/server/sessions.js";

/** Entry point of the gitmap web service (see README: "GitLab service"). */
let config;
try {
  config = configFromEnv();
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}

// Sign-ins are kept in memory: a restart signs everyone out.
const sessions = new SessionStore();
const analyzer = new WorkerAnalyzer(config.analysisWorkers);
setInterval(() => sessions.sweep(), 3600_000).unref();

const app = createApp({
  config,
  sessions,
  oauth: new GitLabOAuth({
    gitlabUrl: config.gitlabUrl,
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    redirectUri: `${config.publicUrl}/auth/callback`,
  }),
  hostFor: (token) => new GitLabClient(config.gitlabUrl, token, fetch, { name: config.indexJob, artifact: config.indexArtifact }),
  review: new ReviewMergeRequestUseCase(new GitRepoCache(config.cacheDir), (gitDir, base, head, index) =>
    analyzer.analyze(gitDir, base, head, index),
  ),
  viewed: new FileViewedStore(`${config.dataDir}/viewed.json`),
  highlighters: (await loadLanguageSupport()).highlighters,
});

app.listen(config.port, () => {
  console.log(`gitmap service on port ${config.port}, signing in with ${config.gitlabUrl}, public at ${config.publicUrl}`);
});
