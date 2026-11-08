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

/** Runs the existing analysis on a local git directory. */
export type Analyze = (gitDir: string, base: string, head: string) => AnalysisResult;

export interface MergeRequestReview {
  mr: MergeRequestInfo;
  result: AnalysisResult;
  discussions: ReviewDiscussion[];
  approvals: Approvals;
}

export interface CommentRequest {
  body: string;
  position?: LinePosition;
  /** The line's code, quoted when the comment has to fall back to a general MR comment. */
  code?: string;
}

const MAX_CACHED = 20;

/**
 * Review a merge request: fetch its code, run the analysis, and read or write
 * comments and approvals. Analyses are cached per base..head, because they
 * only change when new commits are pushed.
 */
export class ReviewMergeRequestUseCase {
  constructor(
    private readonly repos: RepoCachePort,
    private readonly analyze: Analyze,
    private readonly cache = new Map<string, AnalysisResult>(),
  ) {}

  async open(host: MergeRequestHostPort, token: string, projectPath: string, iid: number): Promise<MergeRequestReview> {
    // Read the MR first: this also checks the user may see the project.
    const mr = await host.getMergeRequest(projectPath, iid);
    const [result, discussions, approvals] = await Promise.all([
      this.analysis(mr, token),
      host.listDiscussions(mr.projectPath, iid),
      host.getApprovals(mr.projectPath, iid),
    ]);
    return { mr, result, discussions, approvals };
  }

  private async analysis(mr: MergeRequestInfo, token: string): Promise<AnalysisResult> {
    const key = `${mr.projectPath}@${mr.diffRefs.baseSha}..${mr.diffRefs.headSha}`;
    const hit = this.cache.get(key);
    if (hit) return hit;
    const gitDir = await this.repos.prepare(mr, token);
    const result = this.analyze(gitDir, mr.diffRefs.baseSha, mr.diffRefs.headSha);
    this.cache.set(key, result);
    if (this.cache.size > MAX_CACHED) this.cache.delete(this.cache.keys().next().value!);
    return result;
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
    if (req.position) {
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
