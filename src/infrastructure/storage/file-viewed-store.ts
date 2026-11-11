import type { ReviewProgressPort, ViewedMarks } from "../../application/ports/merge-request.port.js";
import { JsonFile } from "./json-file.js";

// "<user>|<project>!<iid>" -> { id: the version that was viewed }.
// Files written before versions were kept hold a list of ids instead.
type Data = Record<string, ViewedMarks | string[]>;

/** What each user marked as viewed, per merge request, in one JSON file. */
export class FileViewedStore implements ReviewProgressPort {
  private file: JsonFile<Data>;
  private data: Data;

  constructor(path: string) {
    this.file = new JsonFile<Data>(path, {});
    this.data = this.file.read();
  }

  private key(user: string, projectPath: string, iid: number): string {
    return `${user}|${projectPath}!${iid}`;
  }

  private marks(k: string): ViewedMarks {
    const saved = this.data[k];
    if (!saved) return {};
    // Old marks have no version, so they match nothing and must be ticked again.
    if (Array.isArray(saved)) return Object.fromEntries(saved.map((id) => [id, ""]));
    return { ...saved };
  }

  async getViewed(user: string, projectPath: string, iid: number): Promise<ViewedMarks> {
    return this.marks(this.key(user, projectPath, iid));
  }

  async setViewed(user: string, projectPath: string, iid: number, id: string, version: string | null): Promise<ViewedMarks> {
    const k = this.key(user, projectPath, iid);
    const marks = this.marks(k);
    if (version === null) delete marks[id];
    else marks[id] = version;
    if (Object.keys(marks).length) this.data[k] = marks;
    else delete this.data[k];
    this.file.write(this.data);
    return marks;
  }
}
