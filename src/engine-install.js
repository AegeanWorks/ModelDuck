import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";

import { AppError } from "./errors.js";
import { readJsonWithQuarantine, writeJsonAtomic } from "./fs-atomic.js";

/**
 * Installing the engines ModelDuck ships (ADR-157). The manifest pins each
 * engine to a release and every asset to its SHA-256; an asset is downloaded
 * as a stream, hashed as it arrives, and unpacked only when the hash matches.
 * A variant is unpacked beside its final place and renamed into it, so an
 * interrupted install never leaves a half-unpacked engine that looks installed.
 */

const execFileAsync = promisify(execFile);

export const DEFAULT_VARIANTS = Object.freeze({ win32: ["cpu", "vulkan"], linux: ["cpu", "vulkan"], darwin: null });

export async function readManifest(file) {
  const manifest = await readJsonWithQuarantine(file, null);
  if (!manifest || manifest.schema !== 1 || !manifest.engines) {
    throw new AppError("The engine manifest is unreadable", { code: "engine_manifest_bad", why: `${file} is missing, corrupt or from a newer version.`, fix: "Restore engines/manifest.json from the ModelDuck release." });
  }
  return manifest;
}

/**
 * What to install for one engine on this platform: one entry per variant with
 * every asset it needs. `variants: null` means every variant the platform has.
 */
export function planInstall(manifest, { engine = "llama.cpp", platform = process.platform, arch = process.arch, variants = null } = {}) {
  const entry = manifest.engines[engine];
  if (!entry) {
    throw new AppError("Unknown engine", { code: "engine_unknown", why: `${engine} is not in the manifest.`, fix: `Use one of: ${Object.keys(manifest.engines).join(", ")}.` });
  }
  const key = `${platform}-${arch}`;
  const available = entry.variants[key];
  if (!available) {
    throw new AppError("No prebuilt engine for this machine", { code: "engine_platform", why: `${engine} ${entry.release} has no build for ${key}.`, fix: `Build llama.cpp yourself and pass --llama-server <file>. Prebuilt: ${Object.keys(entry.variants).join(", ")}.` });
  }
  const wanted = variants ?? DEFAULT_VARIANTS[platform] ?? Object.keys(available);
  const unknown = wanted.filter((variant) => !available[variant]);
  if (unknown.length) {
    throw new AppError("Unknown engine variant", { code: "engine_variant", why: `${unknown.join(", ")} is not built for ${key}.`, fix: `Use any of: ${Object.keys(available).join(", ")}.` });
  }
  return wanted.map((variant) => {
    const spec = available[variant];
    const assets = [spec, ...(spec.extra ?? [])].map((asset) => ({ name: asset.asset, size: asset.size, sha256: asset.sha256, url: `${entry.downloadBase}/${entry.release}/${asset.asset}` }));
    return { engine, variant, release: entry.release, license: entry.license, source: entry.source, assets, dirName: `${engine}-${variant}` };
  });
}

/** Stream `url` to `dest`, hashing as it arrives; a wrong hash deletes the file and refuses. */
export async function downloadVerified({ url, sha256, dest, fetchImpl = globalThis.fetch, timeoutMs = 600_000 }) {
  await fs.promises.mkdir(path.dirname(dest), { recursive: true });
  const part = `${dest}.part`;
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs), redirect: "follow" });
  if (!response.ok || !response.body) {
    throw new AppError("The engine download failed", { code: "engine_download_failed", why: `${url} answered ${response.status}.`, fix: "Check the connection, or download the file by hand and put it in engines/.cache." });
  }
  const hash = createHash("sha256");
  let bytes = 0;
  const meter = new Transform({
    transform(chunk, _encoding, done) {
      hash.update(chunk);
      bytes += chunk.length;
      done(null, chunk);
    },
  });
  const out = fs.createWriteStream(part);
  try {
    await pipeline(Readable.fromWeb(response.body), meter, out);
    const fd = await fs.promises.open(part, "r+");
    await fd.sync();
    await fd.close();
  } catch (error) {
    await fs.promises.rm(part, { force: true });
    throw error;
  }
  const actual = hash.digest("hex");
  if (actual !== sha256) {
    await fs.promises.rm(part, { force: true });
    throw new AppError("The engine download does not match its checksum", { code: "engine_checksum_mismatch", why: `${path.basename(dest)} hashed to ${actual}, expected ${sha256}; the file was deleted.`, fix: "Try again; if it repeats, the release changed and the manifest needs a new pin." });
  }
  await fs.promises.rename(part, dest);
  return { bytes, sha256: actual };
}

/** Unpack a .zip or .tar.gz into `dir`. */
export async function extractArchive(file, dir, { platform = process.platform, run = (cmd, args) => execFileAsync(cmd, args, { maxBuffer: 16 * 1024 * 1024, windowsHide: true }) } = {}) {
  await fs.promises.mkdir(dir, { recursive: true });
  if (file.endsWith(".zip")) {
    if (platform === "win32") {
      // -Command does not hand trailing arguments to $args, so the paths are quoted into the command.
      const quoted = (value) => `'${String(value).replaceAll("'", "''")}'`;
      await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `Expand-Archive -LiteralPath ${quoted(file)} -DestinationPath ${quoted(dir)} -Force`]);
    } else {
      await run("unzip", ["-o", "-q", file, "-d", dir]);
    }
  } else {
    await run("tar", ["-xzf", file, "-C", dir]);
  }
}

