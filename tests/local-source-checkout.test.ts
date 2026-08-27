import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { inspectLocalSourceCheckout } from "../src/local-source-checkout/index.ts";

const run = promisify(execFile);

test("discovers the invocation checkout without persisting a configured path", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "cmd-riker-source-checkout-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await run("git", ["init", "--quiet"], { cwd: root });
  await writeFile(join(root, "tracked.txt"), "source\n", "utf8");
  await run("git", ["add", "tracked.txt"], { cwd: root });
  await run(
    "git",
    [
      "-c",
      "user.name=CMD Riker Test",
      "-c",
      "user.email=cmd-riker@example.invalid",
      "commit",
      "--quiet",
      "-m",
      "fixture",
    ],
    { cwd: root },
  );
  const head = (await run("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
  const nested = join(root, "nested");
  await mkdir(nested);

  assert.deepEqual(await inspectLocalSourceCheckout(nested, head), {
    path: resolve(root),
    headCommit: head,
  });
  assert.equal(await inspectLocalSourceCheckout(nested, "b".repeat(40)), undefined);
});

test("returns no checkout outside Git", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "cmd-riker-not-source-checkout-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  assert.equal(await inspectLocalSourceCheckout(directory), undefined);
});
