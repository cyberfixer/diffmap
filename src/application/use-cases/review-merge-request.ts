import {
  PositionRejectedError,
  type Approvals,
  type LinePosition,
  type MergeRequestHostPort,
  type MergeRequestInfo,
  type RepoCachePort,
  type ReviewDiscussion,
} from "../ports/merge-request.port.js";
import type { AnalysisResult } from "../../domain/analysis-result.js";

/** Runs the existing analysis on a local git directory (in a worker thread in production). */
export type Analyze = (gitDir: string, base: string, head: string) => Promise<AnalysisResult> | AnalysisResult;

export interface MergeRequestReview {
  ready: true;
  mr: MergeRequestInfo;
  result: AnalysisResult;
  discussions: ReviewDiscussion[];
  approvals: Approvals;
}

/** How far along getting an MR ready is, for the progress screen. */
export interface PreparingStatus {
  state: "downloading" | "analysing" | "ready" | "error";
  step: string;
  percent: number | null;
  detail: string;
  error?: string;
  startedAt: number;
}

export interface CommentRequest {
  body: string;
  position?: LinePosition;
  /** The line's code, quoted when the comment has to fall back to a general MR comment. */
  code?: string;
  /** Post as a general comment quoting the line (for files outside the diff). */
  general?: boolean;
}

interface Job {
  status: PreparingStatus;
  promise: Promise<AnalysisResult>;
}

const MAX_CACHED = 20;
const keyOf = (mr: MergeRequestInfo) => `${mr.projectPath}@${mr.diffRefs.baseSha}..${mr.diffRefs.headSha}`;

/**
 * Review a merge request: fetch its code, run the analysis, and read or write
 * comments and approvals. Getting an MR ready runs as a background job whose
 * progress the page can show; results are cached per base..head, because they
 * only change when new commits are pushed.
 */
export class ReviewMergeRequestUseCase {
  private jobs = new Map<string, Job>();

  constructor(
    private readonly repos: RepoCachePort,
    private readonly analyze: Analyze,
    private readonly cache = new Map<string, AnalysisResult>(),
  ) {}

  /**
   * Open an MR. If its analysis is not ready yet, start it and return its
   * progress (or wait for it, with `wait`).
   */
  async open(
    host: MergeRequestHostPort,
    token: string,
    projectPath: string,
    iid: number,
    opts: { wait?: boolean } = {},
  ): Promise<MergeRequestReview | { ready: false; mr: MergeRequestInfo; status: PreparingStatus }> {
    // Read the MR first: this also checks the user may see the project.
    const mr = await host.getMergeRequest(projectPath, iid);
    let result = this.cache.get(keyOf(mr));
    if (!result) {
      const job = this.start(mr, token);
      if (!opts.wait) return { ready: false, mr, status: job.status };
      result = await job.promise;
    }
    const [discussions, approvals] = await Promise.all([
      host.listDiscussions(mr.projectPath, iid),
      host.getApprovals(mr.projectPath, iid),
    ]);
    return { ready: true, mr, result, discussions, approvals };
  }

  /** Progress of getting an MR ready; starts (or retries) the work if needed. */
  async progress(host: MergeRequestHostPort, token: string, projectPath: string, iid: number): Promise<PreparingStatus> {
    const mr = await host.getMergeRequest(projectPath, iid);
    if (this.cache.has(keyOf(mr))) return { state: "ready", step: "Ready", percent: 100, detail: "", startedAt: Date.now() };
    const job = this.start(mr, token);
    // Report a failure once, then forget it so the next visit tries again.
    if (job.status.state === "error") this.jobs.delete(keyOf(mr));
    return { ...job.status };
  }

  private start(mr: MergeRequestInfo, token: string): Job {
    const key = keyOf(mr);
    const existing = this.jobs.get(key);
    if (existing) return existing;

    const status: PreparingStatus = { state: "downloading", step: "Getting the code", percent: null, detail: "", startedAt: Date.now() };
    const promise = (async () => {
      const gitDir = await this.repos.prepare(mr, token, (p) => {
        status.step = p.step;
        status.percent = p.percent;
        status.detail = p.detail;
      });
      Object.assign(status, {
        state: "analysing",
        step: "Analysing the changes",
        percent: null,
        detail: "Finding changed functions and who calls them",
      });
      const result = await this.analyze(gitDir, mr.diffRefs.baseSha, mr.diffRefs.headSha);
      this.cache.set(key, result);
      if (this.cache.size > MAX_CACHED) this.cache.delete(this.cache.keys().next().value!);
      Object.assign(status, { state: "ready", step: "Ready", percent: 100, detail: "" });
      this.jobs.delete(key);
      return result;
    })();
    promise.catch((err: unknown) => {
      status.state = "error";
      status.error = err instanceof Error ? err.message : String(err);
    });
    const job = { status, promise };
    this.jobs.set(key, job);
    return job;
  }

  /**
   * Post a comment. A line GitLab cannot attach a diff comment to (for example a
   * caller in a file outside the diff) becomes a general comment that quotes it.
   */
  async comment(
    host: MergeRequestHostPort,
    projectPath: string,
    iid: number,
    req: CommentRequest,
  ): Promise<{ discussion: ReviewDiscussion; fallback: boolean }> {
    const mr = await host.getMergeRequest(projectPath, iid);
    if (req.position && !req.general) {
      try {
        return { discussion: await host.createDiscussion(mr, { body: req.body, position: req.position }), fallback: false };
      } catch (err) {
        if (!(err instanceof PositionRejectedError)) throw err;
      }
    }
    const body = req.position ? quoteLine(req.position, req.code ?? "", req.body) : req.body;
    return { discussion: await host.createDiscussion(mr, { body }), fallback: Boolean(req.position) };
  }

  async setApproval(host: MergeRequestHostPort, projectPath: string, iid: number, approve: boolean): Promise<Approvals> {
    const mr = await host.getMergeRequest(projectPath, iid);
    return approve ? host.approve(mr) : host.unapprove(mr);
  }
}

/** A general comment that points at a file and line. */
export function quoteLine(p: LinePosition, code: string, body: string): string {
  const line = p.newLine ?? p.oldLine;
  const fence = code.includes("```") ? "~~~" : "```";
  return `**\`${p.path}:${line}\`**\n${fence}\n${code}\n${fence}\n\n${body}`;
}
