import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveAgentDir } from "../src/index.js";

afterEach(() => vi.unstubAllEnvs());

describe("Pi agent directory normalization", () => {
  it.each(["~", "~/.pi/agent"])("expands %s independently of the project directory", value => {
    vi.stubEnv("PI_CODING_AGENT_DIR", value);
    expect(resolveAgentDir()).toBe(value === "~" ? os.homedir() : path.join(os.homedir(), ".pi", "agent"));
    expect(path.isAbsolute(resolveAgentDir())).toBe(true);
  });
  it("retains explicit overrides and Pi's relative-path semantics", () => {
    vi.stubEnv("PI_CODING_AGENT_DIR", "~/.pi/agent");
    expect(resolveAgentDir("./custom")).toBe("./custom");
    expect(resolveAgentDir("~/custom")).toBe(path.join(os.homedir(), "custom"));
  });
  it("decodes file URLs without silent fallbacks", () => {
    const dir = path.join(os.tmpdir(), "agent with spaces");
    vi.stubEnv("PI_CODING_AGENT_DIR", pathToFileURL(dir).href);
    expect(resolveAgentDir()).toBe(dir);
    expect(() => resolveAgentDir("file:///%zz")).toThrow();
  });
  it.skipIf(process.platform !== "win32")("matches Windows home and shell-drive expansion", () => {
    expect(resolveAgentDir("~\\.pi\\agent")).toBe(path.join(os.homedir(), ".pi", "agent"));
    for (const dir of ["/c/Users/test", "/mnt/c/Users/test", "/cygdrive/c/Users/test"]) expect(resolveAgentDir(dir)).toBe("C:\\Users\\test");
  });
});