const sameInstall = (record, entry) => record?.release === entry.release && record?.variant === entry.variant && record?.engine === entry.engine;

/**
 * Install one planned variant under `<root>/bin/<dirName>` and return its record.
 * An install that already matches the pinned release is left alone.
 */
export async function installVariant(entry, { root, fetchImpl, extract = extractArchive, onProgress = () => {} }) {
  const finalDir = path.join(root, "bin", entry.dirName);
  const existing = await readJsonWithQuarantine(path.join(finalDir, "install.json"), null);
  if (sameInstall(existing, entry)) {
    onProgress({ stage: "present", entry });
    return { ...existing, skipped: true };
  }
  const work = `${finalDir}.part`;
  await fs.promises.rm(work, { recursive: true, force: true });
  for (const asset of entry.assets) {
    const cached = path.join(root, ".cache", asset.name);
    onProgress({ stage: "download", entry, asset: asset.name, size: asset.size });
    await downloadVerified({ url: asset.url, sha256: asset.sha256, dest: cached, fetchImpl });
    onProgress({ stage: "extract", entry, asset: asset.name });
    await extract(cached, work);
  }
  const record = { engine: entry.engine, variant: entry.variant, release: entry.release, license: entry.license, source: entry.source, assets: entry.assets.map(({ name, sha256 }) => ({ name, sha256 })), installedAt: new Date().toISOString() };
  await writeJsonAtomic(path.join(work, "install.json"), record);
  await fs.promises.rm(finalDir, { recursive: true, force: true });
  await fs.promises.rename(work, finalDir);
  return record;
}

/** The first file called one of `names` within `depth` folders of `dir`. */
export function findBinary(dir, names, depth = 2) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  const hit = entries.find((entry) => entry.isFile() && names.includes(entry.name));
  if (hit) return path.join(dir, hit.name);
  if (depth <= 0) return null;
  for (const entry of entries.filter((item) => item.isDirectory())) {
    const found = findBinary(path.join(dir, entry.name), names, depth - 1);
    if (found) return found;
  }
  return null;
}

/** Installed engine variants found under any of `roots` (each holds `bin/<engine>-<variant>/install.json`). */
export function discoverInstalled(roots, { read = (file) => JSON.parse(fs.readFileSync(file, "utf8")) } = {}) {
  const found = [];
  for (const root of roots) {
    const bin = path.join(root, "bin");
    let names;
    try {
      names = fs.readdirSync(bin);
    } catch {
      continue;
    }
    for (const name of names) {
      try {
        const record = read(path.join(bin, name, "install.json"));
        if (record?.engine && record?.variant) found.push({ ...record, dir: path.join(bin, name) });
      } catch {
        // A folder without a readable record is not an install (for example a half-unpacked .part).
      }
    }
  }
  return found;
}

const SHIPPED_VARIANTS = new Set(["cpu", "vulkan", "cuda", "metal", "hip", "sycl", "opencl"]);

/**
 * Registers a llama.cpp-family `llama-server` build that lives elsewhere (ik_llama.cpp, BitNet, a
 * llamafile server...) as its own engine. Nothing is copied: the record names the file, so the
 * build is assessed, tuned on, and served like an installed one.
 */
export function registerBuild({ root, name, binary, backend = null, label = null }) {
  if (!/^[a-z0-9][a-z0-9._-]{0,39}$/.test(name ?? "") || SHIPPED_VARIANTS.has(name)) {
    throw new AppError("Bad engine name", { code: "bad_engine_name", why: `"${name}" must be 1-40 lowercase letters, digits, dots or dashes and not one of ${[...SHIPPED_VARIANTS].join(", ")}.`, fix: "Pick a name such as ik-llama." });
  }
  const file = path.resolve(binary ?? "");
  if (!binary || !fs.statSync(file, { throwIfNoEntry: false })?.isFile()) {
    throw new AppError("Build not found", { code: "build_not_found", why: `${binary ?? "(no file)"} is not a file.`, fix: "Pass the llama-server executable of the build with --binary." });
  }
  const record = { engine: "llama.cpp", variant: name, release: label ?? name, binary: file, backend, label, registered: true };
  const dir = path.join(root, "bin", `llama.cpp-${name}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "install.json"), `${JSON.stringify(record, null, 2)}\n`);
  return record;
}

/** Forgets a registered build; the build's own files are never touched. Returns whether one was registered. */
export function unregisterBuild({ root, name }) {
  const dir = path.join(root, "bin", `llama.cpp-${name}`);
  try {
    if (!JSON.parse(fs.readFileSync(path.join(dir, "install.json"), "utf8")).registered) return false;
  } catch {
    return false;
  }
  fs.rmSync(dir, { recursive: true, force: true });
  return true;
}
