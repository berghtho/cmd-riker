import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  posix,
  relative,
  resolve,
  sep,
  win32,
} from "node:path";
import { promisify } from "node:util";

const executeFile = promisify(execFile);
const minimumNodeVersion = [24, 16, 0];
const revisionPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const invalidWindowsName = /[\u0000-\u001f<>:"|?*]/;
const reservedWindowsName = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
try {
  await main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (!revisionPattern.test(options.revision)) {
    throw new Error("Source revision must be a safe exact identifier.");
  }

  const nodePath = resolve(options.node);
  const leadDist = resolve(options.leadDist);
  const leadNodeModules = resolve(options.leadNodeModules);
  const tools = options.tools === undefined ? undefined : resolve(options.tools);
  const output = resolve(options.output);
  await assertMissing(output, "Release output");
  await assertPlainDirectory(dirname(output), "Release output parent");
  await assertPlainDirectory(leadDist, "Lead Agent dist");
  await assertPlainDirectory(leadNodeModules, "Lead Agent node_modules");
  if (tools !== undefined) await assertPlainDirectory(tools, "Bundled tools");
  await assertPlainFile(nodePath, "Supplied Node runtime");
  if (basename(nodePath).toLowerCase() !== "node.exe") {
    throw new Error("--node must reference node.exe.");
  }
  if (
    isWithin(leadDist, output) ||
    isWithin(leadNodeModules, output) ||
    (tools !== undefined && isWithin(tools, output))
  ) {
    throw new Error("Release output must not be inside a supplied dist tree.");
  }

  const runtime = await inspectRuntime(nodePath);
  const leadFiles = await collectDistFiles(leadDist, "Lead Agent dist");
  const leadDependencyFiles = await collectDistFiles(
    leadNodeModules,
    "Lead Agent node_modules",
  );
  const toolFiles = tools === undefined
    ? undefined
    : await collectDistFiles(tools, "Bundled tools");
  requireEntrypoint(leadFiles, "cli.js", "Lead Agent");
  requireEntrypoint(leadFiles, "lifecycle-cli.js", "Lead Agent");
  requireEntrypoint(leadFiles, "owner-launcher.js", "Lead Agent");
  requireEntrypoint(leadFiles, "owner-client.js", "Lead Agent");

  const temporary = join(
    dirname(output),
    `.${basename(output)}.tmp-${process.pid}-${randomUUID()}`,
  );
  await mkdir(temporary, { recursive: false });
  try {
    await writeBundle({
      root: join(temporary, "lead-agent"),
      kind: "lead-agent",
      revision: options.revision,
      entrypoint: "dist/cli.js",
      trees: [
        { sourceRoot: leadDist, sourceFiles: leadFiles, destination: "dist" },
        {
          sourceRoot: leadNodeModules,
          sourceFiles: leadDependencyFiles,
          destination: "node_modules",
        },
        ...(toolFiles === undefined
          ? []
          : [{ sourceRoot: tools, sourceFiles: toolFiles, destination: "tools" }]),
      ],
      nodePath,
      runtime,
    });
    await assertMissing(output, "Release output");
    try {
      await rename(temporary, output);
    } catch (error) {
      if (hasCode(error, "EEXIST") || hasCode(error, "ENOTEMPTY")) {
        throw new Error(`Release output already exists: ${output}.`);
      }
      throw error;
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

function parseArguments(argumentsList) {
  const names = new Map([
    ["--revision", "revision"],
    ["--node", "node"],
    ["--lead-dist", "leadDist"],
    ["--lead-node-modules", "leadNodeModules"],
    ["--output", "output"],
    ["--tools", "tools"],
  ]);
  const required = ["revision", "node", "leadDist", "leadNodeModules", "output"];
  const values = {};
  for (let index = 0; index < argumentsList.length; index += 2) {
    const flag = argumentsList[index];
    const key = names.get(flag);
    const value = argumentsList[index + 1];
    if (!key || value === undefined || value.startsWith("--")) {
      throw usageError();
    }
    if (values[key] !== undefined) throw new Error(`Argument ${flag} may be supplied only once.`);
    values[key] = value;
  }
  if (required.some((key) => values[key] === undefined)) {
    throw usageError();
  }
  return values;
}

function usageError() {
  return new Error(
    "Usage: build-local-release.mjs --revision <revision> --node <node.exe> " +
      "--lead-dist <directory> --lead-node-modules <directory> --output <directory> " +
      "[--tools <directory>]",
  );
}

async function inspectRuntime(nodePath) {
  const versionOutput = await runRuntimeProbe(nodePath, ["--version"], "version");
  const observedVersion = parseSupportedNodeVersion(versionOutput);
  if (!observedVersion) {
    throw new Error(
      `Supplied Node runtime version must be v${minimumNodeVersion.join(".")} or a newer ` +
        `Node ${minimumNodeVersion[0]} release; received ${JSON.stringify(versionOutput)}.`,
    );
  }
  const architecture = await runRuntimeProbe(nodePath, ["-p", "process.arch"], "architecture");
  if (architecture !== "x64" && architecture !== "arm64") {
    throw new Error(
      `Supplied Node runtime architecture must be exactly x64 or arm64; received ${JSON.stringify(architecture)}.`,
    );
  }
  return { version: observedVersion, architecture, path: "runtime/node.exe" };
}

// The exact supplied runtime is hashed into the manifest; the version gate only
// bounds it to the supported Node major at or above the proven floor.
function parseSupportedNodeVersion(versionOutput) {
  const match = /^v(\d+)\.(\d+)\.(\d+)$/.exec(versionOutput.trim());
  if (!match) return undefined;
  const observed = [Number(match[1]), Number(match[2]), Number(match[3])];
  const supported = observed[0] === minimumNodeVersion[0] &&
    (observed[1] > minimumNodeVersion[1] ||
      (observed[1] === minimumNodeVersion[1] && observed[2] >= minimumNodeVersion[2]));
  return supported ? observed.join(".") : undefined;
}

async function runRuntimeProbe(nodePath, argumentsList, description) {
  let result;
  try {
    result = await executeFile(nodePath, argumentsList, {
      encoding: "utf8",
      maxBuffer: 64 * 1024,
      timeout: 10_000,
      windowsHide: true,
    });
  } catch (error) {
    throw new Error(`Supplied node.exe ${description} probe failed.`, { cause: error });
  }
  if (result.stderr !== "") {
    throw new Error(`Supplied node.exe ${description} probe wrote unexpected stderr.`);
  }
  return result.stdout.trim();
}

async function collectDistFiles(root, description) {
  const files = [];
  const windowsPaths = new Map();
  const walk = async (directory, relativeDirectory) => {
    const entries = await readdir(directory);
    entries.sort((left, right) => left.localeCompare(right, "en"));
    for (const name of entries) {
      const relativePath = relativeDirectory === "" ? name : `${relativeDirectory}/${name}`;
      validateRelativePath(relativePath, description);
      const key = relativePath.normalize("NFKC").toLowerCase();
      const existing = windowsPaths.get(key);
      if (existing !== undefined) {
        throw new Error(`${description} paths collide on Windows: ${existing} and ${relativePath}.`);
      }
      windowsPaths.set(key, relativePath);
      const fullPath = join(directory, name);
      const observed = await lstat(fullPath);
      if (observed.isSymbolicLink()) {
        throw new Error(`${description} contains a symlink or reparse point: ${relativePath}.`);
      }
      if (observed.isDirectory()) await walk(fullPath, relativePath);
      else if (observed.isFile()) files.push(relativePath);
      else throw new Error(`${description} contains a non-regular entry: ${relativePath}.`);
    }
  };
  await walk(root, "");
  if (files.length === 0) throw new Error(`${description} must contain built files.`);
  return files.sort(comparePaths);
}

function requireEntrypoint(files, entrypoint, description) {
  if (!files.includes(entrypoint)) {
    throw new Error(`${description} entrypoint is missing: ${entrypoint}.`);
  }
}

async function writeBundle(input) {
  const runtimeDestination = join(input.root, "runtime");
  await mkdir(runtimeDestination, { recursive: true });
  const payloadPaths = [];
  for (const tree of input.trees) {
    for (const path of tree.sourceFiles) {
      const payloadPath = `${tree.destination}/${path}`;
      const destination = join(input.root, ...payloadPath.split("/"));
      await mkdir(dirname(destination), { recursive: true });
      await copyFile(join(tree.sourceRoot, ...path.split("/")), destination);
      payloadPaths.push(payloadPath);
    }
  }
  await copyFile(input.nodePath, join(runtimeDestination, "node.exe"));

  const files = [];
  for (const path of [
    ...payloadPaths,
    "runtime/node.exe",
  ].sort(comparePaths)) {
    const bytes = await readFile(join(input.root, ...path.split("/")));
    files.push({
      path,
      size: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  }
  const manifest = {
    formatVersion: 1,
    kind: input.kind,
    revision: input.revision,
    entrypoint: input.entrypoint,
    runtime: input.runtime,
    files,
  };
  await writeFile(
    join(input.root, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    { encoding: "utf8", flag: "wx" },
  );
}

function validateRelativePath(path, description) {
  const parts = path.split("/");
  if (
    path.length === 0 ||
    path.length > 1024 ||
    path.includes("\\") ||
    posix.isAbsolute(path) ||
    win32.isAbsolute(path) ||
    win32.parse(path).root !== "" ||
    posix.normalize(path) !== path ||
    parts.some((part) =>
      part === "" ||
      part === "." ||
      part === ".." ||
      part.endsWith(".") ||
      part.endsWith(" ") ||
      invalidWindowsName.test(part) ||
      reservedWindowsName.test(part)
    )
  ) {
    throw new Error(`${description} contains an unsafe Windows-relative path: ${path}.`);
  }
}

async function assertPlainDirectory(path, description) {
  const observed = await lstat(path).catch((error) => {
    if (hasCode(error, "ENOENT")) throw new Error(`${description} is missing: ${path}.`);
    throw error;
  });
  if (observed.isSymbolicLink() || !observed.isDirectory()) {
    throw new Error(`${description} must be a plain directory: ${path}.`);
  }
}

async function assertPlainFile(path, description) {
  const observed = await lstat(path).catch((error) => {
    if (hasCode(error, "ENOENT")) throw new Error(`${description} is missing: ${path}.`);
    throw error;
  });
  if (observed.isSymbolicLink() || !observed.isFile()) {
    throw new Error(`${description} must be a plain regular file: ${path}.`);
  }
}

async function assertMissing(path, description) {
  const observed = await lstat(path).catch((error) => {
    if (hasCode(error, "ENOENT")) return undefined;
    throw error;
  });
  if (observed !== undefined) throw new Error(`${description} already exists: ${path}.`);
}

function isWithin(parent, candidate) {
  const path = relative(parent, candidate);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

function comparePaths(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function hasCode(error, code) {
  return typeof error === "object" && error !== null && error.code === code;
}
