import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  copyFile,
  chmod,
  lstat,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, posix, win32 } from "node:path";

export type LocalReleaseKind = "lead-agent" | "recovery-actor";

export type LocalReleaseManifest = {
  formatVersion: 1;
  kind: LocalReleaseKind;
  revision: string;
  entrypoint: string;
  runtime: {
    version: string;
    architecture: "x64" | "arm64";
    path: string;
  };
  files: Array<{
    path: string;
    size: number;
    sha256: string;
  }>;
};

export type VerifiedLocalRelease = {
  identity: {
    kind: LocalReleaseKind;
    revision: string;
    digest: string;
  };
  path: string;
  entrypointPath: string;
  runtime: {
    version: string;
    architecture: "x64" | "arm64";
    path: string;
  };
  manifest: LocalReleaseManifest;
};

const manifestKeys = ["entrypoint", "files", "formatVersion", "kind", "revision", "runtime"];
const runtimeKeys = ["architecture", "path", "version"];
const fileKeys = ["path", "sha256", "size"];
const digestPattern = /^[a-f0-9]{64}$/;
const revisionPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const nodeVersionPattern = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;
const invalidWindowsName = /[\u0000-\u001f<>:"|?*]/;
const reservedWindowsName = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

export function parseLocalReleaseManifest(json: string): LocalReleaseManifest {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    throw new Error("Local release manifest must be valid JSON.");
  }
  if (!isRecord(value) || !hasExactKeys(value, manifestKeys)) {
    throw new Error("Local release manifest must contain exactly the format version 1 keys.");
  }
  if (value.formatVersion !== 1) {
    throw new Error("Local release manifest formatVersion must be exactly 1.");
  }
  if (value.kind !== "lead-agent" && value.kind !== "recovery-actor") {
    throw new Error("Local release manifest kind is invalid.");
  }
  if (typeof value.revision !== "string" || !revisionPattern.test(value.revision)) {
    throw new Error("Local release revision must be a safe exact identifier.");
  }
  if (typeof value.entrypoint !== "string") {
    throw new Error("Local release entrypoint must be a relative path.");
  }
  validateRelativePath(value.entrypoint, "entrypoint");

  if (!isRecord(value.runtime) || !hasExactKeys(value.runtime, runtimeKeys)) {
    throw new Error("Local release runtime must contain exactly version, architecture, and path.");
  }
  const runtime = value.runtime;
  if (typeof runtime.version !== "string" || !nodeVersionPattern.test(runtime.version)) {
    throw new Error("Bundled Node runtime version must be an exact numeric version.");
  }
  if (runtime.architecture !== "x64" && runtime.architecture !== "arm64") {
    throw new Error("Bundled Node runtime architecture must be x64 or arm64.");
  }
  if (typeof runtime.path !== "string") {
    throw new Error("Bundled Node runtime path must be relative.");
  }
  validateRelativePath(runtime.path, "runtime path");
  if (basename(runtime.path).toLowerCase() !== "node.exe") {
    throw new Error("Bundled Node runtime path must reference node.exe.");
  }

  if (!Array.isArray(value.files) || value.files.length === 0) {
    throw new Error("Local release manifest must contain a complete non-empty file list.");
  }
  const files: LocalReleaseManifest["files"] = [];
  const paths = new Set<string>();
  for (const candidate of value.files) {
    if (!isRecord(candidate) || !hasExactKeys(candidate, fileKeys)) {
      throw new Error("Each local release file must contain exactly path, size, and sha256.");
    }
    if (typeof candidate.path !== "string") {
      throw new Error("Local release file paths must be relative.");
    }
    validateRelativePath(candidate.path, "file path");
    const pathKey = windowsPathKey(candidate.path);
    if (pathKey === windowsPathKey("manifest.json")) {
      throw new Error("manifest.json is metadata and must not appear in its own file list.");
    }
    if (paths.has(pathKey)) {
      throw new Error(`Local release file path is duplicated or collides on Windows: ${candidate.path}.`);
    }
    paths.add(pathKey);
    if (!Number.isSafeInteger(candidate.size) || (candidate.size as number) < 0) {
      throw new Error(`Local release file size is invalid: ${candidate.path}.`);
    }
    if (typeof candidate.sha256 !== "string" || !digestPattern.test(candidate.sha256)) {
      throw new Error(`Local release file SHA-256 is invalid: ${candidate.path}.`);
    }
    files.push({ path: candidate.path, size: candidate.size as number, sha256: candidate.sha256 });
  }

  if (!files.some((file) => file.path === value.entrypoint)) {
    throw new Error("Local release entrypoint must reference a listed file.");
  }
  if (!files.some((file) => file.path === runtime.path)) {
    throw new Error("Bundled Node runtime path must reference a listed file.");
  }

  return {
    formatVersion: 1,
    kind: value.kind,
    revision: value.revision,
    entrypoint: value.entrypoint,
    runtime: {
      version: runtime.version,
      architecture: runtime.architecture,
      path: runtime.path,
    },
    files,
  };
}

