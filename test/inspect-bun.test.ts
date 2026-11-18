import assert from "node:assert/strict";
import test from "node:test";
import { inspectBun } from "../scripts/inspect-bun.js";

const section = 184;
const graph = section + 8;
const byteCount = 96;
const footer = graph + byteCount;
const record = graph + 40;

function fixture(): Buffer {
  const buffer = Buffer.alloc(footer + 48);
  buffer.writeUInt32LE(0xfeedfacf, 0);
  buffer.writeUInt32LE(0x0100000c, 4);
  buffer.writeUInt32LE(2, 12);
  buffer.writeUInt32LE(1, 16);
  buffer.writeUInt32LE(152, 20);
  buffer.writeUInt32LE(0x19, 32);
  buffer.writeUInt32LE(152, 36);
  buffer.write("__BUN", 40);
  buffer.writeBigUInt64LE(BigInt(buffer.length - section), 64);
  buffer.writeBigUInt64LE(BigInt(section), 72);
  buffer.writeBigUInt64LE(BigInt(buffer.length - section), 80);
  buffer.writeUInt32LE(1, 96);
  buffer.write("__bun", 104);
  buffer.write("__BUN", 120);
  buffer.writeBigUInt64LE(BigInt(buffer.length - section), 144);
  buffer.writeUInt32LE(section, 152);
  buffer.writeBigUInt64LE(BigInt(buffer.length - section - 8), section);
  buffer.write("../../inert.js", graph);
  buffer.write("hello", graph + 16);
  buffer.writeUInt32LE(14, record + 4);
  buffer.writeUInt32LE(16, record + 8);
  buffer.writeUInt32LE(5, record + 12);
  buffer.writeUInt32LE(24, record + 24);
  buffer.writeUInt32LE(4, record + 28);
  buffer.set([1, 2, 3, 4], record + 48);
  buffer.writeBigUInt64LE(BigInt(byteCount), footer);
  buffer.writeUInt32LE(40, footer + 8);
  buffer.writeUInt32LE(52, footer + 12);
  buffer.write("\n---- Bun! ----\n", footer + 32);
  return buffer;
}

test("static inspector exposes bounded graph coordinates and inert module metadata", () => {
  const result = inspectBun(fixture());
  assert.equal(result.nativeEntry, null);
  assert.equal(result.section.offset, section);
  assert.equal(result.section.graphOffset, graph);
  assert.equal(result.footer.byteCount, byteCount);
  assert.equal(result.footer.entryPointId, 0);
  assert.equal(result.modules.length, 1);
  const module = result.modules[0];
  assert.ok(module);
  assert.equal(module.name, "../../inert.js");
  assert.deepEqual(module.tags, [1, 2, 3, 4]);
  assert.deepEqual(module.source, { offset: graph + 16, length: 5 });
  assert.deepEqual(module.bytecode, { offset: graph + 24, length: 4 });
  assert.equal(Object.keys(module.pointers).length, 6);
  assert.equal(module.pointers.contents.address, 24);
});

function nativeFixture(): Buffer {
  const base = fixture();
  const buffer = Buffer.concat([base.subarray(0, section), Buffer.alloc(104), base.subarray(section)]);
  buffer.writeUInt32LE(3, 16);
  buffer.writeUInt32LE(248, 20);
  buffer.writeBigUInt64LE(0x200000000n, 56);
  buffer.writeBigUInt64LE(288n, 72);
  buffer.writeBigUInt64LE(0x200000000n, 136);
  buffer.writeUInt32LE(288, 152);
  buffer.writeUInt32LE(0x19, 184);
  buffer.writeUInt32LE(72, 188);
  buffer.write("__TEXT", 192);
  buffer.writeBigUInt64LE(0x100000000n, 208);
  buffer.writeBigUInt64LE(288n, 216);
  buffer.writeBigUInt64LE(288n, 232);
  buffer.writeUInt32LE(5, 240);
  buffer.writeUInt32LE(5, 244);
  buffer.writeUInt32LE(0x80000028, 256);
  buffer.writeUInt32LE(24, 260);
  buffer.writeBigUInt64LE(280n, 264);
  buffer.writeBigUInt64LE(4096n, 272);
  buffer.writeUInt32LE(0xd65f03c0, 280);
  return buffer;
}

test("distinguishes native LC_MAIN from the bundled JavaScript entry and maps virtual addresses", () => {
  const result = inspectBun(nativeFixture());
  assert.deepEqual(result.nativeEntry, { offset: 280, address: 0x100000118, stackSize: 4096 });
  assert.equal(result.footer.entryPointId, 0);
  assert.equal(result.section.address, 0x200000000);
  assert.equal(result.section.graphAddress, 0x200000008);
  assert.equal(result.modules[0]?.pointers.contents.address, 0x200000018);
  assert.equal(result.segments.find(segment => segment.name === "__BUN")?.executable, false);
  assert.equal(result.segments.find(segment => segment.name === "__TEXT")?.executable, true);
});

