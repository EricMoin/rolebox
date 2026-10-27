import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHashlineReadTool, formatReadOutput } from "../../src/hashline/hashline-read.ts";
import { hasTar } from "../helpers/tar.ts";
import { makeToolContext } from "./fixtures/tool-context.ts";

describe("file byte decoding compatibility", () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "hashline-read-decode-"));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  async function expectLegacyRead(bytes: Buffer): Promise<void> {
    const filePath = join(directory, "file.txt");
    await writeFile(filePath, bytes);
    const legacyText = await readFile(filePath, "utf8");
    const tool = createHashlineReadTool();
    for (let read = 0; read < 2; read++) {
      const actual = await tool.execute(
        { filePath, offset: 1, limit: 3 }, makeToolContext(directory),
      );
      expect(actual).toBe(formatReadOutput(legacyText, filePath, 1, 3));
    }
  }

  it.each([
    ["empty", Buffer.alloc(0)],
    ["BOM only", Buffer.from("\uFEFF")],
    ["BOM and mixed line endings", Buffer.from("\uFEFF汉字🙂\r\nnext\rvalue\n")],
    ["all byte values", Buffer.from(Array.from({ length: 256 }, (_, i) => i))],
    ["truncated sequences", Buffer.from([0x61, 0x0a, 0xe2, 0x82])],
    ["invalid surrogate and overlong sequences", Buffer.from([0xed, 0xa0, 0x80, 0xc0, 0xaf, 0xf4, 0x90, 0x80, 0x80])],
  ])("matches the encoded reader for %s", async (_name, bytes) => {
    await expectLegacyRead(bytes);
  });

  for (const boundary of [512 * 1024, 1024 * 1024]) {
    for (const split of [1, 2, 3]) {
      it(`preserves UTF-8 crossing byte ${boundary} after ${split} bytes`, async () => {
        await expectLegacyRead(Buffer.concat([
          Buffer.alloc(boundary - split, 0x61),
          Buffer.from("🙂\n汉字é\r\nlast\n"),
        ]));
      });
    }
  }

  it("preserves invalid UTF-8 at decoder boundaries and EOF", async () => {
    await expectLegacyRead(Buffer.concat([
      Buffer.alloc(512 * 1024 - 2, 0x61),
      Buffer.from([0xf0, 0x9f, 0x28, 0x80, 0x0a]),
      Buffer.alloc(512 * 1024 - 5, 0x62),
      Buffer.from([0xe2, 0x82]),
    ]));
  });

  it("retains replacement-character semantics when cached bytes change", async () => {
    const filePath = join(directory, "file.txt");
    const tool = createHashlineReadTool();
    for (const bytes of [Buffer.from([0xff]), Buffer.from([0xfe]), Buffer.from([0x61])]) {
      await writeFile(filePath, bytes);
      expect(await tool.execute({ filePath }, makeToolContext(directory))).toBe(
        formatReadOutput(await readFile(filePath, "utf8"), filePath),
      );
    }
  });

  it("observes same-size changes from CRLF to lone CR and LF after a cached read", async () => {
    const filePath = join(directory, "file.txt");
    const tool = createHashlineReadTool();
    const contents = ["\uFEFFalpha\r\nbeta\rvalue\n", "\uFEFFalpha\rXbeta\rvalue\n", "\uFEFFALPHA\nXbeta\nvalue\n"];
    expect(new Set(contents.map((content) => Buffer.byteLength(content))).size).toBe(1);
    const versions = new Set<string>();
    for (const [index, content] of contents.entries()) {
      await writeFile(filePath, content);
      const actual = String(await tool.execute({ filePath }, makeToolContext(directory)));
      expect(actual).toBe(formatReadOutput(await readFile(filePath, "utf8"), filePath));
      expect(actual).toContain(`totalLines: ${index === 0 ? 2 : 3}`);
      versions.add(actual.split("\n")[0]);
    }
    expect(versions.size).toBe(contents.length);
  });

  it.skipIf(!hasTar() || process.platform === "win32")("follows symbolic links on every read", async () => {
    const target = join(directory, "target.txt");
    const filePath = join(directory, "link.txt");
    await writeFile(target, "first\n");
    await symlink(target, filePath);
    const tool = createHashlineReadTool();
    for (const content of ["first\n", "second\n"]) {
      await writeFile(target, content);
      expect(await tool.execute({ filePath }, makeToolContext(directory))).toBe(
        formatReadOutput(content, filePath),
      );
    }
  });

  it("retains missing-file and directory behavior", async () => {
    const tool = createHashlineReadTool();
    const filePath = join(directory, "missing.txt");
    expect(await tool.execute({ filePath }, makeToolContext(directory))).toBe(
      `Error: File not found: ${filePath}`,
    );
    const expected = await readFile(directory, "utf8").then(
      (text) => formatReadOutput(text, directory),
      (error: Error) => `Error reading file: ${error.message}`,
    );
    expect(await tool.execute({ filePath: directory }, makeToolContext(directory))).toBe(expected);
  });

  it.skipIf(!hasTar() || !existsSync("/dev/null"))("reads a device whose size is zero", async () => {
    const tool = createHashlineReadTool();
    for (let read = 0; read < 2; read++) {
      expect(await tool.execute(
        { filePath: "/dev/null" }, makeToolContext(directory),
      )).toBe(formatReadOutput(await readFile("/dev/null", "utf8"), "/dev/null"));
    }
  });

  it.skipIf(!hasTar() || process.platform === "win32")("reads a nonempty FIFO with unknown size to EOF", async (context) => {
    const filePath = join(directory, "pipe");
    const created = spawnSync("mkfifo", [filePath], { stdio: "ignore" });
    if (created.error && "code" in created.error && created.error.code === "ENOENT") {
      context.skip();
      return;
    }
    expect(created.status).toBe(0);
    const bytes = Buffer.concat([Buffer.from("\uFEFF"), Buffer.alloc(200_000, 0x61), Buffer.from("🙂\r\nlast\n")]);
    const [legacyText] = await Promise.all([readFile(filePath, "utf8"), writeFile(filePath, bytes)]);
    const tool = createHashlineReadTool();
    for (let read = 0; read < 2; read++) {
      const [actual] = await Promise.all([
        tool.execute({ filePath }, makeToolContext(directory)),
        writeFile(filePath, bytes),
      ]);
      expect(actual).toBe(formatReadOutput(legacyText, filePath));
    }
  });
});
