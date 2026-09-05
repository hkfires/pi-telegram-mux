import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { saveConfig } from "../../src/config.js";
import { testConfig } from "../helpers.js";

interface State { type: string; leader: boolean; transport: boolean; polling: boolean; }

describe("real multi-process election and crash recovery", () => {
  let root: string;
  let build: string;
  const children: ChildProcess[] = [];

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "mux-election-"));
    build = path.join(root, "build");
    await fs.mkdir(build);
    await fs.writeFile(path.join(build, "package.json"), '{"type":"module"}');
    await fs.symlink(path.resolve("node_modules"), path.join(build, "node_modules"), process.platform === "win32" ? "junction" : "dir");
    // Compile the current source, never a possibly stale or untracked dist directory.
    for (const file of await fs.readdir(path.resolve("src"))) {
      if (!file.endsWith(".ts")) continue;
      const source = await fs.readFile(path.resolve("src", file), "utf-8");
      const result = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022, esModuleInterop: true } });
      await fs.writeFile(path.join(build, file.replace(/\.ts$/, ".js")), result.outputText);
    }
  });
  afterEach(async () => {
    await Promise.all(children.splice(0).map(child => new Promise<void>(resolve => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve();
      child.once("exit", () => resolve());
      child.kill("SIGKILL");
    })));
    await fs.rm(root, { recursive: true, force: true });
  });

  function message(child: ChildProcess, type: string): Promise<State> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { child.off("message", handler); reject(new Error(`Worker did not emit ${type}`)); }, 10_000);
      const handler = (value: unknown) => {
        if ((value as State).type === type) { clearTimeout(timer); child.off("message", handler); resolve(value as State); }
      };
      child.on("message", handler);
    });
  }

  function launch(dir: string, gate = "") {
    const child = spawn(process.execPath, [path.resolve("tests/integration/election-worker.mjs")], {
      env: { ...process.env, MUX_TEST_BUILD: build, MUX_TEST_AGENT_DIR: dir, MUX_TEST_PUBLICATION_GATE: gate }, stdio: ["ignore", "ignore", "inherit", "ipc"],
    });
    children.push(child);
    return { child, ready: message(child, "ready") };
  }

  async function startGroup(dir: string) {
    await saveConfig(dir, testConfig);
    const group = Array.from({ length: 4 }, () => launch(dir));
    await Promise.all(group.map(x => x.ready));
    const started = group.map(x => message(x.child, "started"));
    for (const x of group) x.child.send("start");
    const states = await Promise.all(started);
    expect(states.filter(x => x.polling)).toHaveLength(1);
    expect(states.filter(x => x.leader)).toHaveLength(1);
    expect(states.every(x => x.transport), JSON.stringify(states)).toBe(true);
    return { group: group.map(x => x.child), states };
  }

  it("elects one poller in repeated concurrent starts and never reconnects after shutdown", async () => {
    for (let round = 0; round < 3; round++) {
      const { group } = await startGroup(path.join(root, `round-${round}`));
      const stopped = group.map(child => message(child, "stopped"));
      const exited = group.map(child => new Promise(resolve => child.once("exit", resolve)));
      for (const child of group) child.send("stop");
      expect((await Promise.all(stopped)).every(x => !x.transport && !x.polling)).toBe(true);
      await Promise.all(exited);
    }
  }, 20_000);

  it("never expires a live contender paused inside metadata publication", async () => {
    const dir = path.join(root, "suspension");
    const gate = path.join(root, "resume-publication");
    await saveConfig(dir, testConfig);
    const a = launch(dir, gate);
    const b = launch(dir);
    await Promise.all([a.ready, b.ready]);
    const publishing = message(a.child, "publishing");
    const startedA = message(a.child, "started");
    a.child.send("start");
    await publishing;
    const startedB = message(b.child, "started");
    b.child.send("start");
    await new Promise(resolve => setTimeout(resolve, 6000));
    const state = message(b.child, "state");
    b.child.send("state");
    expect((await state).polling).toBe(false);
    await fs.writeFile(gate, "resume");
    const states = await Promise.all([startedA, startedB]);
    expect(states.filter(s => s.polling)).toHaveLength(1);
    expect(states.every(s => s.transport)).toBe(true);
    const stopped = [message(a.child, "stopped"), message(b.child, "stopped")];
    a.child.send("stop"); b.child.send("stop");
    await Promise.all(stopped);
  }, 20_000);

  it("recovers when a contender crashes just before publishing complete metadata", async () => {
    const dir = path.join(root, "publication-crash");
    await saveConfig(dir, testConfig);
    const a = launch(dir, path.join(root, "never-opened"));
    await a.ready;
    const publishing = message(a.child, "publishing");
    a.child.send("start");
    await publishing;
    const exited = new Promise(resolve => a.child.once("exit", resolve));
    a.child.kill("SIGKILL");
    await exited;
    await startGroup(dir);
    const runtimeDir = path.join(dir, "pi-telegram-mux/runtime");
    expect(JSON.parse(await fs.readFile(path.join(runtimeDir, "leader.json"), "utf-8")).capability).toBeTruthy();
    expect((await fs.readdir(runtimeDir)).filter(file => file.endsWith(".tmp"))).toEqual([]);
  }, 20_000);

  it("re-elects exactly one Leader after the previous process crashes", async () => {
    const { group, states } = await startGroup(path.join(root, "crash"));
    const leader = group[states.findIndex(x => x.leader)];
    const exited = new Promise(resolve => leader.once("exit", resolve));
    leader.kill("SIGKILL");
    await exited;
    const survivors = group.filter(x => x !== leader);
    await vi.waitFor(async () => {
      const replies = survivors.map(child => message(child, "state"));
      for (const child of survivors) child.send("state");
      const current = await Promise.all(replies);
      expect(current.filter(x => x.polling)).toHaveLength(1);
      expect(current.filter(x => x.leader)).toHaveLength(1);
      expect(current.every(x => x.transport)).toBe(true);
    }, { timeout: 10_000, interval: 100 });
    const stopped = survivors.map(child => message(child, "stopped"));
    for (const child of survivors) child.send("stop");
    expect((await Promise.all(stopped)).every(x => !x.polling && !x.transport)).toBe(true);
  }, 20_000);
});
