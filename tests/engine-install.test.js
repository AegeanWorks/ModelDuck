import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { discoverInstalled, downloadVerified, extractArchive, findBinary, installVariant, planInstall, readManifest, registerBuild, unregisterBuild } from "../src/engine-install.js";

const sha = (text) => createHash("sha256").update(text).digest("hex");

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "duck-engines-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const MANIFEST = {
  schema: 1,
  engines: {
    "llama.cpp": {
      // hygiene: allow a fixture address: fetch is injected, nothing is loaded
      source: "https://example.test/llama.cpp",
      license: "MIT",
      release: "b1",
      // hygiene: allow a fixture address: fetch is injected, nothing is loaded
      downloadBase: "https://example.test/dl",
      variants: {
        "win32-x64": {
          cpu: { asset: "cpu.zip", size: 3, sha256: sha("cpu-bytes") },
          vulkan: { asset: "vk.zip", size: 2, sha256: sha("vk-bytes") },
          cuda: { asset: "cu.zip", size: 2, sha256: sha("cu-bytes"), extra: [{ asset: "rt.zip", size: 2, sha256: sha("rt-bytes") }] },
        },
        "darwin-arm64": { metal: { asset: "mac.tar.gz", size: 1, sha256: sha("mac-bytes") } },
      },
    },
  },
};

test("the shipped manifest pins every asset to a SHA-256 and a release", async () => {
  const manifest = await readManifest(path.resolve("engines", "manifest.json"));
  const entry = manifest.engines["llama.cpp"];
  assert.equal(entry.license, "MIT");
  assert.match(entry.release, /^b\d+$/);
  for (const [platform, variants] of Object.entries(entry.variants)) {
    for (const [variant, spec] of Object.entries(variants)) {
      for (const asset of [spec, ...(spec.extra ?? [])]) {
        assert.match(asset.sha256, /^[0-9a-f]{64}$/, `${platform} ${variant} ${asset.asset}`);
        assert.ok(asset.size > 0);
        assert.ok(asset.asset.includes(entry.release) || asset.asset.startsWith("cudart-"), `${asset.asset} belongs to the pinned release`);
      }
    }
  }
  assert.ok(entry.variants["win32-x64"].vulkan && entry.variants["win32-x64"].cpu && entry.variants["linux-x64"].cpu);
});

test("a corrupt manifest says so with a Why and a Fix", async (t) => {
  const dir = tempDir(t);
  fs.writeFileSync(path.join(dir, "manifest.json"), "{ not json");
  await assert.rejects(() => readManifest(path.join(dir, "manifest.json")), (error) => error.code === "engine_manifest_bad" && Boolean(error.fix));
});

test("planning picks cpu and vulkan by default, every variant for macOS, and names assets with their download URL", () => {
  const plan = planInstall(MANIFEST, { platform: "win32", arch: "x64" });
  assert.deepEqual(plan.map((entry) => entry.variant), ["cpu", "vulkan"]);
  // hygiene: allow a fixture address: fetch is injected, nothing is loaded
  assert.equal(plan[0].assets[0].url, "https://example.test/dl/b1/cpu.zip");
  assert.equal(plan[0].dirName, "llama.cpp-cpu");
  assert.deepEqual(planInstall(MANIFEST, { platform: "darwin", arch: "arm64" }).map((entry) => entry.variant), ["metal"]);
  const cuda = planInstall(MANIFEST, { platform: "win32", arch: "x64", variants: ["cuda"] })[0];
  assert.deepEqual(cuda.assets.map((asset) => asset.name), ["cu.zip", "rt.zip"], "the CUDA runtime comes with the CUDA build");
});

test("planning refuses an unknown engine, platform or variant with what is available", () => {
  assert.throws(() => planInstall(MANIFEST, { engine: "vllm" }), (error) => error.code === "engine_unknown" && /llama\.cpp/.test(error.fix));
  assert.throws(() => planInstall(MANIFEST, { platform: "freebsd", arch: "x64" }), (error) => error.code === "engine_platform" && /--llama-server/.test(error.fix));
  assert.throws(() => planInstall(MANIFEST, { platform: "win32", arch: "x64", variants: ["metal"] }), (error) => error.code === "engine_variant" && /cpu, vulkan, cuda/.test(error.fix));
});

const respond = (bytes, status = 200) => async () => new Response(status === 200 ? bytes : null, { status });