export async function verifyLocalReleaseCandidate(
  candidateDirectory: string,
  expectedKind: LocalReleaseKind,
): Promise<VerifiedLocalRelease> {
  await requirePlainDirectory(candidateDirectory, "Local release candidate");
  const manifestPath = join(candidateDirectory, "manifest.json");
  const manifestBytes = await readStablePlainFile(manifestPath, "Local release manifest");
  let manifestText: string;
  try {
    manifestText = new TextDecoder("utf-8", { fatal: true }).decode(manifestBytes);
  } catch {
    throw new Error("Local release manifest must be valid UTF-8.");
  }
  const manifest = parseLocalReleaseManifest(manifestText);
  if (manifest.kind !== expectedKind) {
    throw new Error(`Local release kind ${manifest.kind} does not match expected ${expectedKind}.`);
  }

  const actualFiles = await collectFiles(candidateDirectory);
  const declaredPaths = new Map(manifest.files.map((file) => [windowsPathKey(file.path), file]));
  for (const [pathKey, actualPath] of actualFiles) {
    if (pathKey === windowsPathKey("manifest.json")) continue;
    if (!declaredPaths.has(pathKey)) {
      throw new Error(`Local release contains an undeclared file: ${actualPath}.`);
    }
  }
  for (const file of manifest.files) {
    const actualPath = actualFiles.get(windowsPathKey(file.path));
    if (actualPath === undefined) {
      throw new Error(`Local release is missing a declared file: ${file.path}.`);
    }
    if (actualPath !== file.path) {
      throw new Error(`Local release path casing does not match its manifest: ${file.path}.`);
    }
    const bytes = await readStablePlainFile(toNativePath(candidateDirectory, file.path), `Local release file ${file.path}`);
    if (bytes.byteLength !== file.size) {
      throw new Error(`Local release file size changed: ${file.path}.`);
    }
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (digest !== file.sha256) {
      throw new Error(`Local release file digest changed: ${file.path}.`);
    }
  }

  const canonicalManifest = canonicalJson(manifest);
  const identityHash = createHash("sha256");
  identityHash.update("cmd-riker-local-release-v1\0");
  identityHash.update(canonicalManifest);
  for (const file of [...manifest.files].sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)) {
    identityHash.update("\0file\0");
    identityHash.update(file.path);
    identityHash.update("\0");
    identityHash.update(String(file.size));
    identityHash.update("\0");
    identityHash.update(file.sha256);
  }

  return verifiedRelease(candidateDirectory, manifest, identityHash.digest("hex"));
}

export async function stageLocalRelease(
  candidateDirectory: string,
  versionsDirectory: string,
  expectedKind: LocalReleaseKind,
): Promise<VerifiedLocalRelease> {
  const candidate = await verifyLocalReleaseCandidate(candidateDirectory, expectedKind);
  await ensurePlainDirectory(versionsDirectory);
  const destination = join(versionsDirectory, candidate.identity.revision);
  const existing = await lstat(destination).catch((error: unknown) => {
    if (hasCode(error, "ENOENT")) return undefined;
    throw error;
  });
  if (existing !== undefined) {
    return verifyIdempotentDestination(destination, candidate, expectedKind);
  }

  const temporary = join(
    versionsDirectory,
    `.${candidate.identity.revision}.tmp-${randomUUID()}`,
  );
  await mkdir(temporary, { recursive: false, mode: 0o700 });
  try {
    for (const file of candidate.manifest.files) {
      const target = toNativePath(temporary, file.path);
      await mkdir(dirname(target), { recursive: true });
      await copyFile(toNativePath(candidateDirectory, file.path), target, constants.COPYFILE_EXCL);
    }
    await writeFile(
      join(temporary, "manifest.json"),
      `${canonicalJson(candidate.manifest)}\n`,
      { encoding: "utf8", flag: "wx" },
    );
    const staged = await verifyLocalReleaseCandidate(temporary, expectedKind);
    if (staged.identity.digest !== candidate.identity.digest) {
      throw new Error("Local release candidate changed while it was being staged.");
    }
    await makeReadOnly(temporary);
    for (let attempt = 0; ; attempt += 1) {
      try {
        await rename(temporary, destination);
        break;
      } catch (error) {
        if (hasCode(error, "EEXIST") || hasCode(error, "ENOTEMPTY")) {
          return verifyIdempotentDestination(destination, candidate, expectedKind);
        }
        if (!hasCode(error, "EPERM")) throw error;
        const destinationExists = await lstat(destination).then(
          () => true,
          (statError: unknown) => {
            if (hasCode(statError, "ENOENT")) return false;
            throw statError;
          },
        );
        if (destinationExists) {
          return verifyIdempotentDestination(destination, candidate, expectedKind);
        }
        if (attempt >= 4) throw error;
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 20 * 2 ** attempt));
      }
    }
    return verifiedRelease(destination, staged.manifest, staged.identity.digest);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function verifyIdempotentDestination(
  destination: string,
  candidate: VerifiedLocalRelease,
  expectedKind: LocalReleaseKind,
): Promise<VerifiedLocalRelease> {
  let installed: VerifiedLocalRelease;
  try {
    installed = await verifyLocalReleaseCandidate(destination, expectedKind);
  } catch (error) {
    throw new Error(`Immutable local release destination is occupied by an invalid version: ${destination}.`, {
      cause: error,
    });
  }
  if (installed.identity.digest !== candidate.identity.digest) {
    throw new Error(
      `Immutable local release ${candidate.identity.revision} already exists with different bytes.`,
    );
  }
  return installed;
}

