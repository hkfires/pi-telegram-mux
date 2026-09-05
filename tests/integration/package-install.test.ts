import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { expect, it } from "vitest";

it("loads a source-only package through the real Pi CLI without dist or devDependencies", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mux-package-install-"));
  let child: ChildProcess | undefined;
  try {
    const packageDir = path.join(dir, "package");
    const agentDir = path.join(dir, "agent");
    await fs.mkdir(packageDir);
    await fs.mkdir(agentDir);
    await fs.copyFile(path.resolve("package.json"), path.join(packageDir, "package.json"));
    await fs.cp(path.resolve("src"), path.join(packageDir, "src"), { recursive: true });
    await fs.writeFile(path.join(agentDir, "settings.json"), JSON.stringify({ packages: [packageDir] }));
    await expect(fs.access(path.join(packageDir, "dist"))).rejects.toThrow();
    await expect(fs.access(path.join(packageDir, "node_modules"))).rejects.toThrow();
    // Use the package's published bin, not private dist/core APIs. RPC startup loads
    // the extension but must not start Telegram transport or invoke an LLM.
    const piRoot = path.resolve("node_modules/@earendil-works/pi-coding-agent");
    const manifest = JSON.parse(await fs.readFile(path.join(piRoot, "package.json"), "utf-8"));
    child = spawn(process.execPath, [path.join(piRoot, manifest.bin.pi), "--mode", "rpc", "--no-session"], {
      cwd: dir,
      env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr!.setEncoding("utf-8");
    child.stderr!.on("data", chunk => { stderr += chunk; });
    const response = new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Pi RPC startup timeout: ${stderr}`)), 15_000);
      let buffer = "";
      child!.stdout!.setEncoding("utf-8");
      child!.stdout!.on("data", chunk => {
        buffer += chunk;
        let end: number;
        while ((end = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, end).trim();
          buffer = buffer.slice(end + 1);
          try {
            const message = JSON.parse(line);
            if (message.id === "package-smoke") { clearTimeout(timer); resolve(message); }
          } catch (error) {
            // RPC protocol boundary: malformed JSON is a test failure, not a
            // successful installation with silently ignored startup output.
            clearTimeout(timer); reject(error);
          }
        }
      });
      child!.once("error", error => { clearTimeout(timer); reject(error); });
      child!.once("exit", code => { clearTimeout(timer); reject(new Error(`Pi exited (${code}): ${stderr}`)); });
    });
    child.stdin!.write('{"id":"package-smoke","type":"get_commands"}\n');
    const result = await response;
    expect(result.success).toBe(true);
    expect(result.data.commands.filter((command: any) => command.name.startsWith("tg-")).map((command: any) => command.name).sort()).toEqual(["tg-connect", "tg-disconnect", "tg-setup", "tg-status"]);
    await expect(fs.access(path.join(agentDir, "pi-telegram-mux/runtime"))).rejects.toThrow();
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise(resolve => child!.once("exit", resolve));
      child.kill("SIGKILL");
      await exited;
    }
    await fs.rm(dir, { recursive: true, force: true });
  }
}, 20_000);