test("a download is streamed to disk and kept only when its hash matches", async (t) => {
  const dir = tempDir(t);
  const dest = path.join(dir, "cache", "cpu.zip");
  // hygiene: allow a fixture address: fetch is injected, nothing is loaded
  const result = await downloadVerified({ url: "https://x/cpu.zip", sha256: sha("cpu-bytes"), dest, fetchImpl: respond("cpu-bytes") });
  assert.equal(result.bytes, 9);
  assert.equal(fs.readFileSync(dest, "utf8"), "cpu-bytes");
  assert.equal(fs.existsSync(`${dest}.part`), false, "no partial file is left behind");
});

test("a download with the wrong hash is deleted and refused, never unpacked", async (t) => {
  const dir = tempDir(t);
  const dest = path.join(dir, "cpu.zip");
  await assert.rejects(
    // hygiene: allow a fixture address: fetch is injected, nothing is loaded
    () => downloadVerified({ url: "https://x/cpu.zip", sha256: sha("cpu-bytes"), dest, fetchImpl: respond("tampered") }),
    (error) => error.code === "engine_checksum_mismatch" && /hashed to/.test(error.why) && Boolean(error.fix),
  );
  assert.equal(fs.existsSync(dest), false);
  assert.equal(fs.existsSync(`${dest}.part`), false);
});

test("a failed HTTP answer is a download error naming the URL", async (t) => {
  await assert.rejects(
    // hygiene: allow a fixture address: fetch is injected, nothing is loaded
    () => downloadVerified({ url: "https://x/missing.zip", sha256: "0", dest: path.join(tempDir(t), "m.zip"), fetchImpl: respond(null, 404) }),
    (error) => error.code === "engine_download_failed" && /404/.test(error.why),
  );
});

/** A body that sends `pieces` with `gapMs` between them, then (stall) never ends. */
const slowBody = (pieces, gapMs, { stall = false } = {}) => async (_url, { signal }) => {
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    async start(controller) {
      signal?.addEventListener("abort", () => controller.error(signal.reason ?? new Error("aborted")));
      for (const piece of pieces) {
        await new Promise((resolve) => setTimeout(resolve, gapMs));
        if (signal?.aborted) return;
        controller.enqueue(encoder.encode(piece));
      }
      if (!stall) controller.close();
    },
  });
  return new Response(body, { status: 200 });
};

test("a download that keeps moving is not cut off by a short idle limit, one that stalls is", async (t) => {
  const dir = tempDir(t);
  // hygiene: allow a fixture address: fetch is injected, nothing is loaded
  const moving = await downloadVerified({ url: "https://x/a.zip", sha256: sha("abcdef"), dest: path.join(dir, "a.zip"), fetchImpl: slowBody(["ab", "cd", "ef"], 30), idleMs: 120, retries: 0 });
  assert.equal(moving.bytes, 6, "total time (90 ms) passed the idle limit's neighbour but no gap did");
  await assert.rejects(
    // hygiene: allow a fixture address: fetch is injected, nothing is loaded
    () => downloadVerified({ url: "https://x/b.zip", sha256: sha("abcdef"), dest: path.join(dir, "b.zip"), fetchImpl: slowBody(["ab"], 10, { stall: true }), idleMs: 100, retries: 0 }),
    (error) => error.code === "engine_download_failed" && /no data/i.test(error.why) && Boolean(error.fix),
  );
  assert.equal(fs.existsSync(path.join(dir, "b.zip.part")), false);
});

test("a transient failure is retried, a refusal or a bad hash is not", async (t) => {
  const dir = tempDir(t);
  let calls = 0;
  const flaky = async (url, init) => {
    calls += 1;
    if (calls === 1) throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } });
    return respond("cpu-bytes")(url, init);
  };
  // hygiene: allow a fixture address: fetch is injected, nothing is loaded
  const result = await downloadVerified({ url: "https://x/cpu.zip", sha256: sha("cpu-bytes"), dest: path.join(dir, "cpu.zip"), fetchImpl: flaky, retries: 2, backoffMs: 1 });
  assert.equal(result.bytes, 9);
  assert.equal(calls, 2);
  let notFound = 0;
  await assert.rejects(
    // hygiene: allow a fixture address: fetch is injected, nothing is loaded
    () => downloadVerified({ url: "https://x/m.zip", sha256: "0", dest: path.join(dir, "m.zip"), fetchImpl: async () => { notFound += 1; return new Response(null, { status: 404 }); }, retries: 2, backoffMs: 1 }),
    (error) => error.code === "engine_download_failed",
  );
  assert.equal(notFound, 1, "a 404 is final");
  let serverError = 0;
  await assert.rejects(
    // hygiene: allow a fixture address: fetch is injected, nothing is loaded
    () => downloadVerified({ url: "https://x/s.zip", sha256: "0", dest: path.join(dir, "s.zip"), fetchImpl: async () => { serverError += 1; return new Response(null, { status: 503 }); }, retries: 2, backoffMs: 1 }),
    (error) => error.code === "engine_download_failed",
  );
  assert.equal(serverError, 3, "a 503 is tried again, then given up");
});

