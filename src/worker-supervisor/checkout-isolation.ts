import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";

export type IsolatedCheckout = {
  root: string;
  baselineCommit: string;
  isolation: { kind: "branch"; branch: string } | { kind: "worktree"; branch?: string };
};

export interface EffectfulCheckoutInspector {
  verify(checkout: string, timeoutMs: number): Promise<IsolatedCheckout>;
  observeChanges(checkout: IsolatedCheckout, timeoutMs: number): Promise<string[]>;
}

export class NativeEffectfulCheckoutInspector implements EffectfulCheckoutInspector {
  async verify(checkout: string, timeoutMs: number): Promise<IsolatedCheckout> {
    const root = resolve(checkout);
    const gitRoot = resolve((await git(checkout, ["rev-parse", "--show-toplevel"], timeoutMs)).trim());
    if (!samePath(gitRoot, root)) {
      throw new Error("The effectful Worker checkout is not a verified Git root.");
    }
    const status = await git(checkout, ["status", "--porcelain=v1", "-z"], timeoutMs);
    if (status.length > 0) {
      throw new Error("The effectful Worker checkout contains unaccepted changes.");
    }
    const baselineCommit = (await git(checkout, ["rev-parse", "HEAD"], timeoutMs)).trim();
    const branch = (await gitOptional(
      checkout,
      ["symbolic-ref", "--quiet", "--short", "HEAD"],
      timeoutMs,
    )).trim();
    const worktrees = parseWorktrees(
      await git(checkout, ["worktree", "list", "--porcelain", "-z"], timeoutMs),
    );
    const currentIndex = worktrees.findIndex((path) => samePath(path, root));
    if (currentIndex < 0) throw new Error("The active checkout has no Git worktree identity.");
    if (currentIndex > 0) {
      return {
        root,
        baselineCommit,
        isolation: { kind: "worktree", ...(branch ? { branch } : {}) },
      };
    }
    const defaultBranchRef = (await gitOptional(
      checkout,
      ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"],
      timeoutMs,
    )).trim();
    const defaultBranch = defaultBranchRef.replace(/^origin\//, "");
    if (!defaultBranch) {
      throw new Error("The Target Project default branch identity could not be proven.");
    }
    if (!branch || branch === defaultBranch) {
      throw new Error("Effectful work requires an isolated non-default branch or secondary worktree.");
    }
    return { root, baselineCommit, isolation: { kind: "branch", branch } };
  }

  async observeChanges(checkout: IsolatedCheckout, timeoutMs: number): Promise<string[]> {
    const root = resolve(
      (await git(checkout.root, ["rev-parse", "--show-toplevel"], timeoutMs)).trim(),
    );
    if (!samePath(root, checkout.root)) {
      throw new Error("The effectful Worker checkout identity changed before observation.");
    }
    const tracked = await git(
      checkout.root,
      ["diff", "--name-only", "-z", checkout.baselineCommit, "--"],
      timeoutMs,
    );
    const untracked = await git(
      checkout.root,
      ["ls-files", "--others", "--exclude-standard", "-z"],
      timeoutMs,
    );
    return [...new Set([...nulValues(tracked), ...nulValues(untracked)])].sort();
  }
}

function git(cwd: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolveOutput, reject) => {
    execFile(
      "git",
      ["-C", cwd, ...args],
      {
        cwd,
        timeout: Math.min(timeoutMs, 10_000),
        windowsHide: true,
        maxBuffer: 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error) reject(new Error(`Git checkout isolation probe failed: ${stderr || error.message}`));
        else resolveOutput(stdout);
      },
    );
  });
}

async function gitOptional(cwd: string, args: string[], timeoutMs: number): Promise<string> {
  return git(cwd, args, timeoutMs).catch(() => "");
}

function parseWorktrees(output: string): string[] {
  return nulValues(output)
    .filter((value) => value.startsWith("worktree "))
    .map((value) => value.slice("worktree ".length));
}

function nulValues(output: string): string[] {
  return output.split("\0").filter(Boolean);
}

function samePath(left: string, right: string): boolean {
  const normalizedLeft = realpathSync.native(resolve(left));
  const normalizedRight = realpathSync.native(resolve(right));
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}
