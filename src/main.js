import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { APP_NAME, VERSION, isLoopbackHost, parseArgs, resolvePaths } from "./config.js";
import { BenchmarkRunner } from "./benchmark-runner.js";
import { TunedSettings } from "./tuned-settings.js";
import { TuneScheduler } from "./tune-scheduler.js";
import { DownloadManager } from "./downloader.js";
import { LlamaEngine } from "./engine.js";
import { AppError } from "./errors.js";
import { acquireHomeLock, ensureDirectory } from "./fs-atomic.js";
import { JitManager } from "./jit.js";
import { createModelRegistry } from "./model-registry.js";
import { createHttpServer } from "./server.js";
import { ServerSettingsStore } from "./server-settings.js";
import { SettingsStore } from "./settings.js";
import { systemInfo } from "./system.js";

const HELP = `${APP_NAME} ${VERSION}

Run a GGUF model locally and manage it in your browser.

Usage:
  npm start -- [options]
  node src/main.js [options]

Options:
  --port <number>    Port to listen on (default: saved server setting, else 4141)
  --host <address>   Address to bind (default: loopback; LAN requires Serve on Local Network)
  --home <folder>    Data folder (default: ~/.modelduck)
  --models <folder>  Model folder (default: <home>/models)
  --no-open          Do not open the browser automatically
  -h, --help         Show this help
  -v, --version      Show the version

Environment:
  MODELDUCK_HOME     Same as --home
  MODELDUCK_PORT     Same as --port
  MODELDUCK_GPU      Set to "auto" to let node-llama-cpp use a detected GPU
`;