function fetchByUrl(files) {
  return async (url) => new Response(files[url.split("/").pop()] ?? null, { status: files[url.split("/").pop()] === undefined ? 404 : 200 });
}

const fakeExtract = (log) => async (file, dir) => {
  log.push(path.basename(file));
  fs.mkdirSync(path.join(dir, "inner"), { recursive: true });
  fs.writeFileSync(path.join(dir, "inner", "llama-server.exe"), path.basename(file));
};

test("installing downloads, verifies, unpacks beside the final place, renames in and records the install", async (t) => {
  const root = tempDir(t);
  const [cpu] = planInstall(MANIFEST, { platform: "win32", arch: "x64", variants: ["cpu"] });
  const log = [];
  const stages = [];
  const record = await installVariant(cpu, { root, fetchImpl: fetchByUrl({ "cpu.zip": "cpu-bytes" }), extract: fakeExtract(log), onProgress: (event) => stages.push(event.stage) });
  assert.deepEqual(stages, ["download", "extract"]);
  assert.equal(record.release, "b1");
  assert.deepEqual(record.assets, [{ name: "cpu.zip", sha256: sha("cpu-bytes") }]);
  const dir = path.join(root, "bin", "llama.cpp-cpu");
  assert.ok(fs.existsSync(path.join(dir, "install.json")));
  assert.equal(fs.existsSync(`${dir}.part`), false, "the working folder was renamed away");
  assert.equal(findBinary(dir, ["llama-server.exe"]), path.join(dir, "inner", "llama-server.exe"));
});

test("an engine already at the pinned release is kept, and a different release replaces it", async (t) => {
  const root = tempDir(t);
  const [cpu] = planInstall(MANIFEST, { platform: "win32", arch: "x64", variants: ["cpu"] });
  const log = [];
  await installVariant(cpu, { root, fetchImpl: fetchByUrl({ "cpu.zip": "cpu-bytes" }), extract: fakeExtract(log) });
  const again = await installVariant(cpu, { root, fetchImpl: async () => { throw new Error("must not download"); }, extract: fakeExtract(log) });
  assert.equal(again.skipped, true);
  assert.equal(log.length, 1);
  const newer = { ...cpu, release: "b2" };
  const replaced = await installVariant(newer, { root, fetchImpl: fetchByUrl({ "cpu.zip": "cpu-bytes" }), extract: fakeExtract(log) });
  assert.equal(replaced.release, "b2");
  assert.equal(log.length, 2);
});

test("a download that fails mid-install leaves nothing that looks installed", async (t) => {
  const root = tempDir(t);
  const [cuda] = planInstall(MANIFEST, { platform: "win32", arch: "x64", variants: ["cuda"] });
  // The CUDA build downloads fine; its runtime is tampered with.
  await assert.rejects(() => installVariant(cuda, { root, fetchImpl: fetchByUrl({ "cu.zip": "cu-bytes", "rt.zip": "BAD" }), extract: fakeExtract([]) }), (error) => error.code === "engine_checksum_mismatch");
  assert.deepEqual(discoverInstalled([root]), [], "no install record exists, so nothing is offered");
  assert.equal(fs.existsSync(path.join(root, "bin", "llama.cpp-cuda", "install.json")), false);
});

test("installed engines are found by their record, and a folder without one is ignored", async (t) => {
  const root = tempDir(t);
  const plan = planInstall(MANIFEST, { platform: "win32", arch: "x64" });
  for (const entry of plan) await installVariant(entry, { root, fetchImpl: fetchByUrl({ "cpu.zip": "cpu-bytes", "vk.zip": "vk-bytes" }), extract: fakeExtract([]) });
  fs.mkdirSync(path.join(root, "bin", "stray"), { recursive: true });
  fs.mkdirSync(path.join(root, "bin", "llama.cpp-cuda.part"), { recursive: true });
  const found = discoverInstalled([root, path.join(root, "nowhere")]);
  assert.deepEqual(found.map((entry) => `${entry.engine}:${entry.variant}`).sort(), ["llama.cpp:cpu", "llama.cpp:vulkan"]);
  assert.ok(found.every((entry) => entry.dir.startsWith(path.join(root, "bin"))));
});

