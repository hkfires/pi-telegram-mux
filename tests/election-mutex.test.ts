import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getRuntimeDir } from "../src/config.js";
import { tryAcquireLeaderLock } from "../src/ipc.js";
import * as processIdentity from "../src/process-identity.js";

vi.mock("node:fs/promises", async importOriginal => ({ ...await importOriginal<typeof import("node:fs/promises")>() }));

const ownIdentity = "a".repeat(64);
const previousIdentity = "b".repeat(64);
const nonce = "00000000-0000-0000-0000-000000000001";

describe("election mutex process identity", () => {
  let dir: string;
  let claimsDir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "mux-election-mutex-"));
    claimsDir = path.join(getRuntimeDir(dir), "election");
    await fs.mkdir(claimsDir, { recursive: true });
    vi.spyOn(processIdentity, "getProcessIdentity").mockResolvedValue(ownIdentity);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it.each(["choosing", "waiting"])("reclaims a %s claim belonging to a previous instance of a live PID", async phase => {
    const holder = path.join(claimsDir, `${process.pid}-${previousIdentity}-${nonce}.json`);
    await fs.writeFile(holder, phase === "choosing" ? "" : "1");
    // Bound the regression without waiting ten real seconds on the unfixed code.
    let now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const read = fs.readFile;
    let reads = 0;
    vi.spyOn(fs, "readFile").mockImplementation(async (...args) => {
      if (String(args[0]) === holder && ++reads > 1) now += 10001;
      return read(...args);
    });
    const acquired = await tryAcquireLeaderLock(dir, 12345);
    try {
      expect(acquired.acquired).toBe(true);
      expect(await fs.readdir(claimsDir)).toEqual([]);
    } finally { await acquired.releaseLock?.(); }
  });

  it("publishes its start identity and waits for a matching live claim to release", async () => {
    const holder = path.join(claimsDir, `${process.pid}-${ownIdentity}-${nonce}.json`);
    await fs.writeFile(holder, "1");
    const acquiring = tryAcquireLeaderLock(dir, 12345);
    try {
      await vi.waitFor(async () => expect((await fs.readdir(claimsDir)).filter(file => file.endsWith(".json"))).toHaveLength(2));
      const contender = (await fs.readdir(claimsDir)).find(file => file.endsWith(".json") && file !== path.basename(holder));
      expect(contender).toMatch(new RegExp(`^${process.pid}-${ownIdentity}-`));
      await expect(fs.access(path.join(getRuntimeDir(dir), "leader.json"))).rejects.toMatchObject({ code: "ENOENT" });
      expect(await fs.readFile(holder, "utf8")).toBe("1");
    } finally {
      await fs.rm(holder, { force: true });
      const acquired = await acquiring;
      await acquired.releaseLock?.();
    }
    expect(await fs.readdir(claimsDir)).toEqual([]);
  });

  it.each(["legacy", "matching identity", "unknown identity"])("never expires a live holder with %s", async kind => {
    const pid = kind === "unknown identity" ? process.ppid : process.pid;
    const identity = kind === "legacy" ? "" : `${kind === "matching identity" ? ownIdentity : previousIdentity}-`;
    const holder = path.join(claimsDir, `${pid}-${identity}${nonce}.json`);
    await fs.writeFile(holder, "1");
    if (kind === "unknown identity") {
      vi.mocked(processIdentity.getProcessIdentity).mockImplementation(async owner => owner === process.pid ? ownIdentity : undefined);
    }
    let now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const read = fs.readFile;
    let reads = 0;
    vi.spyOn(fs, "readFile").mockImplementation(async (...args) => {
      if (String(args[0]) === holder && ++reads > 1) now += 10001;
      return read(...args);
    });
    await expect(tryAcquireLeaderLock(dir, 12345)).rejects.toMatchObject({ code: "IPC_ELECTION_BUSY" });
    expect(await fs.readdir(claimsDir)).toEqual([path.basename(holder)]);
    await expect(fs.access(path.join(getRuntimeDir(dir), "leader.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
