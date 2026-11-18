import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "bun:test";
import {
  parseMcpCallResult,
  projectMcpResult,
  type McpCallResult,
} from "../../src/mcp-content.js";

const b64 = (text: string) => Buffer.from(text).toString("base64");
const project = (raw: McpCallResult, options = {}) =>
  projectMcpResult(raw, { serverName: "srv", ...options });

async function withDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "tau-mcp-content-"));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("a result that is not an object, or carries malformed fields, is rejected", () => {
  const cases: [unknown, RegExp][] = [
    [null, /invalid result object/],
    [[], /invalid result object/],
    [{ content: [], isError: "yes" }, /isError must be a boolean/],
    [{ content: [], _meta: [] }, /_meta must be an object/],
    [{ content: [null] }, /^Error: Invalid MCP content block$/],
    [{ content: ["text"] }, /^Error: Invalid MCP content block$/],
  ];
  for (const [value, message] of cases)
    assert.throws(() => parseMcpCallResult(value), message);
});

test("image MIME types are matched case-insensitively and image/jpg means JPEG", async () => {
  const projection = await project({
    content: [
      { type: "image", data: b64("a"), mimeType: "IMAGE/JPG; q=1" },
      { type: "image", data: b64("b"), mimeType: "image/gif" },
      { type: "image", data: b64("c"), mimeType: "image/webp" },
    ],
  });
  assert.deepEqual(
    projection.blocks.map((block) =>
      block.type === "image" ? block.source.media_type : block.type,
    ),
    ["image/jpeg", "image/gif", "image/webp"],
  );
  assert.equal(
    projection.text,
    "[Image: image/jpeg]\n[Image: image/gif]\n[Image: image/webp]",
  );
});

test("binary content without a result directory is described, not dropped", async () => {
  const projection = await project({
    content: [
      { type: "audio", data: b64("wave"), mimeType: "" },
      { type: "image", data: b64("<svg/>"), mimeType: "image/svg+xml" },
    ],
  });
  assert.deepEqual(projection.text.split("\n"), [
    "[Audio from srv] Binary content (unknown type, 4 bytes) could not be saved to disk: no result directory configured",
    "[Image from srv] Binary content (image/svg+xml, 6 bytes) could not be saved to disk: no result directory configured",
  ]);
});

test("a PDF is saved as a file when no inline budget is given", async () => {
  await withDir(async (dir) => {
    const projection = await project(
      {
        content: [
          {
            type: "resource",
            resource: {
              uri: "file:///a.pdf",
              mimeType: "application/pdf",
              blob: b64("%PDF-1.4"),
            },
          },
        ],
      },
      { outputDirectory: dir },
    );
    assert.deepEqual(
      projection.blocks.map((block) => block.type),
      ["text"],
    );
    const [file] = await readdir(dir);
    assert.match(file ?? "", /^mcp-srv-blob-.*\.pdf$/);
    assert.equal(await readFile(join(dir, file ?? ""), "utf8"), "%PDF-1.4");
  });
});

test("unknown and missing media types are saved with a .bin extension", async () => {
  await withDir(async (dir) => {
    const projection = await project(
      {
        content: [
          {
            type: "resource",
            resource: { uri: "mem://x", blob: b64("raw") },
          },
        ],
      },
      { outputDirectory: dir },
    );
    const [file] = await readdir(dir);
    assert.match(file ?? "", /\.bin$/);
    assert.equal(
      projection.text,
      `[Resource from srv at mem://x] Binary content (unknown type, 3 bytes) saved to ${join(dir, file ?? "")}`,
    );
  });
});

test("a failed save reports the file-system error in place of the content", async () => {
  await withDir(async (dir) => {
    const blocker = join(dir, "not-a-directory");
    await writeFile(blocker, "");
    const projection = await project(
      { content: [{ type: "audio", data: b64("x"), mimeType: "" }] },
      { outputDirectory: blocker },
    );
    assert.match(
      projection.text,
      /^\[Audio from srv\] Binary content \(unknown type, 1 bytes\) could not be saved to disk: .*(EEXIST|ENOTDIR|not a directory)/,
    );
  });
});

test("an image resource is labelled before the image; a non-renderable one is saved", async () => {
  const projection = await project({
    content: [
      {
        type: "resource",
        resource: { uri: "u:1", mimeType: "image/png", blob: b64("png") },
      },
      {
        type: "resource",
        resource: { uri: "u:2", mimeType: "image/tiff", blob: b64("tif") },
      },
    ],
  });
  assert.deepEqual(projection.text.split("\n"), [
    "[Resource from srv at u:1] ",
    "[Image: image/png]",
    "[Resource from srv at u:2] Binary content (image/tiff, 3 bytes) could not be saved to disk: no result directory configured",
  ]);
});

test("a resource with neither text nor blob projects to nothing", async () => {
  const projection = await project({
    content: [{ type: "resource", resource: { uri: "u:empty" } }],
  });
  assert.deepEqual(projection.blocks, []);
});

test("resource links show their description when present", async () => {
  const projection = await project({
    content: [
      { type: "resource_link", uri: "u:a", name: "a" },
      { type: "resource_link", uri: "u:b", name: "b", description: "bee" },
    ],
  });
  assert.equal(
    projection.text,
    "[Resource link: a] u:a\n[Resource link: b] u:b (bee)",
  );
});

test("an error result keeps text and links, and drops binary content", async () => {
  const projection = await project({
    isError: true,
    content: [
      { type: "image", data: b64("x"), mimeType: "image/png" },
      { type: "text", text: "boom" },
      { type: "resource_link", uri: "u:log", name: "log" },
    ],
  });
  assert.deepEqual(projection, {
    text: "boom\n[Resource link: log] u:log",
    blocks: [
      { type: "text", text: "boom" },
      { type: "text", text: "[Resource link: log] u:log" },
    ],
    isError: true,
  });
});

test("an error result with only binary content, or a structured error, still explains itself", async () => {
  const binaryOnly = await project({
    isError: true,
    content: [{ type: "image", data: b64("x"), mimeType: "image/png" }],
    error: "ignored because content exists",
  });
  assert.equal(binaryOnly.text, "Unknown error");
  const structured = await project({
    isError: true,
    content: [],
    error: { code: 7 },
  });
  assert.equal(structured.text, '{"code":7}');
});

test("with preferContent, structured content is a fallback only when content is blank", async () => {
  const blank = await project(
    { content: [{ type: "text", text: "  " }], structuredContent: { a: 1 } },
    { preferContent: true },
  );
  assert.equal(blank.text, '  \n{"a":1}');
  const text = await project(
    { content: [{ type: "text", text: "hi" }], structuredContent: { a: 1 } },
    { preferContent: true },
  );
  assert.equal(text.text, "hi");
  const image = await project(
    {
      content: [{ type: "image", data: b64("x"), mimeType: "image/png" }],
      structuredContent: { a: 1 },
    },
    { preferContent: true },
  );
  assert.equal(image.text, "[Image: image/png]");
});
