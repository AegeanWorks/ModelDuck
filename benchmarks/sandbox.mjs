/**
 * What the test sandbox can rely on, by Node version. Generated code runs in a
 * child Node process under the permission model with no allow flags.
 *
 * - The flag is `--permission` from Node 22.13 and 23.5; earlier releases
 *   (Node 20 included) only know `--experimental-permission`, and an unknown
 *   flag would make every check fail with "did not run".
 * - File system, child process and worker access are denied on every
 *   supported version. Network access is denied only from Node 25; before
 *   that, sandboxed code can open sockets.
 */

const parse = (version) => String(version ?? "").replace(/^v/, "").split(".").map((part) => Number.parseInt(part, 10) || 0);

/** The permission flag this Node version understands. */
export function sandboxFlag(version = process.versions.node) {
  const [major, minor] = parse(version);
  const stable = major > 23 || (major === 23 && minor >= 5) || (major === 22 && minor >= 13);
  return stable ? "--permission" : "--experimental-permission";
}

/** Whether the permission model on this Node version also denies network access. */
export function networkDenied(version = process.versions.node) {
  return parse(version)[0] >= 25;
}

/** Variables libuv copies from the parent on Windows whenever a child's environment lacks them. */
const WINDOWS_REQUIRED = Object.freeze(["HOMEDRIVE", "HOMEPATH", "LOGONSERVER", "PATH", "SYSTEMDRIVE", "TEMP", "USERDOMAIN", "USERNAME", "USERPROFILE", "WINDIR"]);

/**
 * The environment the child gets, since a check's output is returned to the
 * caller. Elsewhere it is empty. On Windows, libuv refills the variables above
 * from the parent when they are missing, so each is set to a neutral value
 * instead: no user name, profile path, PATH or token reaches the child, and
 * SystemRoot (which Node needs to start) is kept.
 */
export function sandboxEnv(env = process.env, platform = process.platform) {
  if (platform !== "win32") return {};
  const key = Object.keys(env).find((name) => name.toLowerCase() === "systemroot");
  const root = key ? env[key] : "C:\\Windows";
  const neutral = Object.fromEntries(WINDOWS_REQUIRED.map((name) => [name, "sandbox"]));
  return { ...neutral, SystemRoot: root, WINDIR: root, SYSTEMDRIVE: root.slice(0, 2), TEMP: `${root}\\Temp` };
}

/** Heap cap for the child, in MB: generous for test functions, small enough to protect the host. */
export const SANDBOX_HEAP_MB = 256;
