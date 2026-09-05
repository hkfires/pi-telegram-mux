import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { expect, it } from "vitest";
import { saveConfig } from "../../src/config.js";
import { testConfig } from "../helpers.js";

it.each(["transformed", "config", "follow-up", "reconnect"])("uses real Pi 0.85 lifecycle for %s without Telegram or model networking", async scenario => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mux-pi-lifecycle-"));
  let child: ChildProcess | undefined;
  try {
    const source = path.join(dir, "src");
    const agentDir = path.join(dir, "agent");
    await fs.cp(path.resolve("src"), source, { recursive: true });
    const extension = path.join(source, "lifecycle.ts");
    await fs.copyFile(path.resolve("tests/integration/pi-lifecycle-extension.ts"), extension);
    await saveConfig(agentDir, testConfig);
    await fs.writeFile(path.join(agentDir, "settings.json"), JSON.stringify({ extensions: [extension], defaultProvider: "mux-review", defaultModel: "fake" }));
    const piRoot = path.resolve("node_modules/@earendil-works/pi-coding-agent");
    const manifest = JSON.parse(await fs.readFile(path.join(piRoot, "package.json"), "utf-8"));
    child = spawn(process.execPath, [path.join(piRoot, manifest.bin.pi), "--mode", "rpc"], {
      cwd: dir, env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", MUX_REVIEW_SCENARIO: scenario }, stdio: ["pipe", "pipe", "pipe"],
    });
    let stderr = "";
    const messages: unknown[] = [];
    child.stderr!.setEncoding("utf8");
    child.stderr!.on("data", chunk => { stderr += chunk; });
    const result = await new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Pi lifecycle timeout: ${stderr}\n${JSON.stringify(messages)}`)), 15_000);
      let buffer = "";
      child!.stdout!.setEncoding("utf8");
      child!.stdout!.on("data", chunk => {
        buffer += chunk;
        let end: number;
        while ((end = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, end).trim();
          buffer = buffer.slice(end + 1);
          if (!line) continue;
          try {
            let message = JSON.parse(line);
            messages.push(message);
            if (message.type === "extension_ui_request" && message.method === "notify" && message.message.startsWith('{"type":"mux_review_result"')) message = JSON.parse(message.message);
            if (message.type === "extension_error" || (message.type === "response" && message.success === false)) throw new Error(JSON.stringify(message));
            if (message.type === "mux_review_result") { clearTimeout(timer); resolve(message); }
          } catch (error) {
            // Test protocol boundary: malformed JSON and extension failures fail
            // the test; they are never treated as harmless startup notices.
            clearTimeout(timer); reject(error);
          }
        }
      });
      child!.once("error", error => { clearTimeout(timer); reject(error); });
      child!.once("exit", code => { clearTimeout(timer); reject(new Error(`Pi exited (${code}): ${stderr}`)); });
      child!.stdin!.write(JSON.stringify({ type: "prompt", message: scenario === "follow-up" ? "local-one" : scenario === "reconnect" ? "/review-reconnect" : "/review-inbound" }) + "\n");
    });
    expect(result.error).toBeUndefined();
    expect(result.idle).toBe(true);
    expect(result.starts).toBe(1);
    if (scenario === "follow-up") {
      expect(result.received).toEqual(["local-one", "local-follow-up"]);
      expect(result.texts).toEqual(["🧑‍💻 [Prompt]\nlocal-one", "🧑‍💻 [Prompt]\nlocal-follow-up", "answer 2"]);
    } else if (scenario === "reconnect") {
      expect(result.received).toEqual(["ready task"]);
      expect(result.texts).toEqual(["answer 1"]);
      expect(result.admitted).toEqual({ accepted: true, busy: false });
      expect(result.feedback).toEqual(["Current session is busy. Please try again later."]);
    } else {
      expect(result.received).toEqual(["completely transformed"]);
      expect(result.admitted.accepted).toBe(scenario !== "config");
      expect(result.texts).toEqual(scenario === "config" ? [] : ["answer 1"]);
    }
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise(resolve => child!.once("exit", resolve));
      child.kill("SIGKILL");
      await exited;
    }
    await fs.rm(dir, { recursive: true, force: true });
  }
}, 20_000);
