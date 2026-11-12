import { Worker } from "node:worker_threads";
import type { AnalysisResult } from "../../domain/analysis-result.js";

/**
 * Runs analyses in worker threads. Parsing a whole repo with the TypeScript
 * compiler is heavy, synchronous work; on the main thread it would stop the
 * server from answering anyone else. At most `max` run at once, each with at
 * most `memoryMb` of heap, so one huge change fails on its own instead of
 * taking the whole service down.
 */
export class WorkerAnalyzer {
  private running = 0;
  private waiting: (() => void)[] = [];

  constructor(
    private readonly max = 2,
    private readonly memoryMb = 2048,
  ) {}

  /** How busy the workers are: analyses running, analyses waiting for a free one, and the limits. */
  load(): { running: number; waiting: number; max: number; memoryMb: number } {
    return { running: this.running, waiting: this.waiting.length, max: this.max, memoryMb: this.memoryMb };
  }

  async analyze(gitDir: string, base: string, head: string, index?: Uint8Array): Promise<AnalysisResult> {
    if (this.running >= this.max) await new Promise<void>((r) => this.waiting.push(r));
    this.running++;
    try {
      return await this.run(gitDir, base, head, index);
    } finally {
      this.running--;
      this.waiting.shift()?.();
    }
  }

  private run(gitDir: string, base: string, head: string, index?: Uint8Array): Promise<AnalysisResult> {
    return new Promise((resolve, reject) => {
      const w = new Worker(new URL("./analyze-worker.js", import.meta.url), {
        workerData: { gitDir, base, head, index },
        execArgv: [], // don't inherit flags meant for the main script
        resourceLimits: { maxOldGenerationSizeMb: this.memoryMb },
      });
      let done = false;
      w.once("message", (m: { ok: boolean; result?: AnalysisResult; error?: string }) => {
        done = true;
        if (m.ok) resolve(m.result!);
        else reject(new Error(m.error));
      });
      w.once("error", (err: Error & { code?: string }) => {
        done = true;
        reject(
          err.code === "ERR_WORKER_OUT_OF_MEMORY"
            ? new Error(`This change is too big to analyse within ${this.memoryMb} MB (ANALYSIS_MEMORY_MB).`)
            : err,
        );
      });
      w.once("exit", (code) => {
        if (!done) reject(new Error(`Analysis stopped unexpectedly (exit code ${code}).`));
      });
    });
  }
}
