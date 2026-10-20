import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { removeTempWorkspace, repoRoot } from "../helpers/workspace";

const execute = promisify(execFile);
const script = (name: string) => readFile(join(repoRoot, name), "utf8");
let sandbox = "",
  dist = "",
  archiveName = "",
  seq = 0;

const platformName = () => {
  const os = process.platform === "darwin" ? "darwin" : "linux",
    cpu = process.arch === "arm64" ? "arm64" : "x64";
  return `${os}-${cpu}`;
};
const nodeStub = (version: string) => `#!/bin/sh\n[ "$1" = "--version" ] && echo "${version}" && exit 0\nexit 0\n`;
// Records how it was started: which program it is, its arguments, and what PATH and cache it was given.
const npxStub = () =>
  `#!/bin/sh\n{ echo "args: $*"; echo "path: $PATH"; echo "cache: \${npm_config_cache:-}"; echo "node: $(command -v node)"; } >> "$NPX_LOG"\nexit 0\n`;

async function writeExecutable(path: string, content: string) {
  await writeFile(path, content);
  await chmod(path, 0o755);
}

async function publish(files: { shasumsHash?: string }) {
  const folder = join(dist, "latest-v24.x");
  await mkdir(folder, { recursive: true });
  const bytes = await readFile(join(sandbox, "pack", archiveName));
  const hash = files.shasumsHash ?? createHash("sha256").update(bytes).digest("hex");
  await writeFile(join(folder, archiveName), bytes);
  await writeFile(
    join(folder, "SHASUMS256.txt"),
    `${"0".repeat(64)}  node-v24.99.0-aix-ppc64.tar.gz\n${hash}  ${archiveName}\n${"1".repeat(64)}  node-v24.99.0-win-x64.zip\n`
  );
}

beforeAll(async () => {
  sandbox = await mkdtemp(join(tmpdir(), "wanderpage-installer-"));
  dist = join(sandbox, "dist");
  archiveName = `node-v24.99.0-${platformName()}.tar.gz`;
  // A stand-in official Node.js build: node-v24.99.0-<platform>/bin/{node,npx}.
  const pack = join(sandbox, "pack"),
    tree = join(pack, `node-v24.99.0-${platformName()}`, "bin");
  await mkdir(tree, { recursive: true });
  await writeExecutable(join(tree, "node"), nodeStub("v24.99.0"));
  await writeExecutable(join(tree, "npx"), npxStub());
  await execute("tar", ["-czf", join(pack, archiveName), "-C", pack, `node-v24.99.0-${platformName()}`]);
});
afterAll(async () => {
  if (sandbox) await removeTempWorkspace(sandbox);
});

// One isolated run: its own fake home folder, its own PATH shim folder, and the stand-in nodejs.org.
async function install(options: { systemNode?: string; args?: string[]; distUrl?: string; run?: string } = {}) {
  const run = options.run ?? join(sandbox, `run-${++seq}`),
    home = join(run, "home"),
    shims = join(run, "shims"),
    wanderpageHome = join(home, ".wanderpage"),
    log = join(run, "npx.log");
  await mkdir(shims, { recursive: true });
  await mkdir(home, { recursive: true });
  if (options.systemNode !== undefined) {
    await writeExecutable(join(shims, "node"), options.systemNode ? nodeStub(options.systemNode) : "#!/bin/sh\nexit 127\n");
    await writeExecutable(join(shims, "npx"), npxStub());
  }
  const result = await execute("/bin/sh", [join(repoRoot, "install.sh"), ...(options.args ?? [])], {
    env: {
      NODE_ENV: "test",
      HOME: home,
      PATH: `${shims}:/usr/bin:/bin`,
      TMPDIR: run,
      NPX_LOG: log,
      WANDERPAGE_NODE_BASE_URL: options.distUrl ?? `file://${dist}`,
    },
  })
    .then(({ stdout, stderr }) => ({ code: 0, stdout, stderr }))
    .catch((error: { code: number; stdout: string; stderr: string }) => ({ code: error.code, stdout: error.stdout, stderr: error.stderr }));
  const read = (path: string) => readFile(path, "utf8").catch(() => "");
  return {
    ...result,
    home,
    wanderpageHome,
    run,
    log: await read(log),
    tempLeftovers: (await readdir(run)).filter(entry => entry.startsWith("wanderpage-install.")),
  };
}

