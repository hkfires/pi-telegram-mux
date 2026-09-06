import { describe, expect, it } from "vitest";
import { renderTelegramMarkdown } from "../src/render.js";

describe("renderTelegramMarkdown", () => {
  it("returns empty array for empty or whitespace-only input", () => {
    expect(renderTelegramMarkdown("")).toEqual([]);
    expect(renderTelegramMarkdown("   \n\n  \t ")).toEqual([]);
  });

  it.each([
    "Plain text",
    "🧑‍💻 [Prompt]\n请检查当前改动。",
  ])("renders ordinary text and prompt labels", plain => {
    const chunks = renderTelegramMarkdown(plain);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].text).toBe(plain);
    expect(chunks[0].entities).toBeUndefined();
  });

  it("renders basic markdown elements into telegram entities", () => {
    const md = "Here is **bold** and *italic* and `inline code`.";
    const chunks = renderTelegramMarkdown(md);
    expect(chunks).toHaveLength(1);
    const chunk = chunks[0];
    expect(chunk.text).toBe("Here is bold and italic and inline code.");
    expect(chunk.entities).toBeDefined();

    const bold = chunk.entities?.find(e => e.type === "bold");
    expect(bold).toBeDefined();
    expect(bold?.offset).toBe(8);
    expect(bold?.length).toBe(4);

    const italic = chunk.entities?.find(e => e.type === "italic");
    expect(italic).toBeDefined();
    expect(italic?.offset).toBe(17);
    expect(italic?.length).toBe(6);

    const code = chunk.entities?.find(e => e.type === "code");
    expect(code).toBeDefined();
    expect(code?.offset).toBe(28);
    expect(code?.length).toBe(11);
  });

  it("renders fenced code blocks with language", () => {
    const md = "```typescript\nconst greeting = 'hello';\n```";
    const chunks = renderTelegramMarkdown(md);
    expect(chunks).toHaveLength(1);
    const chunk = chunks[0];
    expect(chunk.text).toContain("const greeting = 'hello';");
    const pre = chunk.entities?.find(e => e.type === "pre");
    expect(pre).toBeDefined();
    expect(pre?.language).toBe("typescript");
  });

  it("renders headings as bold text", () => {
    const md = "# Heading 1\nContent under heading";
    const chunks = renderTelegramMarkdown(md);
    expect(chunks).toHaveLength(1);
    const chunk = chunks[0];
    expect(chunk.text).toContain("Heading 1");
    const bold = chunk.entities?.find(e => e.type === "bold");
    expect(bold).toBeDefined();
    expect(bold?.offset).toBe(0);
    expect(bold?.length).toBe(9);
  });

  it.each(["---", "===", "-", "=", "   ---  "])("renders Setext headings with %s", underline => {
    expect(renderTelegramMarkdown(`标题内容\n${underline}`)).toEqual([{
      text: "标题内容",
      entities: [{ type: "bold", offset: 0, length: 4 }],
    }]);
  });

  it("recognizes Setext headings with CRLF and following plain text", () => {
    expect(renderTelegramMarkdown("标题内容\r\n===\r\n\r\n正文")).toEqual([{
      text: "标题内容\n\n正文",
      entities: [{ type: "bold", offset: 0, length: 4 }],
    }]);
  });

  it("renders markdown links as text_link entities", () => {
    const md = "Check out [GitHub](https://github.com) now.";
    const chunks = renderTelegramMarkdown(md);
    expect(chunks).toHaveLength(1);
    const chunk = chunks[0];
    expect(chunk.text).toBe("Check out GitHub now.");
    const link = chunk.entities?.find(e => e.type === "text_link");
    expect(link).toBeDefined();
    expect(link?.url).toBe("https://github.com");
    expect(link?.offset).toBe(10);
    expect(link?.length).toBe(6);
  });

  it("renders ordinary Chinese tables using the library's list layout", () => {
    expect(renderTelegramMarkdown("| 项目 | 状态 |\n| --- | --- |\n| 测试 | 通过 |")).toEqual([{
      text: "• 测试\n    • 状态: 通过",
      entities: [{ type: "bold", offset: 2, length: 2 }],
    }]);
  });

  it("renders ordinary images as library-provided text links", () => {
    expect(renderTelegramMarkdown("![截图](https://example.com/screenshot.png)")).toEqual([{
      text: "截图",
      entities: [{ type: "text_link", offset: 0, length: 2, url: "https://example.com/screenshot.png" }],
    }]);
  });

  it("keeps Markdown and HTML literal inside fenced code", () => {
    const code = '[docs][id]\n[id]: https://example.com/code\n<a href="./file">docs</a>';
    expect(renderTelegramMarkdown("```text\n" + code + "\n```")).toEqual([{
      text: code,
      entities: [{ type: "pre", offset: 0, length: code.length, language: "text" }],
    }]);
  });

  it("keeps GFM footnotes distinct from shortcut reference links", () => {
    expect(renderTelegramMarkdown("**Note**[^1]\n\n[^1]: https://example.com/note")).toEqual([{
      text: "Note[1]\n\n[1]: https://example.com/note",
      entities: [{ type: "bold", offset: 0, length: 4 }],
    }]);
  });

  it("supports CJK-friendly emphasis around Chinese punctuation", () => {
    const md = "测试：**“重要重点”**！";
    const chunks = renderTelegramMarkdown(md);
    expect(chunks).toHaveLength(1);
    const bold = chunks[0].entities?.find(e => e.type === "bold");
    expect(bold).toBeDefined();
    expect(chunks[0].text.slice(bold!.offset, bold!.offset + bold!.length)).toBe("“重要重点”");
  });

  it("splits long code blocks while preserving entities across chunk boundaries", () => {
    // Generate a code block that exceeds 4096 characters
    const longCode = "console.log('repeated line of code for testing');\n".repeat(120);
    const md = `\`\`\`javascript\n${longCode}\`\`\``;
    const chunks = renderTelegramMarkdown(md, { maxLength: 4096 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.text.length).toBeLessThanOrEqual(4096);
      expect(chunk.entities).toBeDefined();
      const pre = chunk.entities?.find(e => e.type === "pre");
      expect(pre).toBeDefined();
      expect(pre?.language).toBe("javascript");
    }
  });

  it.each([
    ["Python indentation", "if value:\n    print(value)\n".repeat(250).trimEnd(), "python"],
    ["TypeScript comments", Array.from({ length: 200 }, (_, i) => `    // Line ${i}: const value = ${i};`).join("\n"), "typescript"],
    ["tabs and blank lines", "\tvalue();  \n\n\t\tnext();\n".repeat(250).trimEnd(), "typescript"],
  ])("preserves %s verbatim across code chunks", (_name, code, language) => {
    const markdown = `\`\`\`${language}\n${code}\n\`\`\``;
    const chunks = renderTelegramMarkdown(markdown);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.map(chunk => chunk.text).join("")).toBe(code);
    const codeParts = chunks.flatMap(chunk => (chunk.entities ?? [])
      .filter(entity => entity.type === "pre")
      .map(entity => {
        expect(entity.language).toBe(language);
        return chunk.text.slice(entity.offset, entity.offset + entity.length);
      }));
    expect(codeParts.join("")).toBe(code);
    for (const chunk of chunks) expect(chunk.text.length).toBeLessThanOrEqual(4096);
  });

  it.each([
    ["closed fence", "```python\n    print(1)  \n```", "    print(1)  "],
    ["unclosed fence", "```python\n    print(1)  ", "    print(1)  "],
    ["literal boundary character", "```text\n  \uE000  \n```", "  \uE000  "],
    ["blank code lines", "```text\n\n    value\n\n```", "\n    value\n"],
  ])("preserves code at document edges: %s", (_name, markdown, text) => {
    const chunks = renderTelegramMarkdown(markdown);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].text).toBe(text);
    expect(chunks[0].entities).toEqual([{ type: "pre", offset: 0, length: text.length, language: markdown.includes("python") ? "python" : "text" }]);
  });

  it("preserves text and offsets when splitting at the entity-count limit", () => {
    const words = Array.from({ length: 250 }, (_, i) => `word${i}`);
    const chunks = renderTelegramMarkdown(words.map(word => `**${word}**`).join(" "));
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.map(chunk => chunk.text).join("")).toBe(words.join(" "));
    expect(chunks.flatMap(chunk => {
      expect(chunk.entities!.length).toBeLessThanOrEqual(90);
      return chunk.entities!.map(entity => chunk.text.slice(entity.offset, entity.offset + entity.length));
    })).toEqual(words);
  });

  it.each(["a".repeat(4097), "a".repeat(4095) + "😀" + "z".repeat(10)])(
    "preserves formatting and Unicode at the length boundary",
    text => {
      const chunks = renderTelegramMarkdown(`**${text}**`);
      expect(chunks.map(chunk => chunk.text).join("")).toBe(text);
      for (const chunk of chunks) {
        expect(chunk.text.length).toBeLessThanOrEqual(4096);
        expect(chunk.text.isWellFormed()).toBe(true);
        expect(chunk.entities).toEqual([{ type: "bold", offset: 0, length: chunk.text.length }]);
      }
    }
  );

  it("reports a length limit that cannot contain a rendered Unicode character", () => {
    expect(() => renderTelegramMarkdown("**&#x1F600;x**", { maxLength: 1 }))
      .toThrow("Cannot split a Unicode character within the limit");
  });
});
