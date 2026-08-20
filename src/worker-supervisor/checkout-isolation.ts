import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

export type IsolatedCheckout = {
  root: string;
  baselineCommit: string;
  isolation: { kind: "branch"; branch: string } | { kind: "worktree"; branch?: string };
  managedExecutionCheckout?: {
    kind: "managed-worktree";
    targetProjectRoot: string;
  };
};

export type ExecutionCheckoutTarget = "prepared" | "reconciled" | "disposed";

export class MaterialExecutionCheckoutError extends Error {}

export interface EffectfulCheckoutInspector {
  verify(checkout: string, timeoutMs: number, commitmentId?: string): Promise<IsolatedCheckout>;
  advance?(
    checkout: IsolatedCheckout,
    target: ExecutionCheckoutTarget,
    observedChanges: string[],
    timeoutMs: number,
  ): Promise<void>;
  observeChanges(checkout: IsolatedCheckout, timeoutMs: number): Promise<string[]>;
}

export class NativeEffectfulCheckoutInspector implements EffectfulCheckoutInspector {
  async verify(
    checkout: string,
    timeoutMs: number,
    commitmentId = "unattributed",
  ): Promise<IsolatedCheckout> {
    const root = resolve(checkout);
    const gitRoot = resolve((await git(checkout, ["rev-parse", "--show-toplevel"], timeoutMs)).trim());
    if (!samePath(gitRoot, root)) {
      throw new Error("The effectful Worker checkout is not a verified Git root.");
    }
    const status = await git(checkout, ["status", "--porcelain=v1", "-z"], timeoutMs);
    const dirty = status.length > 0;
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
      if (dirty) {
        throw new Error("The effectful Worker checkout contains unaccepted changes.");
      }
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
    if (!dirty && branch && defaultBranch && branch !== defaultBranch) {
      return { root, baselineCommit, isolation: { kind: "branch", branch } };
    }
    // A dirty, detached, default-branch, or default-branch-unprovable primary checkout
    // gets a managed sibling Execution Checkout instead of a refusal; its result is
    // reconciled back after the Worker settles.
    const executionRoot = join(
      dirname(root),
      `${basename(root)}.cmd-riker-${commitmentId.slice(0, 12)}-${randomUUID().slice(0, 8)}`,
    );
    return {
      root: executionRoot,
      baselineCommit,
      isolation: { kind: "worktree" },
      managedExecutionCheckout: {
        kind: "managed-worktree",
        targetProjectRoot: root,
      },
    };
  }

