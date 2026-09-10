import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { expect, it } from "vitest";
import { saveConfig } from "../../src/config.js";
import { testConfig } from "../helpers.js";

it.each([
  ...["image", "text"].flatMap(kind => ["before", "after"].map(stage => `overlap-${kind}-${stage}`)),
  ...["image", "text"].flatMap(kind => ["before-check", "after-check", "shutdown", "timeout"].map(stage => `reload-${kind}-${stage}`)),
  "terminal-admission", "terminal-admission-unknown", "stop-input-before", "stop-input-after", "stop-start", "album", "album-read", "transformed", "config", "follow-up", "length-follow-up", "reconnect", "busy-follow-up-model", "busy-steer-model", "busy-concurrent-input-gate"])("uses real Pi 0.85 lifecycle for %s without Telegram or model networking", async scenario => {
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
    const setupReplies = [
      { method: "select", title: "Telegram Settings", value: "Connection Settings" },
      { method: "input", title: "Bot Token:", value: testConfig.botToken },
      { method: "input", title: "Forum Supergroup Chat ID:", value: "-100999" },
      { method: "input", title: "Allowed User ID:", value: "999" },
      { method: "select", title: "Telegram Settings", cancelled: true },
    ];
    let setupReplyIndex = 0;
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
            if (message.type === "extension_ui_request" && ["select", "input"].includes(message.method)) {
              // Drive the real menu dialogs through Pi's RPC UI protocol.
              const reply = setupReplies[setupReplyIndex++];
              if (scenario !== "config" || !reply || message.method !== reply.method || message.title !== reply.title) {
                throw new Error("Unexpected setup dialog");
              }
              child!.stdin!.write(JSON.stringify({ type: "extension_ui_response", id: message.id, value: reply.value, cancelled: reply.cancelled }) + "\n");
            }
            if (message.type === "extension_ui_request" && message.method === "notify" && message.message.startsWith('{"type":"mux_review_result"')) message = JSON.parse(message.message);
            // Pi's void submission API reports the rejected obsolete start via
            // this stable event. It must remain visible, not terminate the live run.
            if (scenario.startsWith("overlap-") && message.type === "extension_error" && message.event === "send_user_message" && message.extensionPath === "<runtime>") continue;
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
      child!.stdin!.write(JSON.stringify({ type: "prompt", message: scenario === "follow-up" || scenario === "length-follow-up" || scenario.startsWith("busy-") ? "local-one" : scenario === "reconnect" ? "/review-reconnect" : "/review-inbound" }) + "\n");
    });
    expect(result.error).toBeUndefined();
    expect(setupReplyIndex).toBe(scenario === "config" ? setupReplies.length : 0);
    expect(result.idle).toBe(true);
    if (scenario.startsWith("overlap-")) {
      expect(result.keptRun).toBe(true);
      expect(result.prematureIdle).toBe(false);
      expect(result.providerStillPending).toBe(true);
      expect(result.modelInputs).toEqual([["surviving task"]]);
      expect(result.modelImageCounts).toEqual([0]);
      expect(result.texts).toEqual(["answer 1"]);
      expect(messages.filter((message: any) => message.type === "extension_error")).toHaveLength(1);
      return;
    }
    if (scenario.startsWith("reload-")) {
      expect(result.loads).toBe(2);
      expect(result.cancelled).toBe(true);
      expect(result.retainedBeforeResume).toBe(true);
      expect(result.cancelledProviderCalls).toBe(0);
      expect(result.isolated).toBe(true);
      expect(result.freshAccepted).toBe(true);
      expect(result.providerCalls).toBe(2);
      expect(JSON.stringify(result.providerMessages)).not.toContain("cancelled image");
      expect(JSON.stringify(result.providerMessages)).not.toContain("cancelled text");
      expect(result.providerMessages.flatMap((messages: any[]) => messages).flatMap((message: any) => Array.isArray(message.content) ? message.content : []).filter((part: any) => part.type === "image")).toEqual([]);
      expect(result.records).toBe(0);
      return;
    }
    expect(result.starts).toBe(scenario.startsWith("stop-") ? (scenario === "stop-input-before" ? 1 : 2) : 1);
    if (scenario.startsWith("stop-")) {
      expect(result.cancelledProviderCalls).toBe(0);
      expect(result.freshAccepted).toBe(true);
      expect(result.modelImageCounts).toEqual([0]);
      expect(JSON.stringify(result.modelInputs)).not.toContain("Compare these images");
      expect(result.modelInputs[0].at(-1)).toBe("fresh after stop");
      expect(result.texts).toEqual(["answer 1"]);
      expect(result.feedback).toContain("Abort signal sent.");
    } else if (scenario.startsWith("terminal-")) {
      expect(result.modelInputs).toEqual([]);
      expect(result.modelImageCounts).toEqual([]);
      expect(result.texts).toEqual([]);
    } else if (scenario === "album" || scenario === "album-read") {
      expect(result.received).toHaveLength(1);
      const [one, two, blank, caption] = result.received[0].split("\n");
      expect(one).toMatch(/^\[Image#1\] /);
      expect(two).toMatch(/^\[Image#2\] /);
      for (const line of [one, two]) {
        const file = line.slice(10);
        expect(path.isAbsolute(file)).toBe(true);
        await expect(fs.access(file)).resolves.toBeUndefined();
      }
      expect(blank).toBe("");
      expect(caption).toBe("Compare these images");
      expect(result.modelInputs).toEqual(scenario === "album" ? [result.received] : [result.received, result.received]);
      expect(result.modelImageCounts).toEqual(scenario === "album" ? [0] : [0, 2]);
      expect(result.texts).toEqual([scenario === "album" ? "answer 1" : "answer 2"]);
      expect(result.reactions).toContainEqual({ messageId: 1, emoji: "👀" });
      expect(result.reactions).toContainEqual({ messageId: 1, emoji: "💯" });
    } else if (scenario === "busy-concurrent-input-gate") {
      expect(result.inputWaited).toBe(false);
      expect(result.admitted).toHaveLength(2);
      expect(result.admitted.every((admission: { accepted: boolean }) => admission.accepted)).toBe(true);
      expect(result.received).toEqual(["local-one", "busy-one", "busy-two"]);
      expect(result.modelInputs.at(-1)).toEqual(["local-one", "busy-one", "busy-two"]);
      expect(result.texts).toEqual(["🧑‍💻 [Prompt]\nlocal-one", "answer 1", "answer 2", "answer 3"]);
      for (const messageId of [101, 102]) {
        expect(result.reactions).toContainEqual({ messageId, emoji: "👀" });
        expect(result.reactions).toContainEqual({ messageId, emoji: "💯" });
      }
    } else if (scenario.startsWith("busy-")) {
      expect(result.inputWaited).toBe(false);
      expect(result.modelChanged).toBe(true);
      expect(result.admitted.accepted).toBe(true);
      expect(result.received).toEqual(["local-one", "remote busy prompt"]);
      expect(result.modelInputs.at(-1)).toEqual(["local-one", "remote busy prompt"]);
      expect(result.texts).toEqual(["🧑‍💻 [Prompt]\nlocal-one", "answer 1", "answer 2"]);
      expect(result.reactions).toContainEqual({ messageId: 101, emoji: "👀" });
      expect(result.reactions).toContainEqual({ messageId: 101, emoji: "💯" });
    } else if (scenario === "follow-up" || scenario === "length-follow-up") {
      expect(result.received).toEqual(["local-one", "local-follow-up"]);
      expect(result.texts).toEqual(["🧑‍💻 [Prompt]\nlocal-one", "answer 1", "🧑‍💻 [Prompt]\nlocal-follow-up", "answer 2"]);
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
