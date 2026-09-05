import { pathToFileURL } from "node:url";
import * as path from "node:path";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";

if (process.env.MUX_TEST_PUBLICATION_GATE) {
  const rename = fs.renameSync;
  let paused = false;
  fs.renameSync = function (source, destination) {
    if (!paused && String(destination).endsWith("leader.json")) {
      paused = true;
      process.send({ type: "publishing" });
      const wait = new Int32Array(new SharedArrayBuffer(4));
      // Simulate process suspension inside the critical section, not merely a slow
      // network request outside it. The parent can release the gate or kill us.
      while (!fs.existsSync(process.env.MUX_TEST_PUBLICATION_GATE)) Atomics.wait(wait, 0, 0, 50);
    }
    return rename(source, destination);
  };
  syncBuiltinESMExports();
}

const { MuxRuntime } = await import(pathToFileURL(path.join(process.env.MUX_TEST_BUILD, "runtime.js")).href);
const { TelegramClient } = await import(pathToFileURL(path.join(process.env.MUX_TEST_BUILD, "telegram.js")).href);
globalThis.fetch = async () => { throw new Error("External network is forbidden in election workers"); };
TelegramClient.prototype.getMe = async () => ({ id: 1, is_bot: true, first_name: "Fixture", username: "fixture_bot" });
let polling = false;
TelegramClient.prototype.getUpdates = function (options) {
  polling = true;
  return new Promise((_resolve, reject) => {
    const abort = () => { polling = false; reject(new Error("Aborted")); };
    if (options.signal.aborted) abort();
    else options.signal.addEventListener("abort", abort, { once: true });
  });
};
const ctx = {
  mode: "tui", cwd: process.env.MUX_TEST_AGENT_DIR, isIdle: () => true,
  sessionManager: { getSessionId: () => String(process.pid), getEntries: () => [] },
  ui: { setStatus() {}, notify() {} },
};
const runtime = new MuxRuntime({}, process.env.MUX_TEST_AGENT_DIR);
const errors = [];
const setupTransport = runtime.setupTransport.bind(runtime);
runtime.setupTransport = (...args) => setupTransport(...args).catch(error => { errors.push(error.message); throw error; });
process.on("message", async message => {
  if (message === "start") {
    await runtime.onSessionStart(ctx);
    process.send({ type: "started", leader: runtime.getIsLeader(), transport: runtime.hasActiveTransport(), polling, errors });
  } else if (message === "state") {
    process.send({ type: "state", leader: runtime.getIsLeader(), transport: runtime.hasActiveTransport(), polling });
  } else if (message === "stop") {
    await runtime.onSessionShutdown(ctx);
    process.send({ type: "stopped", transport: runtime.hasActiveTransport(), polling });
    process.disconnect();
  }
});
process.send({ type: "ready" });
