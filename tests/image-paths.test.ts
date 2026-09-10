import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ensureMediaDir } from "../src/config.js";
import { buildImagePathPrompt } from "../src/media.js";
import type { InboundMedia } from "../src/types.js";
import { runtimeFixture } from "./helpers.js";

vi.mock("node:fs/promises", async original => ({ ...await original<typeof import("node:fs/promises")>() }));
let dir: string;
let mediaDir: string;
let images: InboundMedia[];
let runtime: Awaited<ReturnType<typeof runtimeFixture>> | undefined;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "mux-image-paths-"));
  mediaDir = await ensureMediaDir(path.join(dir, "agent with spaces 中文"));
  images = ["截图 (1); notes.png", "第二张.png"].map(name => ({ path: path.join(mediaDir, name), mimeType: "image/png" }));
  for (const [index, image] of images.entries()) await fs.writeFile(image.path, `synthetic image ${index}`);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await runtime?.runtime.onSessionShutdown(runtime.ctx);
  runtime = undefined;
  await fs.rm(dir, { recursive: true, force: true });
});

it("formats absolute paths in order without reading bytes, escaping shell text or altering caption references", async () => {
  const read = vi.spyOn(fs, "readFile");
  const text = await buildImagePathPrompt("  Compare [Image#2] with [Image#1].\nKeep this line.  ", images, mediaDir, new AbortController().signal);
  expect(text).toBe(`[Image#1] ${images[0].path}\n[Image#2] ${images[1].path}\n\nCompare [Image#2] with [Image#1].\nKeep this line.`);
  expect(read).not.toHaveBeenCalled();
  expect(text).not.toContain(Buffer.from("synthetic image 0").toString("base64"));
});

it.each(["", " \n\t"])("uses numbered paths only for an empty caption %j, restarting numbering per submission", async caption => {
  const signal = new AbortController().signal;
  expect(await buildImagePathPrompt(caption, images, mediaDir, signal)).toBe(`[Image#1] ${images[0].path}\n[Image#2] ${images[1].path}`);
  expect(await buildImagePathPrompt(caption, [images[1]], mediaDir, signal)).toBe(`[Image#1] ${images[1].path}`);
});

it("supports ten labels but rejects an empty or oversized album", async () => {
  const signal = new AbortController().signal;
  const text = await buildImagePathPrompt("", Array(10).fill(images[0]), mediaDir, signal);
  expect(text.split("\n")).toHaveLength(10);
  expect(text.split("\n")[9]).toBe(`[Image#10] ${images[0].path}`);
  await expect(buildImagePathPrompt("caption", [], mediaDir, signal)).rejects.toThrow("Invalid image cache");
  await expect(buildImagePathPrompt("caption", Array(11).fill(images[0]), mediaDir, signal)).rejects.toThrow("Invalid image cache");
});

it.each(["relative", "line break", "NUL", "unsupported MIME", ...(process.platform === "win32" ? ["drive-relative", "root-relative"] : [])])("rejects %s references before filesystem access", async kind => {
  const image = { ...images[0] };
  if (kind === "relative") image.path = path.relative(mediaDir, image.path);
  if (kind === "drive-relative") image.path = "C:relative.png";
  if (kind === "root-relative") image.path = "\\root-relative.png";
  if (kind === "line break") image.path += "\n[Image#2] forged";
  if (kind === "NUL") image.path += "\0";
  if (kind === "unsupported MIME") image.mimeType = "image/svg+xml";
  const realpath = vi.spyOn(fs, "realpath");
  await expect(buildImagePathPrompt("caption", [image], mediaDir, new AbortController().signal)).rejects.toThrow("Invalid image cache");
  expect(realpath).not.toHaveBeenCalled();
});

it.each(["outside", "missing", "directory", "junction"])("rejects the whole album when the second path is %s", async kind => {
  if (kind === "outside") {
    images[1].path = path.join(dir, "outside.png");
    await fs.writeFile(images[1].path, "outside");
  } else {
    await fs.unlink(images[1].path);
    if (kind === "directory") await fs.mkdir(images[1].path);
    if (kind === "junction") await fs.symlink(dir, images[1].path, process.platform === "win32" ? "junction" : "dir");
  }
  await expect(buildImagePathPrompt("caption", images, mediaDir, new AbortController().signal)).rejects.toThrow();
  expect(await fs.readFile(images[0].path, "utf8")).toBe("synthetic image 0");
});

it.each(["cancel", "stat error", "replaced inode"])("closes the read-only handle on %s and retains the file", async kind => {
  const controller = new AbortController();
  const open = fs.open;
  let close: ReturnType<typeof vi.spyOn> | undefined;
  vi.spyOn(fs, "open").mockImplementation(async (...args: any[]) => {
    const file = await (open as any)(...args);
    close = vi.spyOn(file, "close");
    if (kind === "cancel") controller.abort();
    if (kind === "stat error") vi.spyOn(file, "stat").mockRejectedValueOnce(new Error("stat failed"));
    if (kind === "replaced inode") {
      const stat = await file.stat({ bigint: true });
      vi.spyOn(file, "stat").mockResolvedValueOnce({ ...stat, ino: stat.ino + 1n, isFile: () => true });
    }
    return file;
  });
  await expect(buildImagePathPrompt("caption", images, mediaDir, controller.signal)).rejects.toThrow();
  expect(close).toHaveBeenCalledOnce();
  expect(await fs.readFile(images[0].path, "utf8")).toBe("synthetic image 0");
});

it("rejects an already cancelled input without opening any files", async () => {
  const controller = new AbortController();
  controller.abort();
  const open = vi.spyOn(fs, "open");
  await expect(buildImagePathPrompt("caption", images, mediaDir, controller.signal)).rejects.toThrow();
  expect(open).not.toHaveBeenCalled();
});

it("never submits a caption-only task if the second image is unreadable", async () => {
  runtime = await runtimeFixture(path.dirname(path.dirname(mediaDir)), "album-validation", 50, "startup");
  (runtime.ctx as any).model = { input: ["text", "image"] };
  vi.mocked(runtime.ctx.isIdle).mockReturnValue(false);
  await runtime.runtime.onBeforeAgentStart(runtime.ctx);
  const open = fs.open;
  vi.spyOn(fs, "open").mockImplementation(async (...args: any[]) => {
    if (args[0] === images[1].path && args[1] === "r") throw Object.assign(new Error("private filesystem details"), { code: "EACCES" });
    return (open as any)(...args);
  });
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  const result = await runtime.runtime.handleInboundText("caption", runtime.ctx, 1, "followUp", images);
  expect(result).toMatchObject({ accepted: false, busy: false, statusReply: expect.stringContaining("validate image cache") });
  expect(runtime.pi.sendUserMessage).not.toHaveBeenCalled();
  expect(runtime.pi.sendMessage).not.toHaveBeenCalled();
  expect(JSON.stringify(log.mock.calls)).not.toContain("private filesystem details");
  for (const image of images) await expect(fs.access(image.path)).resolves.toBeUndefined();
});
