import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { runtimeFixture } from "./helpers.js";

const { resolveRenderer, loadRenderer, renderMarkdown } = vi.hoisted(() => ({
  resolveRenderer: vi.fn(), loadRenderer: vi.fn(), renderMarkdown: vi.fn(),
}));
vi.mock("node:module", async importOriginal => ({
  ...await importOriginal<typeof import("node:module")>(),
  createRequire: () => Object.assign(loadRenderer, { resolve: resolveRenderer }),
}));

beforeEach(() => {
  vi.resetModules();
  resolveRenderer.mockReset().mockReturnValue("renderer-entry.js");
  loadRenderer.mockReset().mockReturnValue({ renderMarkdown });
  renderMarkdown.mockReset().mockImplementation(() => ({
    text: "\uE000\n\nbold\n\n\uE000",
    entities: [{ type: "bold", offset: 3, length: 4 }],
  }));
});

describe("Markdown renderer loading", () => {
  it("does not load the renderer during import or for empty text", async () => {
    const { renderTelegramMarkdown } = await import("../src/render.js");
    expect(renderTelegramMarkdown("")).toEqual([]);
    expect(resolveRenderer).not.toHaveBeenCalled();
    expect(loadRenderer).not.toHaveBeenCalled();
  });

  it("passes Markdown to the library without syntax rewriting", async () => {
    const { renderTelegramMarkdown } = await import("../src/render.js");
    const markdown = "<details>\n[docs][id]\n</details>\n\n[id]: https://example.com";
    renderTelegramMarkdown(markdown);
    expect(renderMarkdown).toHaveBeenCalledExactlyOnceWith("\uE000\n\n" + markdown + "\n\n\uE000");
  });

  it("caches a successfully loaded renderer", async () => {
    const { renderTelegramMarkdown } = await import("../src/render.js");
    for (let i = 0; i < 2; i++) {
      expect(renderTelegramMarkdown("**bold**")).toEqual([{
        text: "bold", entities: [{ type: "bold", offset: 0, length: 4 }],
      }]);
    }
    expect(resolveRenderer).toHaveBeenCalledOnce();
    expect(loadRenderer).toHaveBeenCalledExactlyOnceWith("renderer-entry.js");
    expect(renderMarkdown).toHaveBeenCalledTimes(2);
  });

  it("uses cached plain text when the renderer package is absent", async () => {
    resolveRenderer.mockImplementation(() => { throw Object.assign(new Error("Package absent"), { code: "MODULE_NOT_FOUND" }); });
    const { renderTelegramMarkdown } = await import("../src/render.js");
    expect(renderTelegramMarkdown("**bold**")).toEqual([{ text: "**bold**" }]);
    expect(renderTelegramMarkdown("**later**")).toEqual([{ text: "**later**" }]);
    expect(resolveRenderer.mock.calls).toEqual([["telegram-md-entities"], ["telegram-md-entities/package.json"]]);
    expect(loadRenderer).not.toHaveBeenCalled();
  });

  it("reports an installed package whose entry is missing", async () => {
    const failure = Object.assign(new Error("Package entry absent"), { code: "MODULE_NOT_FOUND" });
    resolveRenderer.mockImplementation(specifier => {
      if (specifier === "telegram-md-entities") throw failure;
      return "package.json";
    });
    const { renderTelegramMarkdown } = await import("../src/render.js");
    expect(() => renderTelegramMarkdown("**bold**")).toThrow(failure);
    expect(loadRenderer).not.toHaveBeenCalled();
  });

  it.each(["ERR_INVALID_PACKAGE_CONFIG", "ERR_PACKAGE_PATH_NOT_EXPORTED"])("propagates package resolution failure %s", async code => {
    const failure = Object.assign(new Error("Package resolution failed"), { code });
    resolveRenderer.mockImplementation(() => { throw failure; });
    const { renderTelegramMarkdown } = await import("../src/render.js");
    expect(() => renderTelegramMarkdown("**bold**")).toThrow(failure);
    expect(resolveRenderer).toHaveBeenCalledOnce();
    expect(loadRenderer).not.toHaveBeenCalled();
  });

  it.each([
    new SyntaxError("Dependency syntax failure"),
    new Error("Dependency initialization failure"),
    Object.assign(new Error("Nested dependency absent"), { code: "MODULE_NOT_FOUND" }),
    Object.assign(new Error("Nested ESM dependency absent"), { code: "ERR_MODULE_NOT_FOUND" }),
  ])("propagates %s without caching a plain-text fallback", async failure => {
    loadRenderer.mockImplementationOnce(() => { throw failure; });
    const { renderTelegramMarkdown } = await import("../src/render.js");
    expect(() => renderTelegramMarkdown("**bold**")).toThrow(failure);
    expect(renderTelegramMarkdown("**bold**")[0].entities).toEqual([{ type: "bold", offset: 0, length: 4 }]);
    expect(loadRenderer).toHaveBeenCalledTimes(2);
  });

  it.each([undefined, {}, { renderMarkdown: 123 }])("rejects an invalid renderer export: %s", async exports => {
    loadRenderer.mockReturnValueOnce(exports);
    const { renderTelegramMarkdown } = await import("../src/render.js");
    expect(() => renderTelegramMarkdown("**bold**")).toThrow("Markdown renderer does not export renderMarkdown");
    expect(renderTelegramMarkdown("**bold**")[0].entities).toBeDefined();
  });
});

