import type { ReviewProgressPort } from "../../application/ports/merge-request.port.js";
import { JsonFile } from "./json-file.js";

type Data = Record<string, string[]>; // "<user>|<project>!<iid>" -> viewed symbol ids

/** Which symbols each user marked as viewed, per merge request, in one JSON file. */
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

  async getViewed(user: string, projectPath: string, iid: number): Promise<string[]> {
    return this.data[this.key(user, projectPath, iid)] ?? [];
  }

  async setViewed(user: string, projectPath: string, iid: number, symbolId: string, viewed: boolean): Promise<string[]> {
    const k = this.key(user, projectPath, iid);
    const set = new Set(this.data[k] ?? []);
    if (viewed) set.add(symbolId);
    else set.delete(symbolId);
    if (set.size) this.data[k] = [...set];
    else delete this.data[k];
    this.file.write(this.data);
    return [...set];
  }
}
