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

type Fetch = typeof fetch;

// The parts of GitLab's REST API responses that diffmap reads.
interface GlUser { name: string; username: string }
interface GlNote {
  id: number;
  body: string;
  author: GlUser;
  created_at: string;
  system: boolean;
  resolved?: boolean;
  resolvable?: boolean;
  position?: { new_path?: string; old_path?: string; new_line?: number | null; old_line?: number | null } | null;
}
interface GlDiscussion { id: string; notes: GlNote[] }

const person = (u: GlUser): Person => ({ name: u.name, username: u.username });

function toDiscussion(d: GlDiscussion): ReviewDiscussion | null {
  const notes = d.notes.filter((n) => !n.system);
  if (notes.length === 0) return null; // "added 2 commits" and similar
  const p = notes[0].position;
  return {
    id: d.id,
    resolved: notes.some((n) => n.resolvable) && notes.filter((n) => n.resolvable).every((n) => n.resolved),
    position: p
      ? { path: p.new_path ?? p.old_path ?? "", oldLine: p.old_line ?? null, newLine: p.new_line ?? null }
      : null,
    notes: notes.map(toNote),
  };
}

const toNote = (n: GlNote): ReviewNote => ({
  id: n.id,
  author: person(n.author),
  body: n.body,
  createdAt: n.created_at,
});

/** GitLab REST v4 client acting as the signed-in user. */
export class GitLabClient implements MergeRequestHostPort {
  constructor(
    private readonly baseUrl: string,
    private readonly token: () => Promise<string>,
    private readonly fetchImpl: Fetch = fetch,
    /** CI job that builds the index, and the artifact file it saves. */
    private readonly indexJob = { name: "diffmap-index", artifact: "index.scip" },
  ) {}

  private mrPath(projectPath: string, iid: number): string {
    return `/projects/${encodeURIComponent(projectPath)}/merge_requests/${iid}`;
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetchImpl(`${this.baseUrl.replace(/\/$/, "")}/api/v4${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${await this.token()}`,
        Accept: "application/json",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new HostError(`GitLab ${method} ${path} failed (${res.status}): ${text.slice(0, 300)}`, res.status);
    }
    return (await res.json()) as T;
  }

  /**
   * The index from the newest successful `diffmap-index` job of a pipeline for
   * exactly the MR's head commit (an index of other code would point at wrong lines).
   */
  async findIndex(mr: MergeRequestInfo): Promise<IndexLookup> {
    const project = `/projects/${encodeURIComponent(mr.projectPath)}`;
    const pipelines = await this.call<{ id: number }[]>(
      "GET",
      `${project}/pipelines?sha=${mr.diffRefs.headSha}&order_by=id&sort=desc&per_page=10`,
    );
    let pending = false;
    for (const p of pipelines) {
      const jobs = await this.call<{ id: number; name: string; status: string }[]>(
        "GET",
        `${project}/pipelines/${p.id}/jobs?per_page=100`,
      );
      for (const j of jobs.filter((j) => j.name === this.indexJob.name)) {
        if (j.status === "success") {
          const res = await this.fetchImpl(
            `${this.baseUrl.replace(/\/$/, "")}/api/v4${project}/jobs/${j.id}/artifacts/${this.indexJob.artifact}`,
            { headers: { Authorization: `Bearer ${await this.token()}` } },
          );
          if (res.ok) return { state: "found", data: new Uint8Array(await res.arrayBuffer()) };
        } else if (/^(created|pending|running|waiting_for_resource|preparing|scheduled)$/.test(j.status)) {
          pending = true;
        }
      }
    }
    return { state: pending ? "pending" : "none" };
  }

  /** Scopes of a personal access token (null for other kinds of tokens, e.g. OAuth). */
  async tokenScopes(): Promise<string[] | null> {
    try {
      return (await this.call<{ scopes: string[] }>("GET", "/personal_access_tokens/self")).scopes;
    } catch {
      return null;
    }
  }

  async currentUser(): Promise<Person> {
    return person(await this.call<GlUser>("GET", "/user"));
  }

