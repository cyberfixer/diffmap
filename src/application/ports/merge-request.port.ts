/**
 * What gitmap needs from a code host (GitLab today) to review a merge request:
 * its details, its comment threads, and approvals. Language- and host-neutral.
 */

export interface Person {
  name: string;
  username: string;
}

export interface MergeRequestInfo {
  projectPath: string; // e.g. "team/api"
  iid: number; // the number shown as !42
  title: string;
  webUrl: string;
  state: string; // opened | merged | closed | locked
  author: Person;
  sourceBranch: string;
  targetBranch: string;
  diffRefs: { baseSha: string; headSha: string; startSha: string };
  cloneUrl: string; // HTTP(S) git URL of the project
}

/** Where a comment sits in the diff. Exactly one of the lines may be null. */
export interface LinePosition {
  path: string;
  oldLine: number | null; // line in the old file (removed or unchanged lines)
  newLine: number | null; // line in the new file (added or unchanged lines)
}

export interface ReviewNote {
  id: number;
  author: Person;
  body: string;
  createdAt: string;
}

export interface ReviewDiscussion {
  id: string;
  resolved: boolean;
  position: LinePosition | null; // null for general MR comments
  notes: ReviewNote[];
}

export interface Approvals {
  userHasApproved: boolean;
  userCanApprove: boolean;
  approvedBy: Person[];
}

export interface NewComment {
  body: string;
  position?: LinePosition; // omit for a general MR comment
}

/** Raised when the host refuses a line comment (e.g. the line is not part of the diff). */
export class PositionRejectedError extends Error {}

/** Raised for a failed call to the host; `status` is the HTTP status. */
export class HostError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export interface MergeRequestHostPort {
  currentUser(): Promise<Person>;
  getMergeRequest(projectPath: string, iid: number): Promise<MergeRequestInfo>;
  listDiscussions(projectPath: string, iid: number): Promise<ReviewDiscussion[]>;
  createDiscussion(mr: MergeRequestInfo, comment: NewComment): Promise<ReviewDiscussion>;
  reply(projectPath: string, iid: number, discussionId: string, body: string): Promise<ReviewNote>;
  getApprovals(projectPath: string, iid: number): Promise<Approvals>;
  approve(mr: MergeRequestInfo): Promise<Approvals>;
  unapprove(mr: MergeRequestInfo): Promise<Approvals>;
}

/** Progress of a long step, for showing to the user. */
export interface Progress {
  step: string; // e.g. "Downloading code (first time for this project)"
  percent: number | null; // 0-100 when known
  detail: string; // e.g. "Receiving objects 45% · 12.3 MiB"
}

/** Keeps a local git copy of a project so the existing git-based analysis can run on it. */
export interface RepoCachePort {
  /** Make sure the MR's base and head commits are available; returns the git directory. */
  prepare(mr: MergeRequestInfo, token: string, onProgress?: (p: Progress) => void): Promise<string>;
}

/** Remembers which changed symbols each user marked as viewed in a merge request. */
export interface ReviewProgressPort {
  getViewed(user: string, projectPath: string, iid: number): Promise<string[]>;
  setViewed(user: string, projectPath: string, iid: number, symbolId: string, viewed: boolean): Promise<string[]>;
}
