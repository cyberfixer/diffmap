/**
 * Everything the web service says or matches that differs between code hosts:
 * names, URL shapes, wording and token help. The rest of the service is shared.
 */
export interface HostProfile {
  kind: "gitlab" | "github";
  name: string; // "GitLab"
  url: string; // web address, e.g. https://gitlab.company.com
  reviewName: string; // "merge request"
  refPrefix: string; // "!" as in !42, "#" as in #42
  /** Find "<project>" and "<number>" in a path of a review page on this host (or on diffmap). */
  parsePath(path: string): { projectPath: string; number: number } | null;
  /** diffmap path of a review, mirroring the host's own URL. */
  pathFor(projectPath: string, number: number): string;
  example: string; // an example link, for the start page
  token: {
    createUrl: string; // where to make a personal token
    howTo: string; // what to pick there (HTML-safe text)
  };
}

const decodePath = (p: string): string => p.split("/").map(decodeURIComponent).join("/");
const encodePath = (p: string): string => p.split("/").map(encodeURIComponent).join("/");

export function gitlabProfile(url: string): HostProfile {
  return {
    kind: "gitlab",
    name: "GitLab",
    url,
    reviewName: "merge request",
    refPrefix: "!",
    parsePath(path) {
      const m = path.match(/^\/(.+?)\/-\/merge_requests\/(\d+)/);
      return m ? { projectPath: decodePath(m[1]), number: Number(m[2]) } : null;
    },
    pathFor: (p, n) => `/${encodePath(p)}/-/merge_requests/${n}`,
    example: `${url}/group/project/-/merge_requests/42`,
    token: {
      createUrl: `${url}/-/user_settings/personal_access_tokens?name=diffmap&scopes=read_api,read_repository`,
      howTo: "opens with the right settings: scopes read_api and read_repository",
    },
  };
}

export function githubProfile(url: string): HostProfile {
  return {
    kind: "github",
    name: "GitHub",
    url,
    reviewName: "pull request",
    refPrefix: "#",
    parsePath(path) {
      const m = path.match(/^\/([^/]+\/[^/]+)\/pulls?\/(\d+)/);
      return m ? { projectPath: decodePath(m[1]), number: Number(m[2]) } : null;
    },
    pathFor: (p, n) => `/${encodePath(p)}/pull/${n}`,
    example: `${url}/owner/repo/pull/42`,
    token: {
      createUrl: `${url}/settings/personal-access-tokens/new`,
      howTo: "a fine-grained token with read access to Contents and Pull requests for the repositories you review",
    },
  };
}