test("native mapping uses the segment's file offset rather than assuming address equals image base plus file offset", () => {
  const buffer = nativeFixture();
  buffer.writeBigUInt64LE(8n, 216);
  buffer.writeBigUInt64LE(280n, 224);
  buffer.writeBigUInt64LE(8n, 232);
  assert.equal(inspectBun(buffer).nativeEntry?.address, 0x100000000);
});

test("rejects malformed native entries, segment mappings and unsafe addresses", () => {
  const corruptions: Array<(buffer: Buffer) => void> = [
    b => b.writeUInt32LE(16, 260),
    b => b.writeBigUInt64LE(281n, 264),
    b => b.writeBigUInt64LE(288n, 264),
    b => b.writeBigUInt64LE(2n ** 63n, 264),
    b => b.writeUInt32LE(1, 244),
    b => b.writeBigUInt64LE(0x100000001n, 208),
    b => b.writeBigUInt64LE(2n ** 53n - 5n, 208),
    b => b.writeBigUInt64LE(1n, 216),
    b => b.writeBigUInt64LE(1n, 136),
    b => { b.writeUInt32LE(5, 92); b.writeBigUInt64LE(280n, 72); b.writeUInt32LE(280, 152); },
  ];
  for (const [index, corrupt] of corruptions.entries()) {
    const buffer = nativeFixture();
    corrupt(buffer);
    assert.throws(() => inspectBun(buffer), `native corruption ${index}`);
  }
});

test("rejects every truncated native fixture prefix", () => {
  const buffer = nativeFixture();
  for (let length = 0; length < buffer.length; length++) {
    assert.throws(() => inspectBun(buffer.subarray(0, length)), `native prefix ${length}`);
  }
});

test("Bun length prefix bounds the graph independently of unused section padding", () => {
  const base = fixture();
  const buffer = Buffer.concat([base, Buffer.alloc(32, 0xa5)]);
  const length = buffer.length - section;
  buffer.writeBigUInt64LE(BigInt(length), 64);
  buffer.writeBigUInt64LE(BigInt(length), 80);
  buffer.writeBigUInt64LE(BigInt(length), 144);
  const result = inspectBun(buffer);
  assert.equal(result.section.payloadLength, base.length - graph);
  assert.equal(result.section.length, length);
  assert.equal(result.footer.offset, footer);
  assert.deepEqual(result.modules, inspectBun(base).modules);
  for (const declared of [0n, 47n, BigInt(length)]) {
    const invalid = Buffer.from(buffer);
    invalid.writeBigUInt64LE(declared, section);
    assert.throws(() => inspectBun(invalid));
  }
  const pointerIntoPadding = Buffer.from(buffer);
  pointerIntoPadding.writeUInt32LE(byteCount + 48, record + 8);
  assert.throws(() => inspectBun(pointerIntoPadding));
  const wrongTrailer = Buffer.from(buffer);
  wrongTrailer.writeUInt8(0, base.length - 1);
  wrongTrailer.write("\n---- Bun! ----\n", wrongTrailer.length - 16);
  assert.throws(() => inspectBun(wrongTrailer));
});

test("rejects every truncated prefix", () => {
  const buffer = fixture();
  for (let length = 0; length < buffer.length; length++) {
    assert.throws(() => inspectBun(buffer.subarray(0, length)), `prefix ${length}`);
  }
});

test("rejects malformed headers, commands, footers and each graph pointer", () => {
  const corruptions: Array<(buffer: Buffer) => void> = [
    b => b.writeUInt32LE(0, 0),
    b => b.writeUInt32LE(0, 4),
    b => b.writeUInt32LE(2, 16),
    b => b.writeUInt32LE(144, 20),
    b => b.writeUInt32LE(0, 36),
    b => b.writeUInt32LE(8, 36),
    b => b.writeUInt32LE(2, 96),
    b => b.writeBigUInt64LE(2n ** 63n, 144),
    b => b.writeUInt32LE(section - 1, 152),
    b => b.writeBigUInt64LE(0n, section),
    b => b.writeUInt8(0, b.length - 1),
    b => b.writeBigUInt64LE(BigInt(byteCount + 1), footer),
    b => b.writeUInt32LE(byteCount, footer + 8),
    b => b.writeUInt32LE(51, footer + 12),
    b => b.writeUInt32LE(0, footer + 12),
    b => b.writeUInt32LE(1, footer + 16),
    b => b.writeUInt32LE(byteCount + 1, footer + 20),
    b => b.writeUInt32LE(byteCount + 1, footer + 24),
  ];
  for (let field = 0; field < 6; field++) {
    corruptions.push(b => b.writeUInt32LE(byteCount + 1, record + field * 8));
    corruptions.push(b => b.writeUInt32LE(byteCount + 1, record + field * 8 + 4));
  }
  for (const [index, corrupt] of corruptions.entries()) {
    const buffer = fixture();
    corrupt(buffer);
    assert.throws(() => inspectBun(buffer), `corruption ${index}`);
  }
});
