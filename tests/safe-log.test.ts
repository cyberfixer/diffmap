import { describe, it, expect } from "vitest";
import { redactSecrets, sensitiveValues } from "../src/interfaces/server/safe-log.js";

describe("redactSecrets", () => {
  it("drops query strings from paths and URLs", () => {
    expect(redactSecrets("error: GET /auth/callback?code=abc123&state=xyz: boom")).toBe("error: GET /auth/callback?[hidden]: boom");
    expect(redactSecrets("fetch https://gitlab.lan/oauth/token?code=abc123 failed")).toBe("fetch https://gitlab.lan/oauth/token?[hidden] failed");
  });

  it("hides secret parameters wherever they appear", () => {
    expect(redactSecrets("body: grant_type=authorization_code&code=abc123&client_secret=s3cr3t")).toBe(
      "body: grant_type=authorization_code&code=[hidden]&client_secret=[hidden]",
    );
    expect(redactSecrets("refresh_token=r1 access_token=a1 private_token=p1")).toBe(
      "refresh_token=[hidden] access_token=[hidden] private_token=[hidden]",
    );
  });

  it("hides the request's own code and state even without a name in front", () => {
    expect(redactSecrets('GitLab said: "invalid grant abc123def"', ["abc123def"])).toBe('GitLab said: "invalid grant [hidden]"');
  });

  it("leaves normal lines alone", () => {
    expect(redactSecrets("map: team/api!42 for @ali")).toBe("map: team/api!42 for @ali");
  });

  it("finds the sensitive values in a request URL", () => {
    expect(sensitiveValues("/auth/callback?code=abc123&state=st4te&x=1")).toEqual(["abc123", "st4te"]);
    expect(sensitiveValues("/team/api/-/merge_requests/42")).toEqual([]);
  });
});
