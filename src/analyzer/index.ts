import { gitDiff, gitMergeBase, gitRevParse, gitShow } from "../git.js";
import { parseTsDiff } from "../diff.js";
import { analyzeTypeScriptFile } from "./typescript.js";
import type { AnalysisResult } from "./types.js";

/**
 * Run the full analysis pipeline for a git range.
 *
 * @param base  The base ref (e.g. "main", a SHA, "HEAD~3")
 * @param head  The head ref (e.g. "HEAD", a branch name)
 * @param cwd   Working directory to run git commands in (defaults to process.cwd())
 */
export async function analyzeRange(
  base: string,
  head: string,
  cwd?: string
): Promise<AnalysisResult> {
  const resolvedBase = gitRevParse(base, cwd);
  const resolvedHead = gitRevParse(head, cwd);
  const mergeBase = gitMergeBase(resolvedBase, resolvedHead, cwd);

  const diffText = gitDiff(base, head, cwd);
  const fileChanges = parseTsDiff(diffText);

  const symbols = fileChanges.flatMap((fc) => {
    const baseSource = fc.basePath
      ? gitShow(mergeBase, fc.basePath, cwd)
      : null;
    const headSource = fc.headPath
      ? gitShow(resolvedHead, fc.headPath, cwd)
      : null;

    return analyzeTypeScriptFile({
      filePath: fc.path,
      removedLines: fc.removedLines,
      addedLines: fc.addedLines,
      baseSource,
      headSource,
    });
  });

  return {
    base: resolvedBase,
    head: resolvedHead,
    symbols,
  };
}
