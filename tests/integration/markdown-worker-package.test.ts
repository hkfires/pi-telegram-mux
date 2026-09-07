import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import ts from "typescript";
import { expect, it } from "vitest";

it.each([
  { name: "missing optional renderer", implementation: null, error: null },
  { name: "loader failure", implementation: 'throw new SyntaxError("fixture load failed");', error: "fixture load failed" },
  { name: "parser failure", implementation: 'exports.renderMarkdown = () => { throw new Error("fixture parse failed"); };', error: "fixture parse failed" },
  { name: "invalid parser output", implementation: 'exports.renderMarkdown = () => ({text:"broken", entities:[]});', error: "Markdown renderer did not preserve document boundaries" },
])("runs a packaged worker with $name", async ({ implementation, error }) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mux-worker-package-"));
  try {
    // Native .mjs assets must work inside node_modules without a TypeScript loader.
    const packageDir = path.join(root, "node_modules", "mux-fixture");
    await fs.mkdir(packageDir, { recursive: true });
    await fs.writeFile(path.join(packageDir, "package.json"), '{"type":"module"}');
    for (const name of ["render-core.mjs", "render-worker.mjs"]) {
      await fs.copyFile(path.resolve("src", name), path.join(packageDir, name));
    }
    const source = await fs.readFile(path.resolve("src/markdown-worker.ts"), "utf8");
    const javascript = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText;
    const clientFile = path.join(packageDir, "markdown-worker.js");
    await fs.writeFile(clientFile, javascript);
    if (implementation) {
      const dependency = path.join(packageDir, "node_modules", "telegram-md-entities");
      await fs.mkdir(dependency, { recursive: true });
      await fs.writeFile(path.join(dependency, "package.json"), '{"main":"index.cjs"}');
      await fs.writeFile(path.join(dependency, "index.cjs"), implementation);
    }
    const script = `
      const { MarkdownWorker } = await import(${JSON.stringify(pathToFileURL(clientFile).href)});
      const renderer = new MarkdownWorker();
      try { console.log(JSON.stringify({ chunks: await renderer.render("**text**", new AbortController().signal) })); }
      catch (error) { console.log(JSON.stringify({ error: error.message })); }
      finally { await renderer.close(); }
    `;
    const { stdout } = await promisify(execFile)(process.execPath, ["--input-type=module", "-e", script], { timeout: 10_000 });
    expect(JSON.parse(stdout)).toEqual(error ? { error } : { chunks: [{ text: "**text**" }] });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
}, 15_000);
