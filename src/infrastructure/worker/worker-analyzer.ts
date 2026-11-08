import { Worker } from "node:worker_threads";
import type { AnalysisResult } from "../../domain/analysis-result.js";

/**
 * Runs analyses in worker threads. Parsing a whole repo with the TypeScript
 * compiler is heavy, synchronous work; on the main thread it would stop the
 * server from answering anyone else. At most `max` run at once.
 */
export class WorkerAnalyzer {
  private running = 0;
  private waiting: (() => void)[] = [];

  constructor(private readonly max = 2) {}

  async analyze(gitDir: string, base: string, head: string): Promise<AnalysisResult> {
    if (this.running >= this.max) await new Promise<void>((r) => this.waiting.push(r));
    this.running++;
    try {
      return await this.run(gitDir, base, head);
    } finally {
      this.running--;
      this.waiting.shift()?.();
    }
  }

  private run(gitDir: string, base: string, head: string): Promise<AnalysisResult> {
    return new Promise((resolve, reject) => {
      const w = new Worker(new URL("./analyze-worker.js", import.meta.url), {
        workerData: { gitDir, base, head },
        execArgv: [], // don't inherit flags meant for the main script
      });
      let done = false;
      w.once("message", (m: { ok: boolean; result?: AnalysisResult; error?: string }) => {
        done = true;
        if (m.ok) resolve(m.result!);
        else reject(new Error(m.error));
      });
      w.once("error", (err) => {
        done = true;
        reject(err);
      });
      w.once("exit", (code) => {
        if (!done) reject(new Error(`Analysis stopped unexpectedly (exit code ${code}).`));
      });
    });
  }
}
