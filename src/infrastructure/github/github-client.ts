import {
  HostError,
  PositionRejectedError,
  type Approvals,
  type IndexLookup,
  type MergeRequestHostPort,
  type MergeRequestInfo,
  type NewComment,
  type Person,
  type ReviewDiscussion,
  type ReviewNote,
} from "../../application/ports/merge-request.port.js";
import { readZipEntry } from "../storage/zip.js";

type Fetch = typeof fetch;

// The parts of GitHub's REST API responses that diffmap reads.
interface GhUser { login: string; name?: string | null }
interface GhReviewComment {
  id: number;
  body: string;
  user: GhUser;
  created_at: string;
  path: string;
  line: number | null; // null when the comment is outdated
  side?: "LEFT" | "RIGHT";
  in_reply_to_id?: number;
}
interface GhIssueComment { id: number; body: string; user: GhUser; created_at: string }
interface GhReview { id: number; user: GhUser; state: string; submitted_at?: string }

const person = (u: GhUser): Person => ({ name: u.name || u.login, username: u.login });

/** GitHub's API address for a web address: api.github.com, or <host>/api/v3 for GitHub Enterprise. */
export function githubApiUrl(webUrl: string): string {
  const u = webUrl.replace(/\/$/, "");
  return /^https?:\/\/(www\.)?github\.com$/i.test(u) ? "https://api.github.com" : `${u}/api/v3`;
}

/**
 * GitHub REST client acting as the signed-in user. A pull request maps onto
 * diffmap's merge request: review comments are line threads, conversation
 * comments are general threads, and an approval is an "APPROVE" review.
 */
export class GitHubClient implements MergeRequestHostPort {
  private readonly api: string;
  private me: Promise<GhUser> | null = null;

  constructor(
    private readonly webUrl: string,
    private readonly token: () => Promise<string>,
    private readonly fetchImpl: Fetch = fetch,
    /** Actions artifact holding the exact index, and the file inside it. */
    private readonly indexArtifact = { name: "diffmap-index", file: "index.scip" },
  ) {
    this.api = githubApiUrl(webUrl);
  }

