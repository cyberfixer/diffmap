import { ReviewMergeRequestUseCase } from "./application/use-cases/review-merge-request.js";
import { GitLabClient } from "./infrastructure/gitlab/gitlab-client.js";
import { GitLabOAuth } from "./infrastructure/gitlab/gitlab-oauth.js";
import { GitHubClient } from "./infrastructure/github/github-client.js";
import { GitHubOAuth } from "./infrastructure/github/github-oauth.js";
import { GitRepoCache } from "./infrastructure/git/git-repo-cache.js";
import { loadLanguageSupport } from "./infrastructure/language-support.js";
import { FileViewedStore } from "./infrastructure/storage/file-viewed-store.js";
import { WorkerAnalyzer } from "./infrastructure/worker/worker-analyzer.js";
import { configFromEnv } from "./interfaces/server/config.js";
import { createApp } from "./interfaces/server/server.js";
import { SessionStore } from "./interfaces/server/sessions.js";

/** Entry point of the diffmap web service. One process serves one code host (CODE_HOST). */
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
  // Full mode: sign in through the host's OAuth application. View mode: none
  // (people sign in with their own read-only token; no comments or approvals).
  oauth:
    config.mode !== "full"
      ? undefined
      : config.codeHost === "github"
        ? new GitHubOAuth({
            githubUrl: config.hostUrl,
            clientId: config.clientId,
            clientSecret: config.clientSecret,
            redirectUri: `${config.publicUrl}/auth/callback`,
          })
        : new GitLabOAuth({
            gitlabUrl: config.hostUrl,
            clientId: config.clientId,
            clientSecret: config.clientSecret,
            redirectUri: `${config.publicUrl}/auth/callback`,
          }),
  hostFor: (token) =>
    config.codeHost === "github"
      ? new GitHubClient(config.hostUrl, token, fetch, { name: config.indexJob, file: config.indexArtifact })
      : new GitLabClient(config.hostUrl, token, fetch, { name: config.indexJob, artifact: config.indexArtifact }),
  review: new ReviewMergeRequestUseCase(new GitRepoCache(config.cacheDir, { maxBytes: config.cacheMaxBytes }), (gitDir, base, head, index) =>
    analyzer.analyze(gitDir, base, head, index),
  ),
  viewed: new FileViewedStore(`${config.dataDir}/viewed.json`),
  highlighters: (await loadLanguageSupport()).highlighters,
});

app.listen(config.port, () => {
  const name = config.host.name;
  const mode = config.mode === "full" ? `full (${name} sign-in, comments, approvals)` : "view-only (personal access tokens)";
  console.log(`diffmap service on port ${config.port}, ${mode}, ${name} ${config.hostUrl}, public at ${config.publicUrl}`);
});