  async getMergeRequest(projectPath: string, iid: number): Promise<MergeRequestInfo> {
    const mr = await this.call<{
      iid: number;
      title: string;
      web_url: string;
      state: string;
      author: GlUser;
      source_branch: string;
      target_branch: string;
      project_id: number;
      diff_refs: { base_sha: string; head_sha: string; start_sha: string } | null;
    }>("GET", this.mrPath(projectPath, iid));
    if (!mr.diff_refs) throw new HostError("This merge request has no diff yet.", 409);
    const project = await this.call<{ path_with_namespace: string }>(
      "GET",
      `/projects/${mr.project_id}`,
    );
    return {
      projectPath: project.path_with_namespace,
      iid: mr.iid,
      title: mr.title,
      webUrl: mr.web_url,
      state: mr.state,
      author: person(mr.author),
      sourceBranch: mr.source_branch,
      targetBranch: mr.target_branch,
      diffRefs: { baseSha: mr.diff_refs.base_sha, headSha: mr.diff_refs.head_sha, startSha: mr.diff_refs.start_sha },
      // Built from the configured GitLab address (not GitLab's own idea of its URL),
      // so it works when this service reaches GitLab by an internal name.
      cloneUrl: `${this.baseUrl.replace(/\/$/, "")}/${project.path_with_namespace}.git`,
    };
  }

  async listDiscussions(projectPath: string, iid: number): Promise<ReviewDiscussion[]> {
    const out: ReviewDiscussion[] = [];
    for (let page = 1; page <= 50; page++) {
      const batch = await this.call<GlDiscussion[]>(
        "GET",
        `${this.mrPath(projectPath, iid)}/discussions?per_page=100&page=${page}`,
      );
      for (const d of batch) {
        const v = toDiscussion(d);
        if (v) out.push(v);
      }
      if (batch.length < 100) break;
    }
    return out;
  }

  async createDiscussion(mr: MergeRequestInfo, comment: NewComment): Promise<ReviewDiscussion> {
    const p = comment.position;
    const body: Record<string, unknown> = { body: comment.body };
    if (p) {
      body.position = {
        position_type: "text",
        base_sha: mr.diffRefs.baseSha,
        start_sha: mr.diffRefs.startSha,
        head_sha: mr.diffRefs.headSha,
        old_path: p.path,
        new_path: p.path,
        ...(p.oldLine !== null ? { old_line: p.oldLine } : {}),
        ...(p.newLine !== null ? { new_line: p.newLine } : {}),
      };
    }
    try {
      const d = await this.call<GlDiscussion>("POST", `${this.mrPath(mr.projectPath, mr.iid)}/discussions`, body);
      return toDiscussion(d)!;
    } catch (err) {
      // GitLab answers 400 when the line cannot carry a diff comment.
      if (p && err instanceof HostError && err.status === 400) throw new PositionRejectedError(err.message);
      throw err;
    }
  }

  async reply(projectPath: string, iid: number, discussionId: string, body: string): Promise<ReviewNote> {
    const n = await this.call<GlNote>(
      "POST",
      `${this.mrPath(projectPath, iid)}/discussions/${encodeURIComponent(discussionId)}/notes`,
      { body },
    );
    return toNote(n);
  }

  async getApprovals(projectPath: string, iid: number): Promise<Approvals> {
    const a = await this.call<{
      user_has_approved: boolean;
      user_can_approve: boolean;
      approved_by: { user: GlUser }[];
    }>("GET", `${this.mrPath(projectPath, iid)}/approvals`);
    return {
      userHasApproved: a.user_has_approved,
      userCanApprove: a.user_can_approve,
      approvedBy: (a.approved_by ?? []).map((x) => person(x.user)),
    };
  }

  async approve(mr: MergeRequestInfo): Promise<Approvals> {
    // Passing the head SHA makes GitLab refuse if new commits arrived since the page loaded.
    await this.call("POST", `${this.mrPath(mr.projectPath, mr.iid)}/approve`, { sha: mr.diffRefs.headSha });
    return this.getApprovals(mr.projectPath, mr.iid);
  }

  async unapprove(mr: MergeRequestInfo): Promise<Approvals> {
    await this.call("POST", `${this.mrPath(mr.projectPath, mr.iid)}/unapprove`, {});
    return this.getApprovals(mr.projectPath, mr.iid);
  }
}
