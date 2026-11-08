import { describe, it, expect, afterEach } from "vitest";
import { loadLanguageSupport } from "../src/infrastructure/language-support.js";
import { AnalyzeRangeUseCase } from "../src/application/use-cases/analyze-range.js";
import { GitDiffReader } from "../src/infrastructure/git/git-diff-reader.js";
import { GitSourceReader } from "../src/infrastructure/git/git-source-reader.js";
import { createFixtureRepo, type FixtureRepo } from "./fixtures/repo.js";

let repo: FixtureRepo | null = null;
afterEach(() => {
  repo?.cleanup();
  repo = null;
});

const CARD_TS = (body: string, input = "user") => `import { Component, Input } from "@angular/core";

@Component({
  selector: "app-user-card",
  templateUrl: "./user-card.component.html",
})
export class UserCardComponent {
  @Input() ${input}: any;

  format(u: any) {
    ${body}
  }
}
`;
const CARD_HTML = (extra: string) => `<div class="card">\n  {{ format(user) }}${extra}\n</div>\n`;
const LIST_TS = `import { Component } from "@angular/core";

@Component({
  selector: "app-user-list",
  template: \`
    <app-user-card *ngFor="let u of users" [user]="u"></app-user-card>
    <button (click)="reload()">Reload</button>
  \`,
})
export class UserListComponent {
  users = [];
  reload() {
    this.users = [];
  }
}
`;
const HIGHLIGHT_TS = (color: string) => `import { Directive } from "@angular/core";

@Directive({ selector: "[appHighlight]" })
export class HighlightDirective {
  color = "${color}";
}
`;
const PIPE_TS = (sep: string) => `import { Pipe } from "@angular/core";

@Pipe({ name: "initials" })
export class InitialsPipe {
  transform(v: string) {
    return v.split("${sep}").map((p) => p[0]).join("");
  }
}
`;
const PROFILE_TS = `import { Component } from "@angular/core";

@Component({ selector: "app-profile", templateUrl: "./profile.component.html" })
export class ProfileComponent {
  name = "Ada Lovelace";
}
`;
const PROFILE_HTML = `<p appHighlight>{{ name | initials }}</p>\n`;

async function analyse(change: (r: FixtureRepo) => void) {
  repo = createFixtureRepo();
  repo.write("src/app/user-card/user-card.component.ts", CARD_TS("return u.name;"));
  repo.write("src/app/user-card/user-card.component.html", CARD_HTML(""));
  repo.write("src/app/user-list/user-list.component.ts", LIST_TS);
  repo.write("src/app/shared/highlight.directive.ts", HIGHLIGHT_TS("yellow"));
  repo.write("src/app/shared/initials.pipe.ts", PIPE_TS(" "));
  repo.write("src/app/profile/profile.component.ts", PROFILE_TS);
  repo.write("src/app/profile/profile.component.html", PROFILE_HTML);
  repo.commit("initial");
  change(repo);
  repo.commit("change");
  const langs = await loadLanguageSupport();
  return new AnalyzeRangeUseCase(new GitDiffReader(repo.dir), new GitSourceReader(repo.dir), langs.parsers, langs.graphs).execute("HEAD~1", "HEAD");
}

const edges = (r: Awaited<ReturnType<typeof analyse>>) => r.edges.map((e) => `${e.from} -> ${e.to} @${e.sites?.map((s) => s.line).join(",")}`);

describe("Angular templates", () => {
  it("link a component to the templates that use its selector, and a template to its methods", async () => {
    const r = await analyse((repo) => {
      repo.write("src/app/user-card/user-card.component.ts", CARD_TS("return u.name.trim();", "person"));
      repo.write("src/app/user-card/user-card.component.html", CARD_HTML(" !"));
    });

    expect(r.symbols.map((s) => `${s.kind} ${s.name}`).sort()).toEqual([
      "class UserCardComponent", "method UserCardComponent.format", "template template",
    ]);
    expect(edges(r)).toContain(
      "src/app/user-list/user-list.component.ts#UserListComponent.template -> src/app/user-card/user-card.component.ts#UserCardComponent @6",
    );
    expect(edges(r)).toContain(
      "src/app/user-card/user-card.component.html#template -> src/app/user-card/user-card.component.ts#UserCardComponent.format @2",
    );
    const caller = r.nodes.find((n) => n.id.endsWith("#UserListComponent.template"))!;
    expect(caller.code?.join("\n")).toContain("<app-user-card");
  });

  it("link attribute directives and pipes to the templates using them", async () => {
    const r = await analyse((repo) => {
      repo.write("src/app/shared/highlight.directive.ts", HIGHLIGHT_TS("orange"));
      repo.write("src/app/shared/initials.pipe.ts", PIPE_TS("-"));
    });
    expect(edges(r)).toContain("src/app/profile/profile.component.html#template -> src/app/shared/highlight.directive.ts#HighlightDirective @1");
    // `| initials` runs the pipe's transform()
    expect(edges(r)).toContain("src/app/profile/profile.component.html#template -> src/app/shared/initials.pipe.ts#InitialsPipe.transform @1");
  });
});