// @verifies DES-CLI-INSTALL, REQ-INST-1, REQ-INST-2, ARCH-CLI, SN-06
describe("one-line installer for macOS and Linux", () => {
  it("downloads a checksum-verified Node.js into the private folder when none exists, then starts Wanderpage with it", async () => {
    await publish({});
    const result = await install({ systemNode: "", args: ["my-trips", "--no-open"] });
    expect(result.code).toBe(0);
    const bin = join(result.wanderpageHome, "node-v24.99.0-" + platformName(), "bin");
    expect((await stat(join(bin, "node"))).isFile()).toBe(true);
    const log = result.log;
    expect(log).toContain("args: --yes @buildproven/wanderpage my-trips --no-open");
    expect(log).toContain(`path: ${bin}:`);
    expect(log).toContain(`node: ${join(bin, "node")}`);
    expect(log).toContain(`cache: ${join(result.wanderpageHome, "npm-cache")}`);
    expect(result.tempLeftovers).toEqual([]);
  });

  it("replaces a system Node.js that is older than 24", async () => {
    await publish({});
    const result = await install({ systemNode: "v22.12.0" });
    expect(result.code).toBe(0);
    expect(await readdir(result.wanderpageHome)).toContain("node-v24.99.0-" + platformName());
    expect(result.log).toContain("node: " + join(result.wanderpageHome, "node-v24.99.0-" + platformName(), "bin", "node"));
  });

  it("uses a suitable system Node.js as is, downloading nothing and creating no private folder", async () => {
    const result = await install({ systemNode: "v24.18.0", args: ["--no-open"], distUrl: "file:///nonexistent" });
    expect(result.code).toBe(0);
    expect(result.log).toContain("args: --yes @buildproven/wanderpage --no-open");
    expect(result.log).toContain("cache: \n");
    await expect(stat(result.wanderpageHome)).rejects.toThrow();
  });

  it("reuses the private Node.js from an earlier run instead of downloading again", async () => {
    await publish({});
    const first = await install({ systemNode: "" });
    expect(first.code).toBe(0);
    // Second run in the same home, with an unreachable nodejs.org so any download would fail.
    const second = await install({ systemNode: "", distUrl: "file:///nonexistent", run: first.run });
    expect(second.code).toBe(0);
    expect(second.stdout).toContain("Starting Wanderpage with the Node.js in");
    expect(second.stdout).not.toContain("Downloading");
  });

  it("installs nothing and starts nothing when the download does not match its published checksum", async () => {
    await publish({ shasumsHash: "f".repeat(64) });
    const result = await install({ systemNode: "" });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("did not match its published checksum");
    await expect(stat(join(result.wanderpageHome, "node-v24.99.0-" + platformName()))).rejects.toThrow();
    expect(result.tempLeftovers).toEqual([]);
    expect(result.log).toBe("");
  });

  it("explains an unreachable nodejs.org without starting anything", async () => {
    const result = await install({ systemNode: "", distUrl: "file:///nonexistent" });
    expect(result.code).toBe(1);
    expect(result.log).toBe("");
    expect(result.stderr).toContain("could not download the Node.js checksum list");
    expect(result.tempLeftovers).toEqual([]);
  });

  it("fails clearly when nodejs.org lists no build for this platform", async () => {
    const folder = join(dist, "latest-v24.x");
    const backup = await readFile(join(folder, "SHASUMS256.txt"), "utf8");
    await writeFile(join(folder, "SHASUMS256.txt"), `${"0".repeat(64)}  node-v24.99.0-aix-ppc64.tar.gz\n`);
    const result = await install({ systemNode: "" });
    await writeFile(join(folder, "SHASUMS256.txt"), backup);
    expect(result.log).toBe("");
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("lists no Node.js build for");
  });

  it("changes nothing outside the private folder: no shell profile, no PATH, no system setting", async () => {
    await publish({});
    const result = await install({ systemNode: "" });
    expect(result.code).toBe(0);
    expect((await readdir(result.home)).sort()).toEqual([".wanderpage"]);
    for (const file of ["install.sh", "install.ps1"]) {
      const text = await script(file);
      expect(text).not.toMatch(
        /\.(?:bashrc|bash_profile|zshrc|zprofile|profile)\b|\/etc\/(?:paths|profile|environment)|\bsudo\b|\/usr\/local/
      );
      expect(text).not.toMatch(/SetEnvironmentVariable|\bsetx\b|HKLM|HKCU|Set-ItemProperty|\[Environment\]/);
    }
  });
});

// PowerShell is not available on the macOS/Linux machines that run this suite, so the Windows script is checked for the same contract in text.
// @verifies DES-CLI-INSTALL, REQ-INST-1, REQ-INST-2
describe("one-line installer for Windows", () => {
  it("verifies the SHA-256 of the download before unpacking it into the private folder", async () => {
    const text = await script("install.ps1");
    expect(text).toContain("SHASUMS256.txt");
    expect(text).toContain("Get-FileHash -Algorithm SHA256");
    expect(text.indexOf("Get-FileHash")).toBeLessThan(text.indexOf("Expand-Archive"));
    expect(text).toMatch(/if \(\$actual -ne \$expected\) \{ throw/);
    expect(text).toContain(".wanderpage");
    expect(text).toContain("latest-v$NodeMajor.x");
    expect(text).toContain("@buildproven/wanderpage");
  });

  it("only changes this session's PATH and never exits the user's PowerShell window", async () => {
    const text = await script("install.ps1");
    expect(text).toContain('$env:PATH = "$bin;$env:PATH"');
    expect(text).not.toMatch(/^\s*exit\b/m);
  });

  it("requires the same Node.js major as the launcher", async () => {
    const launcher = await readFile(join(repoRoot, "bin/local-edition.js"), "utf8"),
      floor = /Number\(version\.split\("\."\)\[0\]\) >= (\d+)/.exec(launcher)?.[1];
    expect(floor).toBe("24");
    expect(await script("install.ps1")).toContain(`$NodeMajor = ${floor}`);
    expect(await script("install.sh")).toContain(`NODE_MAJOR=${floor}`);
  });
});
