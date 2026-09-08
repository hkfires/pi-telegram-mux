import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ execute: vi.fn(), read: vi.fn() }));
vi.mock("node:child_process", async importOriginal => {
  const original = await importOriginal<typeof import("node:child_process")>();
  const { promisify } = await import("node:util");
  const execFile = Object.assign(() => {}, { [promisify.custom]: mocks.execute });
  return { ...original, execFile };
});
vi.mock("node:fs/promises", async importOriginal => ({ ...await importOriginal<typeof import("node:fs/promises")>(), readFile: mocks.read }));

const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
beforeEach(() => { vi.resetModules(); mocks.execute.mockReset(); mocks.read.mockReset(); });
afterEach(() => { Object.defineProperty(process, "platform", platform); });

it("uses the Windows kernel creation time and caches only the current process", async () => {
  Object.defineProperty(process, "platform", { value: "win32" });
  mocks.execute.mockResolvedValue({ stdout: "1dd001122334455\r\n" });
  const { getProcessIdentity } = await import("../src/process-identity.js");
  const [first, second] = await Promise.all([getProcessIdentity(process.pid), getProcessIdentity(process.pid)]);
  expect(first).toMatch(/^[a-f\d]{64}$/);
  expect(first).toBe(second);
  expect(mocks.execute).toHaveBeenCalledTimes(1);
  expect(mocks.execute.mock.calls[0][2]).toMatchObject({ windowsHide: true, timeout: 3000 });
  const other = process.pid + 1;
  const previous = await getProcessIdentity(other);
  mocks.execute.mockResolvedValue({ stdout: "1dd001122334456" });
  expect(await getProcessIdentity(other)).not.toBe(previous);
});

it("uses Linux boot identity and start ticks even when the process name contains spaces and parentheses", async () => {
  Object.defineProperty(process, "platform", { value: "linux" });
  const pid = process.pid + 1;
  let ticks = "12345";
  let boot = "00000000-0000-0000-0000-000000000001";
  mocks.read.mockImplementation(async (file: string) => {
    if (file.endsWith("boot_id")) return boot;
    const fields = Array(20).fill("0");
    fields[0] = "S";
    fields[19] = ticks;
    return `${pid} (node worker (name)) ${fields.join(" ")}`;
  });
  const { getProcessIdentity } = await import("../src/process-identity.js");
  const first = await getProcessIdentity(pid);
  expect(first).toMatch(/^[a-f\d]{64}$/);
  expect(await getProcessIdentity(pid)).toBe(first);
  ticks = "12346";
  const restarted = await getProcessIdentity(pid);
  expect(restarted).not.toBe(first);
  boot = "00000000-0000-0000-0000-000000000002";
  expect(await getProcessIdentity(pid)).not.toBe(restarted);
  expect(mocks.execute).not.toHaveBeenCalled();
});

it("normalizes macOS start-time output with a fixed locale and timezone", async () => {
  Object.defineProperty(process, "platform", { value: "darwin" });
  const pid = process.pid + 1;
  mocks.execute.mockResolvedValueOnce({ stdout: "Tue Sep  8 12:00:00 2026\n" }).mockResolvedValueOnce({ stdout: "Tue Sep 8 12:00:00 2026" });
  const { getProcessIdentity } = await import("../src/process-identity.js");
  const first = await getProcessIdentity(pid);
  expect(first).toMatch(/^[a-f\d]{64}$/);
  expect(await getProcessIdentity(pid)).toBe(first);
  expect(mocks.execute.mock.calls[0][2].env).toMatchObject({ LC_ALL: "C", TZ: "UTC" });
});

it("keeps unavailable process data unknown and retries a failed self lookup", async () => {
  Object.defineProperty(process, "platform", { value: "win32" });
  mocks.execute.mockRejectedValueOnce(new Error("Access denied")).mockResolvedValueOnce({ stdout: "1dd001122334455" });
  const { getProcessIdentity } = await import("../src/process-identity.js");
  expect(await getProcessIdentity(process.pid)).toBeUndefined();
  expect(await getProcessIdentity(process.pid)).toMatch(/^[a-f\d]{64}$/);
});

it.each([0, -1, NaN, Number.MAX_SAFE_INTEGER + 1])("rejects an invalid PID without querying the system: %s", async pid => {
  const { getProcessIdentity } = await import("../src/process-identity.js");
  expect(await getProcessIdentity(pid)).toBeUndefined();
  expect(mocks.execute).not.toHaveBeenCalled();
  expect(mocks.read).not.toHaveBeenCalled();
});
