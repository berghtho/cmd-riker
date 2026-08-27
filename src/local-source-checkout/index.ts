import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";

const executeFile = promisify(execFile);
const commitPattern = /^[0-9a-f]{7,40}$/i;

export type LocalSourceCheckout = Readonly<{
  path: string;
  headCommit: string;
}>;

// Discovers source only from the caller's invocation directory. The returned
// path is runtime-only: callers must never persist it into a release or state.
export async function inspectLocalSourceCheckout(
  invocationDirectory: string,
  expectedCommit?: string,
): Promise<LocalSourceCheckout | undefined> {
  if (expectedCommit !== undefined && !commitPattern.test(expectedCommit)) return undefined;
  try {
    if (expectedCommit !== undefined) {
      await executeFile("git", ["cat-file", "-e", `${expectedCommit}^{commit}`], {
        cwd: invocationDirectory,
        timeout: 10_000,
        windowsHide: true,
      });
    }
    const result = await executeFile("git", ["rev-parse", "--show-toplevel", "HEAD"], {
      cwd: invocationDirectory,
      encoding: "utf8",
      timeout: 10_000,
      windowsHide: true,
    });
    const [path, headCommit] = result.stdout.trim().split(/\r?\n/);
    if (!path || !headCommit || !commitPattern.test(headCommit)) return undefined;
    return { path: resolve(path), headCommit };
  } catch {
    return undefined;
  }
}
