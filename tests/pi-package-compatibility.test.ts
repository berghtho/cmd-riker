import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const run = promisify(execFile);

test("the published Pi entrypoint starts with Riker's inline-extension options", async (t) => {
  const fixture = await mkdtemp(join(tmpdir(), "cmd-riker-pi-entry-"));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const entrypoint = import.meta.resolve("@earendil-works/pi-coding-agent");
  const { stdout } = await run(process.execPath, [
    "--input-type=module",
    "--eval",
    `const { main } = await import(${JSON.stringify(entrypoint)});
     await main(["--offline", "--help", "--no-extensions", "--no-skills", "--no-context-files"], {
       extensionFactories: [{
         name: "riker-compatibility",
         factory(pi) {
           pi.registerFlag("riker-compatibility", { type: "boolean", description: "Riker compatibility probe" });
         },
       }],
     });`,
  ], {
    cwd: fixture,
    env: { ...process.env, PI_CODING_AGENT_DIR: fixture },
    timeout: 15_000,
  });
  assert.match(stdout, /--riker-compatibility/);
});