describe("Markdown renderer output validation", () => {
  it.each([
    { rendered: { text: "x", entities: [] }, error: "Markdown renderer did not preserve document boundaries" },
    { rendered: { text: "\uE000\n\nx\n\n\uE000", entities: null }, error: TypeError },
    {
      rendered: { text: "\uE000\n\nx\n\n\uE000", entities: Array.from({ length: 91 }, () => ({ type: "bold", offset: 3, length: 1 })) },
      error: "Cannot split within Telegram entity limits",
    },
  ])("rejects malformed renderer output: $error", async ({ rendered, error }) => {
    renderMarkdown.mockReturnValue(rendered);
    const { renderTelegramMarkdown } = await import("../src/render.js");
    expect(() => renderTelegramMarkdown("**x**")).toThrow(error);
  });
});

describe("runtime renderer failure visibility", () => {
  let dir: string;
  const fixtures: Awaited<ReturnType<typeof runtimeFixture>>[] = [];
  beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), "mux-render-loading-")); });
  afterEach(async () => {
    for (const f of fixtures.reverse()) await f.runtime.onSessionShutdown(f.ctx);
    fixtures.length = 0;
    vi.restoreAllMocks();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it.each([
    { role: "leader", stage: "loading" },
    { role: "follower", stage: "loading" },
    { role: "leader", stage: "rendering" },
    { role: "follower", stage: "rendering" },
  ])("pauses $role delivery and reports $stage failure", async ({ role, stage }) => {
    const { runtimeFixture } = await import("./helpers.js");
    const leader = await runtimeFixture(dir, "leader");
    fixtures.push(leader);
    const f = role === "leader" ? leader : await runtimeFixture(dir, "follower", 51);
    if (f !== leader) fixtures.push(f);
    const failure = new Error("Simulated " + stage + " failure");
    (stage === "loading" ? loadRenderer : renderMarkdown).mockImplementation(() => { throw failure; });
    const send = vi.spyOn(f.runtime, "callTelegram");

    await f.runtime.onBeforeAgentStart(f.ctx);
    f.runtime.onMessageEnd({ role: "assistant", content: "**bold**", stopReason: "stop" });
    await f.runtime.onAgentSettled(f.ctx);
    await f.runtime.outbox.whenIdle();

    expect(send).not.toHaveBeenCalled();
    expect(f.runtime.outbox.error).toBe(failure);
    expect(f.ui.setStatus).toHaveBeenLastCalledWith("tg", "tg: error");
    expect(f.ui.notify).toHaveBeenCalledWith(`Telegram sync paused: ${failure.message}`, "error");
  });
});