async function collectFiles(root: string): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  const paths = new Map<string, string>();
  const walk = async (directory: string, relativeDirectory: string): Promise<void> => {
    const entries = await readdir(directory);
    for (const name of entries) {
      const relativePath = relativeDirectory === "" ? name : `${relativeDirectory}/${name}`;
      validateRelativePath(relativePath, "candidate path");
      const pathKey = windowsPathKey(relativePath);
      const existing = paths.get(pathKey);
      if (existing !== undefined) {
        throw new Error(`Local release paths collide on Windows: ${existing} and ${relativePath}.`);
      }
      paths.set(pathKey, relativePath);
      const fullPath = join(directory, name);
      const observed = await lstat(fullPath);
      if (observed.isSymbolicLink()) {
        throw new Error(`Local release contains a symlink or reparse point: ${relativePath}.`);
      }
      if (observed.isDirectory()) {
        await walk(fullPath, relativePath);
      } else if (observed.isFile()) {
        files.set(pathKey, relativePath);
      } else {
        throw new Error(`Local release contains a non-regular filesystem entry: ${relativePath}.`);
      }
    }
  };
  await walk(root, "");
  if (files.get(windowsPathKey("manifest.json")) !== "manifest.json") {
    throw new Error("Local release must contain manifest.json with exact casing.");
  }
  return files;
}

async function readStablePlainFile(path: string, description: string): Promise<Buffer> {
  const before = await lstat(path, { bigint: true }).catch((error: unknown) => {
    if (hasCode(error, "ENOENT")) throw new Error(`${description} is missing.`);
    throw error;
  });
  if (before.isSymbolicLink() || !before.isFile()) {
    throw new Error(`${description} must be a regular file, not a symlink or reparse point.`);
  }
  const bytes = await readFile(path);
  const after = await lstat(path, { bigint: true });
  if (
    !after.isFile() ||
    after.isSymbolicLink() ||
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.size !== after.size ||
    before.mtimeNs !== after.mtimeNs ||
    before.ctimeNs !== after.ctimeNs
  ) {
    throw new Error(`${description} changed during verification.`);
  }
  return bytes;
}

async function requirePlainDirectory(path: string, description: string): Promise<void> {
  const observed = await lstat(path).catch((error: unknown) => {
    if (hasCode(error, "ENOENT")) throw new Error(`${description} is missing.`);
    throw error;
  });
  if (observed.isSymbolicLink() || !observed.isDirectory()) {
    throw new Error(`${description} must be a directory, not a symlink or reparse point.`);
  }
}

async function ensurePlainDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
  await requirePlainDirectory(path, "Local release versions directory");
}

async function makeReadOnly(root: string): Promise<void> {
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      await makeReadOnly(path);
      await chmod(path, 0o555);
    } else {
      await chmod(path, 0o444);
    }
  }
  await chmod(root, 0o555);
}

function verifiedRelease(
  root: string,
  manifest: LocalReleaseManifest,
  digest: string,
): VerifiedLocalRelease {
  return {
    identity: { kind: manifest.kind, revision: manifest.revision, digest },
    path: root,
    entrypointPath: toNativePath(root, manifest.entrypoint),
    runtime: {
      version: manifest.runtime.version,
      architecture: manifest.runtime.architecture,
      path: toNativePath(root, manifest.runtime.path),
    },
    manifest,
  };
}

function validateRelativePath(path: string, description: string): void {
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
    throw new Error(`Local release ${description} is not a safe Windows-relative path: ${path}.`);
  }
}

function windowsPathKey(path: string): string {
  return path.normalize("NFKC").toLowerCase();
}

function toNativePath(root: string, relativePath: string): string {
  return join(root, ...relativePath.split("/"));
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!isRecord(value)) return value;
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) result[key] = canonicalValue(value[key]);
  return result;
}

function hasExactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === keys.length && actual.every((key, index) => key === keys[index]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasCode(error: unknown, code: string): boolean {
  return isRecord(error) && error.code === code;
}