function openBrowser(url, logger) {
  if (process.platform === "win32") {
    const candidates = [
      process.env["ProgramFiles(x86)"] &&
        path.join(process.env["ProgramFiles(x86)"], "Microsoft", "Edge", "Application", "msedge.exe"),
      process.env.ProgramFiles &&
        path.join(process.env.ProgramFiles, "Microsoft", "Edge", "Application", "msedge.exe"),
      process.env.ProgramFiles &&
        path.join(process.env.ProgramFiles, "Google", "Chrome", "Application", "chrome.exe"),
      process.env["ProgramFiles(x86)"] &&
        path.join(process.env["ProgramFiles(x86)"], "Google", "Chrome", "Application", "chrome.exe"),
      process.env.LOCALAPPDATA &&
        path.join(process.env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe"),
    ].filter(Boolean);
    const executable = candidates.find((candidate) => fs.existsSync(candidate));
    if (executable) {
      execFile(
        executable,
        [`--app=${url}`, "--window-size=1440,900", "--no-first-run"],
        (error) => {
          if (error) logger.warn?.(`[modelduck] Could not open the app window: ${error.message}`);
        },
      );
      return;
    }
  }

  const command =
    process.platform === "win32" ? "cmd.exe" : process.platform === "darwin" ? "open" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  execFile(command, args, (error) => {
    if (error) logger.warn?.(`[modelduck] Could not open the browser: ${error.message}`);
  });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(HELP);
    return;
  }
  if (options.version) {
    process.stdout.write(`${VERSION}\n`);
    return;
  }

  const paths = resolvePaths({ home: options.home, models: options.models });
  await ensureDirectory(paths.home);
  await ensureDirectory(paths.models);
  await ensureDirectory(paths.downloads);
  const lock = await acquireHomeLock(paths.lock);

  const serverSettings = new ServerSettingsStore({ file: paths.serverSettings });
  await serverSettings.load();
  const host = options.hostExplicit
    ? options.host
    : serverSettings.value.serveOnLocalNetwork
      ? "0.0.0.0"
      : "127.0.0.1";
  const port = options.portExplicit ? options.port : serverSettings.value.port;
  if (!isLoopbackHost(host) && !serverSettings.value.serveOnLocalNetwork) {
    throw new AppError("Refusing to bind a public address", {
      code: "unsafe_host",
      why: "Serving on the local network is disabled in Server settings.",
      fix: "Enable Serve on Local Network in the app, or bind 127.0.0.1.",
    });
  }

  const settings = new SettingsStore({ file: paths.settings });
  await settings.load();

  const registry = createModelRegistry({ modelsDir: paths.models });
  const downloads = new DownloadManager({ modelsDir: paths.models });
  const engine = new LlamaEngine({ registry });
  await registry.scan();
  const tuned = new TunedSettings({ profilesDir: paths.profiles, registry, settings });
  const jit = new JitManager({ engine, registry, settings, serverSettings, tuned });
  const benchmarks = new BenchmarkRunner({ modelsDir: paths.models, homeDir: paths.home });
  const tunes = new TuneScheduler({ homeDir: paths.home, modelsDir: paths.models, profilesDir: paths.profiles, tuneStepsFile: paths.tuneGrid, queueFile: path.join(paths.home, "tune-queue.json") });
  await tunes.restore();

  const instanceInfo = {};
  const server = createHttpServer({
    settings,
    registry,
    engine,
    downloads,
    serverSettings,
    jit,
    benchmarks,
    tunes,
    profilesDir: paths.profiles,
    tuneRunsDir: paths.tuneRuns,
    tuneStepsFile: paths.tuneGrid,
    instance: instanceInfo,
  });
  const info = systemInfo();

  // IDEA-1077: fall back to an ephemeral port when the saved one is taken,
  // unless the operator named a port explicitly.
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, resolve);
    });
  } catch (error) {
    if (error?.code !== "EADDRINUSE" || options.portExplicit) throw error;
    console.warn?.(`[modelduck] Port ${port} is in use; falling back to an ephemeral port.`);
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, host, resolve);
    });
  }

  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  // IDEA-1077: startup receipt so a second process (or the UI) finds this one.
  Object.assign(instanceInfo, { host, port: actualPort, pid: process.pid, startedAt: new Date().toISOString() });
  await fs.promises.writeFile(path.join(paths.home, "server.json"), JSON.stringify(instanceInfo, null, 2)).catch(() => {});
  const displayHost = host === "0.0.0.0" ? "127.0.0.1" : host;
  // hygiene: allow local loopback URL printed to the user
  const url = `http://${displayHost}:${actualPort}`;
  process.stdout.write(
    [
      "",
      `  ${APP_NAME} ${VERSION} is ready`,
      `  ${url}`,
      host === "0.0.0.0" ? `  LAN      http://<this-computer-ip>:${actualPort}` : "",
      "",
      `  Models   ${paths.models}`,
      `  Data     ${paths.home}`,
      `  CPU      ${info.cpu} (${info.parallelism} threads)`,
      `  Node     ${info.node}`,
      `  Auth     ${serverSettings.value.requireAuth ? "required" : "off"}`,
      "",
      "  Press Ctrl+C to stop.",
      "",
    ]
      .filter(Boolean)
      .join("\n"),
  );

  if (registry.size === 0) {
    process.stdout.write(
      "  No models yet. Open the Models panel in the app to download one, or copy a .gguf file into the folder above.\n\n",
    );
  }

  if (options.open) {
    setTimeout(() => openBrowser(url, console), 300).unref?.();
  }

  let closing = false;
  const shutdown = async (signal) => {
    if (closing) return;
    closing = true;
    process.stdout.write(`\n[modelduck] ${signal} received, shutting down...\n`);
    const closed = new Promise((resolve) => server.close(resolve));
    server.closeAllConnections?.();
    await closed;
    for (const download of downloads.list()) {
      if (download.status === "downloading" || download.status === "queued") {
        await downloads.cancel(download.id).catch(() => {});
      }
    }
    await engine.dispose().catch(() => {});
    jit.dispose();
    benchmarks.dispose();
    tunes.dispose();
    await lock.release().catch(() => {});
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("uncaughtException", (error) => {
    process.stderr.write(`[modelduck] Uncaught error: ${error?.stack || error}\n`);
    process.exit(1);
  });
  process.on("unhandledRejection", (error) => {
    process.stderr.write(`[modelduck] Unhandled rejection: ${error?.stack || error}\n`);
  });
}

main().catch((error) => {
  if (error instanceof AppError) {
    process.stderr.write(
      `\n[modelduck] ${error.message}\n  Why: ${error.why}\n  Fix: ${error.fix}\n\n`,
    );
  } else if (error?.code === "EADDRINUSE") {
    process.stderr.write(
      "\n[modelduck] That port is already in use.\n" +
        "  Why: another program (possibly another ModelDuck) is listening there.\n" +
        "  Fix: close it, or run with --port 4142.\n\n",
    );
  } else {
    process.stderr.write(`\n[modelduck] ${error?.stack || error}\n\n`);
  }
  process.exit(1);
});