  async advance(
    checkout: IsolatedCheckout,
    target: ExecutionCheckoutTarget,
    observedChanges: string[],
    timeoutMs: number,
  ): Promise<void> {
    const managed = checkout.managedExecutionCheckout;
    if (!managed) {
      throw new Error("Only a managed Execution Checkout has a lifecycle to advance.");
    }
    if (target === "prepared") {
      const preparation = await inspectPreparation(checkout, timeoutMs);
      if (preparation === "prepared") return;
      if (preparation === "conflict") {
        throw new MaterialExecutionCheckoutError(
          "Automatic Execution Checkout preparation found a conflicting path or Git worktree identity.",
        );
      }
      try {
        await git(
          managed.targetProjectRoot,
          ["worktree", "add", "--detach", checkout.root, checkout.baselineCommit],
          timeoutMs,
        );
      } catch (error) {
        const observed = await inspectPreparation(checkout, timeoutMs);
        if (observed === "prepared") return;
        if (observed === "absent") throw error;
        throw new MaterialExecutionCheckoutError(
          "Automatic Execution Checkout preparation could not prove a complete or absent worktree after Git failed.",
        );
      }
      if ((await inspectPreparation(checkout, timeoutMs)) !== "prepared") {
        throw new MaterialExecutionCheckoutError(
          "Automatic Execution Checkout preparation did not produce the planned isolated worktree.",
        );
      }
      return;
    }

    if (target === "reconciled") {
      if ((await inspectPreparation(checkout, timeoutMs)) !== "prepared") {
        throw new MaterialExecutionCheckoutError(
          "Execution Checkout reconciliation requires the exact prepared worktree.",
        );
      }
      const targetRoot = managed.targetProjectRoot;
      const targetHead = (await git(targetRoot, ["rev-parse", "HEAD"], timeoutMs)).trim();
      if (targetHead !== checkout.baselineCommit) {
        throw new MaterialExecutionCheckoutError(
          "The Target Project HEAD changed while its Execution Checkout was active.",
        );
      }
      // Unrelated Owner changes may coexist in the Target Project; only the Worker's
      // observed paths must reconcile exactly.
      const targetChanges = await this.observeChanges(
        unmanagedCheckout(checkout, targetRoot),
        timeoutMs,
      );
      const workerPaths = new Set(observedChanges);
      const overlapping = targetChanges.filter((path) => workerPaths.has(path));
      if (overlapping.length > 0) {
        const [sourcePatch, targetPatch] = await Promise.all([
          patchFor(checkout.root, checkout.baselineCommit, observedChanges, timeoutMs),
          patchFor(targetRoot, checkout.baselineCommit, observedChanges, timeoutMs),
        ]);
        if (sourcePatch !== targetPatch) {
          throw new MaterialExecutionCheckoutError(
            "The Target Project contains concurrent changes that conflict with the Execution Checkout result.",
          );
        }
        return;
      }
      const patch = await patchFor(
        checkout.root,
        checkout.baselineCommit,
        observedChanges,
        timeoutMs,
      );
      if (!patch.trim()) {
        throw new MaterialExecutionCheckoutError(
          "The Execution Checkout result could not be represented as an attributable Git patch.",
        );
      }
      await gitWithInput(targetRoot, ["apply", "--whitespace=nowarn", "-"], patch, timeoutMs);
      const reconciledChanges = await this.observeChanges(
        unmanagedCheckout(checkout, targetRoot),
        timeoutMs,
      );
      if (!observedChanges.every((path) => reconciledChanges.includes(path))) {
        throw new MaterialExecutionCheckoutError(
          "The reconciled Target Project change set does not match the Execution Checkout.",
        );
      }
      const reconciledPatch = await patchFor(
        targetRoot,
        checkout.baselineCommit,
        observedChanges,
        timeoutMs,
      );
      if (reconciledPatch !== patch) {
        throw new MaterialExecutionCheckoutError(
          "The reconciled Target Project content does not match the Execution Checkout result.",
        );
      }
      return;
    }

    const preparation = await inspectPreparation(checkout, timeoutMs);
    if (preparation === "absent") return;
    if (preparation === "conflict") {
      throw new MaterialExecutionCheckoutError(
        "Execution Checkout cleanup found a conflicting path or Git worktree identity.",
      );
    }
    await git(
      managed.targetProjectRoot,
      ["worktree", "remove", "--force", checkout.root],
      timeoutMs,
    );
    if ((await inspectPreparation(checkout, timeoutMs)) !== "absent") {
      throw new MaterialExecutionCheckoutError(
        "Execution Checkout cleanup could not prove that the isolated worktree was disposed.",
      );
    }
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

type WorktreeIdentity = { root: string; head?: string };

function parseWorktreeIdentities(output: string): WorktreeIdentity[] {
  const identities: WorktreeIdentity[] = [];
  let current: WorktreeIdentity | undefined;
  for (const value of nulValues(output)) {
    if (value.startsWith("worktree ")) {
      current = { root: value.slice("worktree ".length) };
      identities.push(current);
    } else if (current && value.startsWith("HEAD ")) {
      current.head = value.slice("HEAD ".length);
    }
  }
  return identities;
}

async function inspectPreparation(
  checkout: IsolatedCheckout,
  timeoutMs: number,
): Promise<"absent" | "prepared" | "conflict"> {
  const targetRoot = checkout.managedExecutionCheckout!.targetProjectRoot;
  const identities = parseWorktreeIdentities(
    await git(targetRoot, ["worktree", "list", "--porcelain", "-z"], timeoutMs),
  );
  const identity = identities.find((candidate) => pathTextEqual(candidate.root, checkout.root));
  if (!identity) return existsSync(checkout.root) ? "conflict" : "absent";
  if (!existsSync(checkout.root) || identity.head !== checkout.baselineCommit) return "conflict";
  const root = resolve(
    (await git(checkout.root, ["rev-parse", "--show-toplevel"], timeoutMs)).trim(),
  );
  return samePath(root, checkout.root) ? "prepared" : "conflict";
}

async function patchFor(
  root: string,
  baselineCommit: string,
  observedChanges: string[],
  timeoutMs: number,
): Promise<string> {
  const untracked = nulValues(
    await git(root, ["ls-files", "--others", "--exclude-standard", "-z", "--", ...observedChanges], timeoutMs),
  );
  if (untracked.length) await git(root, ["add", "-N", "--", ...untracked], timeoutMs);
  try {
    return await git(
      root,
      ["diff", "--binary", "--full-index", "--no-ext-diff", baselineCommit, "--", ...observedChanges],
      timeoutMs,
    );
  } finally {
    if (untracked.length) await git(root, ["reset", "--", ...untracked], timeoutMs);
  }
}

function gitWithInput(
  cwd: string,
  args: string[],
  input: string,
  timeoutMs: number,
): Promise<void> {
  return new Promise((resolveDone, reject) => {
    const child = spawn("git", ["-C", cwd, ...args], {
      cwd,
      windowsHide: true,
      stdio: ["pipe", "ignore", "pipe"],
    });
    let stderr = "";
    const timer = setTimeout(() => child.kill(), Math.min(timeoutMs, 10_000));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(new Error(`Git checkout isolation effect failed: ${error.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolveDone();
      else reject(new Error(`Git checkout isolation effect failed: ${stderr || `exit ${code}`}`));
    });
    child.stdin.end(input);
  });
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

function pathTextEqual(left: string, right: string): boolean {
  const normalizedLeft = resolve(left);
  const normalizedRight = resolve(right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function unmanagedCheckout(checkout: IsolatedCheckout, root: string): IsolatedCheckout {
  const { managedExecutionCheckout: _managed, ...unmanaged } = checkout;
  return { ...unmanaged, root };
}