  private async headers(): Promise<Record<string, string>> {
    return {
      Authorization: `Bearer ${await this.token()}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "diffmap",
    };
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetchImpl(`${this.api}${path}`, {
      method,
      headers: { ...(await this.headers()), ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new HostError(`GitHub ${method} ${path} failed (${res.status}): ${text.slice(0, 300)}`, res.status);
    }
    return (res.status === 204 ? undefined : await res.json()) as T;
  }

  /** All pages of a list endpoint (100 per page, at most 30 pages). */
  private async all<T>(path: string): Promise<T[]> {
    const out: T[] = [];
    for (let page = 1; page <= 30; page++) {
      const batch = await this.call<T[]>("GET", `${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`);
      out.push(...batch);
      if (batch.length < 100) break;
    }
    return out;
  }

  private repo(projectPath: string): string {
    const [owner, name] = projectPath.split("/");
    return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
  }

  private user(): Promise<GhUser> {
    this.me ??= this.call<GhUser>("GET", "/user");
    return this.me;
  }

  async currentUser(): Promise<Person> {
    return person(await this.user());
  }

  async getMergeRequest(projectPath: string, number: number): Promise<MergeRequestInfo> {
    const pr = await this.call<{
      number: number;
      title: string;
      html_url: string;
      state: "open" | "closed";
      merged?: boolean;
      user: GhUser;
      head: { ref: string; sha: string; label: string; repo: { full_name: string } | null };
      base: { ref: string; sha: string; repo: { full_name: string } };
    }>("GET", `${this.repo(projectPath)}/pulls/${number}`);
    const fork = pr.head.repo && pr.head.repo.full_name !== pr.base.repo.full_name;
    return {
      projectPath: pr.base.repo.full_name,
      iid: pr.number,
      title: pr.title,
      webUrl: pr.html_url,
      state: pr.state === "open" ? "opened" : pr.merged ? "merged" : "closed",
      author: person(pr.user),
      sourceBranch: fork ? pr.head.label : pr.head.ref,
      targetBranch: pr.base.ref,
      diffRefs: { baseSha: pr.base.sha, headSha: pr.head.sha, startSha: pr.base.sha },
      cloneUrl: `${this.webUrl.replace(/\/$/, "")}/${pr.base.repo.full_name}.git`,
      // GitHub keeps every PR's head here, also for PRs from forks.
      fetchRef: `refs/pull/${pr.number}/head`,
      gitUser: "x-access-token",
    };
  }

  async listDiscussions(projectPath: string, number: number): Promise<ReviewDiscussion[]> {
    const repo = this.repo(projectPath);
    const [review, issue] = await Promise.all([
      this.all<GhReviewComment>(`${repo}/pulls/${number}/comments`),
      this.all<GhIssueComment>(`${repo}/issues/${number}/comments`),
    ]);

    // Review comments form threads: a root comment and the replies to it.
    const threads = new Map<number, ReviewDiscussion>();
    const note = (c: { id: number; body: string; user: GhUser; created_at: string }): ReviewNote => ({
      id: c.id,
      author: person(c.user),
      body: c.body,
      createdAt: c.created_at,
    });
    for (const c of review.filter((c) => !c.in_reply_to_id)) {
      threads.set(c.id, {
        id: `rc-${c.id}`,
        resolved: false, // the REST API does not say; resolved threads still show
        position:
          c.line === null
            ? null // outdated: the line no longer exists
            : { path: c.path, oldLine: c.side === "LEFT" ? c.line : null, newLine: c.side === "LEFT" ? null : c.line },
        notes: [note(c)],
      });
    }
    for (const c of review.filter((c) => c.in_reply_to_id)) threads.get(c.in_reply_to_id!)?.notes.push(note(c));

    const general = issue.map((c): ReviewDiscussion => ({ id: `issue-${c.id}`, resolved: false, position: null, notes: [note(c)] }));
    return [...threads.values(), ...general];
  }

  async createDiscussion(mr: MergeRequestInfo, comment: NewComment): Promise<ReviewDiscussion> {
    const repo = this.repo(mr.projectPath);
    const p = comment.position;
    if (p) {
      try {
        const c = await this.call<GhReviewComment>("POST", `${repo}/pulls/${mr.iid}/comments`, {
          body: comment.body,
          commit_id: mr.diffRefs.headSha,
          path: p.path,
          line: p.newLine ?? p.oldLine,
          side: p.newLine !== null ? "RIGHT" : "LEFT",
        });
        return {
          id: `rc-${c.id}`,
          resolved: false,
          position: p,
          notes: [{ id: c.id, author: person(c.user), body: c.body, createdAt: c.created_at }],
        };
      } catch (err) {
        // 422: the line is not part of the pull request's diff.
        if (err instanceof HostError && err.status === 422) throw new PositionRejectedError(err.message);
        throw err;
      }
    }
    const c = await this.call<GhIssueComment>("POST", `${repo}/issues/${mr.iid}/comments`, { body: comment.body });
    return { id: `issue-${c.id}`, resolved: false, position: null, notes: [{ id: c.id, author: person(c.user), body: c.body, createdAt: c.created_at }] };
  }

  async reply(projectPath: string, number: number, discussionId: string, body: string): Promise<ReviewNote> {
    const repo = this.repo(projectPath);
    const m = discussionId.match(/^rc-(\d+)$/);
    // Conversation comments have no threads on GitHub: a reply is a new comment.
    const c = m
      ? await this.call<GhReviewComment>("POST", `${repo}/pulls/${number}/comments/${m[1]}/replies`, { body })
      : await this.call<GhIssueComment>("POST", `${repo}/issues/${number}/comments`, { body });
    return { id: c.id, author: person(c.user), body: c.body, createdAt: c.created_at };
  }

  /** Each person's latest decision counts; plain comments don't change it. */
  private async latestDecisions(projectPath: string, number: number): Promise<Map<string, GhReview>> {
    const reviews = await this.all<GhReview>(`${this.repo(projectPath)}/pulls/${number}/reviews`);
    const latest = new Map<string, GhReview>();
    for (const r of reviews) {
      if (!/^(APPROVED|CHANGES_REQUESTED|DISMISSED)$/.test(r.state)) continue;
      latest.set(r.user.login, r); // reviews come oldest first
    }
    return latest;
  }

  async getApprovals(projectPath: string, number: number): Promise<Approvals> {
    const [latest, me, pr] = await Promise.all([
      this.latestDecisions(projectPath, number),
      this.user(),
      this.call<{ user: GhUser }>("GET", `${this.repo(projectPath)}/pulls/${number}`),
    ]);
    const approvedBy = [...latest.values()].filter((r) => r.state === "APPROVED").map((r) => person(r.user));
    return {
      userHasApproved: latest.get(me.login)?.state === "APPROVED",
      userCanApprove: pr.user.login !== me.login, // GitHub does not let authors approve their own PR
      approvedBy,
    };
  }

  async approve(mr: MergeRequestInfo): Promise<Approvals> {
    await this.call("POST", `${this.repo(mr.projectPath)}/pulls/${mr.iid}/reviews`, {
      commit_id: mr.diffRefs.headSha,
      event: "APPROVE",
    });
    return this.getApprovals(mr.projectPath, mr.iid);
  }

  /** GitHub has no "unapprove"; dismissing the review needs write access to the repository. */
  async unapprove(mr: MergeRequestInfo): Promise<Approvals> {
    const me = await this.user();
    const mine = (await this.latestDecisions(mr.projectPath, mr.iid)).get(me.login);
    if (mine?.state === "APPROVED") {
      try {
        await this.call("PUT", `${this.repo(mr.projectPath)}/pulls/${mr.iid}/reviews/${mine.id}/dismissals`, {
          message: "Approval withdrawn in diffmap",
          event: "DISMISS",
        });
      } catch (err) {
        if (err instanceof HostError && (err.status === 403 || err.status === 422)) {
          throw new HostError(err.message, 409, "GitHub only lets people with write access dismiss a review. Dismiss it on GitHub, or leave a comment.");
        }
        throw err;
      }
    }
    return this.getApprovals(mr.projectPath, mr.iid);
  }

  /**
   * The index from the newest `diffmap-index` artifact of a successful Actions
   * run for exactly the PR's head commit.
   */
  async findIndex(mr: MergeRequestInfo): Promise<IndexLookup> {
    const repo = this.repo(mr.projectPath);
    const { workflow_runs: runs } = await this.call<{ workflow_runs: { id: number; status: string; conclusion: string | null }[] }>(
      "GET",
      `${repo}/actions/runs?head_sha=${mr.diffRefs.headSha}&per_page=20`,
    );
    let pending = false;
    for (const run of runs) {
      if (run.status !== "completed") {
        pending = true;
        continue;
      }
      if (run.conclusion !== "success") continue;
      const { artifacts } = await this.call<{ artifacts: { name: string; expired: boolean; archive_download_url: string }[] }>(
        "GET",
        `${repo}/actions/runs/${run.id}/artifacts`,
      );
      const a = artifacts.find((x) => x.name === this.indexArtifact.name && !x.expired);
      if (!a) continue;
      // GitHub answers with a redirect to storage; fetch drops the token on that redirect.
      const res = await this.fetchImpl(a.archive_download_url, { headers: await this.headers() });
      if (!res.ok) continue;
      const data = readZipEntry(new Uint8Array(await res.arrayBuffer()), this.indexArtifact.file);
      if (data) return { state: "found", data };
    }
    return { state: pending ? "pending" : "none" };
  }
}
