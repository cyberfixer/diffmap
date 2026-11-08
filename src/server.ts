import { AnalyzeRangeUseCase } from "./application/use-cases/analyze-range.js";
import { ReviewMergeRequestUseCase } from "./application/use-cases/review-merge-request.js";
import { GitDiffReader } from "./infrastructure/git/git-diff-reader.js";
import { GitSourceReader } from "./infrastructure/git/git-source-reader.js";
import { GitLabClient } from "./infrastructure/gitlab/gitlab-client.js";
import { GitLabOAuth } from "./infrastructure/gitlab/gitlab-oauth.js";
import { GitRepoCache } from "./infrastructure/gitlab/git-repo-cache.js";
import { TsHighlighter } from "./infrastructure/parsers/typescript/ts-highlighter.js";
import { TsMorphAdapter } from "./infrastructure/parsers/typescript/ts-morph.adapter.js";
import { TsMorphCallGraph } from "./infrastructure/parsers/typescript/ts-morph-call-graph.js";
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

const sessions = new SessionStore();
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
  hostFor: (token) => new GitLabClient(config.gitlabUrl, token),
  review: new ReviewMergeRequestUseCase(new GitRepoCache(config.cacheDir), (gitDir, base, head) =>
    new AnalyzeRangeUseCase(
      new GitDiffReader(gitDir),
      new GitSourceReader(gitDir),
      [new TsMorphAdapter()],
      [new TsMorphCallGraph()],
    ).execute(base, head),
  ),
  highlighters: [new TsHighlighter()],
});

app.listen(config.port, () => {
  console.log(`gitmap service on port ${config.port}, signing in with ${config.gitlabUrl}, public at ${config.publicUrl}`);
});