test("archives are unpacked with the tool each platform has", async (t) => {
  const dir = tempDir(t);
  const calls = [];
  const run = async (command, args) => calls.push([command, ...args]);
  await extractArchive("C:\\x\\a.zip", path.join(dir, "o1"), { platform: "win32", run });
  await extractArchive("/x/a.zip", path.join(dir, "o2"), { platform: "linux", run });
  await extractArchive("/x/a.tar.gz", path.join(dir, "o3"), { platform: "linux", run });
  assert.equal(calls[0][0], "powershell.exe");
  assert.match(calls[0].at(-1), new RegExp(String.raw`^Expand-Archive -LiteralPath 'C:\\x\\a\.zip' -DestinationPath '.*o1' -Force$`), "the paths are in the command, not in $args");
  await extractArchive(String.raw`C:\Users\O'Neil\a.zip`, path.join(dir, "o4"), { platform: "win32", run });
  assert.ok(calls.at(-1).at(-1).includes(String.raw`-LiteralPath 'C:\Users\O''Neil\a.zip'`), "an apostrophe in a path cannot end the quoting early");
  calls.pop();
  assert.deepEqual(calls[1].slice(0, 3), ["unzip", "-o", "-q"]);
  assert.deepEqual(calls[2], ["tar", "-xzf", "/x/a.tar.gz", "-C", path.join(dir, "o3")]);
});

test("the install command lists the plan and refuses bad options with a Why and a Fix", async () => {
  const { main } = await import("../scripts/install-engines.mjs");
  const chunks = [];
  const out = { write: (text) => chunks.push(text) };
  assert.equal(await main(["--help"], out), 0);
  assert.match(chunks.join(""), /checks each file against the SHA-256/);
  chunks.length = 0;
  assert.equal(await main(["--list", "--variants", "cpu"], out), 0);
  assert.match(chunks.join(""), /llama\.cpp b\d+ cpu: /);
  await assert.rejects(() => main(["--variants"], out), (error) => error.code === "bad_option");
  await assert.rejects(() => main(["--bogus"], out), (error) => /--bogus/.test(error.why));
  await assert.rejects(() => main(["--list", "--variants", "tpu"], out), (error) => error.code === "engine_variant");
});

test("registering a build records where it lives and removing it forgets it", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "duck-reg-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const exe = path.join(root, "llama-server.exe");
  fs.writeFileSync(exe, "");
  const record = registerBuild({ root, name: "ik-llama", binary: exe, backend: "cpu", label: "ik_llama.cpp" });
  assert.equal(record.variant, "ik-llama");
  const found = discoverInstalled([root]);
  assert.equal(found.length, 1);
  assert.equal(found[0].binary, path.resolve(exe));
  assert.equal(found[0].backend, "cpu");
  assert.throws(() => registerBuild({ root, name: "x", binary: path.join(root, "missing.exe") }), (error) => error.code === "build_not_found");
  assert.throws(() => registerBuild({ root, name: "Bad Name!", binary: exe }), (error) => error.code === "bad_engine_name");
  assert.throws(() => registerBuild({ root, name: "vulkan", binary: exe }), (error) => error.code === "bad_engine_name", "a shipped variant name is taken");
  assert.equal(unregisterBuild({ root, name: "ik-llama" }), true);
  assert.equal(discoverInstalled([root]).length, 0);
  assert.equal(unregisterBuild({ root, name: "ik-llama" }), false);
});

test("a cached file that already matches its hash is reused, and a corrupt one is fetched again", async (t) => {
  const dir = tempDir(t);
  const dest = path.join(dir, "cpu.zip");
  fs.writeFileSync(dest, "cpu-bytes");
  const noNetwork = () => { throw new Error("must not download"); };
  // hygiene: allow a fixture address: fetch is injected, nothing is loaded
  const reused = await downloadVerified({ url: "https://x/cpu.zip", sha256: sha("cpu-bytes"), dest, fetchImpl: noNetwork });
  assert.deepEqual(reused, { bytes: 9, sha256: sha("cpu-bytes"), cached: true });
  fs.writeFileSync(dest, "half a fi");
  // hygiene: allow a fixture address: fetch is injected, nothing is loaded
  const fresh = await downloadVerified({ url: "https://x/cpu.zip", sha256: sha("cpu-bytes"), dest, fetchImpl: respond("cpu-bytes") });
  assert.equal(fresh.cached, undefined);
  assert.equal(fs.readFileSync(dest, "utf8"), "cpu-bytes");
});
