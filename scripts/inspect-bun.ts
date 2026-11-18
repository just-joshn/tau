import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export interface FileRange {
  offset: number;
  length: number;
}
export interface MachOSegment extends FileRange {
  name: string;
  address: number;
  virtualSize: number;
  executable: boolean;
}
export interface BunPointer extends FileRange {
  absoluteOffset: number;
  address: number;
}
export interface BunModule {
  id: number;
  name: string;
  pointers: {
    name: BunPointer;
    contents: BunPointer;
    sourcemap: BunPointer;
    bytecode: BunPointer;
    moduleInfo: BunPointer;
    bytecodeOriginPath: BunPointer;
  };
  tags: number[];
  source: FileRange;
  bytecode: FileRange;
}
export interface BunInspection {
  macho: {
    cpuType: number;
    cpuSubtype: number;
    fileType: number;
    commandCount: number;
    commandBytes: number;
  };
  segments: MachOSegment[];
  nativeEntry: { offset: number; address: number; stackSize: number } | null;
  section: FileRange & {
    segment: string;
    name: string;
    address: number;
    graphOffset: number;
    graphAddress: number;
    payloadLength: number;
  };
  footer: {
    offset: number;
    byteCount: number;
    moduleOffset: number;
    moduleLength: number;
    entryPointId: number;
    execArgvOffset: number;
    execArgvLength: number;
    flags: number;
  };
  modules: BunModule[];
}

const trailer = Buffer.from("\n---- Bun! ----\n");

/** Parses only little-endian, 64-bit arm64 Mach-O files; never executes or extracts data. */
export function inspectBun(buffer: Buffer): BunInspection {
  function check(offset: number, length: number, end = buffer.length): void {
    if (
      !Number.isSafeInteger(offset) ||
      !Number.isSafeInteger(length) ||
      offset < 0 ||
      length < 0 ||
      offset > end ||
      length > end - offset
    ) {
      throw new Error(`Invalid range: ${offset}+${length} (limit ${end})`);
    }
  }
  function u64(offset: number): number {
    check(offset, 8);
    const value = buffer.readBigUInt64LE(offset);
    if (value > BigInt(Number.MAX_SAFE_INTEGER))
      throw new Error("Unsafe u64 value");
    return Number(value);
  }
  function fixedName(offset: number): string {
    const bytes = buffer.subarray(offset, offset + 16);
    const nul = bytes.indexOf(0);
    return bytes.subarray(0, nul < 0 ? 16 : nul).toString("ascii");
  }
  check(0, 32);
  if (
    buffer.readUInt32LE(0) !== 0xfeedfacf ||
    buffer.readUInt32LE(4) !== 0x0100000c
  ) {
    throw new Error("Expected little-endian arm64 Mach-O");
  }
  const macho = {
    cpuType: buffer.readUInt32LE(4),
    cpuSubtype: buffer.readUInt32LE(8),
    fileType: buffer.readUInt32LE(12),
    commandCount: buffer.readUInt32LE(16),
    commandBytes: buffer.readUInt32LE(20),
  };
  check(32, macho.commandBytes);
  const commandEnd = 32 + macho.commandBytes;
  let cursor = 32;
  const segments: MachOSegment[] = [];
  let main: { offset: number; stackSize: number } | null = null;
  let section: BunInspection["section"] | undefined;
  for (let i = 0; i < macho.commandCount; i++) {
    check(cursor, 8, commandEnd);
    const command = buffer.readUInt32LE(cursor);
    const size = buffer.readUInt32LE(cursor + 4);
    if (size < 8 || size % 8 !== 0)
      throw new Error("Invalid load command size");
    check(cursor, size, commandEnd);
    if (command === 0x19) {
      if (size < 72) throw new Error("Truncated segment command");
      const segment = fixedName(cursor + 8);
      const segmentAddress = u64(cursor + 24);
      const virtualSize = u64(cursor + 32);
      check(segmentAddress, virtualSize, Number.MAX_SAFE_INTEGER);
      const fileOffset = u64(cursor + 40);
      const fileSize = u64(cursor + 48);
      check(fileOffset, fileSize);
      if (fileSize > virtualSize)
        throw new Error("Segment file size exceeds virtual size");
      segments.push({
        name: segment,
        offset: fileOffset,
        length: fileSize,
        address: segmentAddress,
        virtualSize,
        executable: (buffer.readUInt32LE(cursor + 60) & 4) !== 0,
      });
      const count = buffer.readUInt32LE(cursor + 64);
      if (72 + count * 80 !== size)
        throw new Error("Invalid section table size");
      for (let j = 0; j < count; j++) {
        const pos = cursor + 72 + j * 80;
        if (
          segment !== "__BUN" ||
          fixedName(pos) !== "__bun" ||
          fixedName(pos + 16) !== "__BUN"
        )
          continue;
        if (section) throw new Error("Duplicate Bun section");
        const address = u64(pos + 32);
        const length = u64(pos + 40);
        const offset = buffer.readUInt32LE(pos + 48);
        check(offset, length);
        if (offset < fileOffset || offset + length > fileOffset + fileSize)
          throw new Error("Bun section outside segment");
        if (address !== segmentAddress + (offset - fileOffset))
          throw new Error("Inconsistent Bun section address");
        if (length < 56) throw new Error("Invalid Bun section length");
        const payloadLength = u64(offset);
        if (payloadLength < 48 || payloadLength > length - 8)
          throw new Error("Invalid Bun payload length");
        section = {
          offset,
          length,
          segment,
          name: "__bun",
          address,
          graphOffset: offset + 8,
          graphAddress: address + 8,
          payloadLength,
        };
      }
    } else if (command === 0x80000028) {
      if (size !== 24 || main) throw new Error("Invalid or duplicate LC_MAIN");
      main = { offset: u64(cursor + 8), stackSize: u64(cursor + 16) };
    }
    cursor += size;
  }
  if (cursor !== commandEnd) throw new Error("Invalid load command count");
  let nativeEntry: BunInspection["nativeEntry"] = null;
  if (main) {
    const entryOffset = main.offset;
    const candidates = segments.filter(
      (segment) =>
        segment.executable &&
        entryOffset >= segment.offset &&
        entryOffset - segment.offset <= segment.length - 4,
    );
    const segment = candidates[0];
    if (candidates.length !== 1 || !segment || entryOffset % 4 !== 0)
      throw new Error("Invalid native entry mapping");
    const address = segment.address + (entryOffset - segment.offset);
    if (address % 4 !== 0) throw new Error("Unaligned native entry address");
    nativeEntry = { offset: entryOffset, address, stackSize: main.stackSize };
  }
  if (!section) throw new Error("Missing __BUN,__bun section");
  const end = section.graphOffset + section.payloadLength;
  if (!buffer.subarray(end - 16, end).equals(trailer))
    throw new Error("Invalid Bun trailer");
  const footerOffset = end - 48;
  const footer = {
    offset: footerOffset,
    byteCount: u64(footerOffset),
    moduleOffset: buffer.readUInt32LE(footerOffset + 8),
    moduleLength: buffer.readUInt32LE(footerOffset + 12),
    entryPointId: buffer.readUInt32LE(footerOffset + 16),
    execArgvOffset: buffer.readUInt32LE(footerOffset + 20),
    execArgvLength: buffer.readUInt32LE(footerOffset + 24),
    flags: buffer.readUInt32LE(footerOffset + 28),
  };
  if (footer.byteCount !== footerOffset - section.graphOffset)
    throw new Error("Invalid graph byte_count");
  check(footer.moduleOffset, footer.moduleLength, footer.byteCount);
  check(footer.execArgvOffset, footer.execArgvLength, footer.byteCount);
  if (footer.moduleLength === 0 || footer.moduleLength % 52 !== 0)
    throw new Error("Invalid module table length");
  const count = footer.moduleLength / 52;
  if (footer.entryPointId >= count) throw new Error("Invalid entry point ID");
  const graphOffset = section.graphOffset;
  const graphAddress = section.graphAddress;
  function pointer(pos: number): BunPointer {
    const offset = buffer.readUInt32LE(pos);
    const length = buffer.readUInt32LE(pos + 4);
    check(offset, length, footer.byteCount);
    return {
      offset,
      length,
      absoluteOffset: graphOffset + offset,
      address: graphAddress + offset,
    };
  }
  const modules: BunModule[] = [];
  for (let id = 0; id < count; id++) {
    const pos = section.graphOffset + footer.moduleOffset + id * 52;
    const pointers = {
      name: pointer(pos),
      contents: pointer(pos + 8),
      sourcemap: pointer(pos + 16),
      bytecode: pointer(pos + 24),
      moduleInfo: pointer(pos + 32),
      bytecodeOriginPath: pointer(pos + 40),
    };
    modules.push({
      id,
      name: buffer
        .subarray(
          pointers.name.absoluteOffset,
          pointers.name.absoluteOffset + pointers.name.length,
        )
        .toString("utf8"),
      pointers,
      tags: [...buffer.subarray(pos + 48, pos + 52)],
      source: {
        offset: pointers.contents.absoluteOffset,
        length: pointers.contents.length,
      },
      bytecode: {
        offset: pointers.bytecode.absoluteOffset,
        length: pointers.bytecode.length,
      },
    });
  }
  return { macho, segments, nativeEntry, section, footer, modules };
}

function unionBytes(ranges: FileRange[]): number {
  let end = 0;
  let total = 0;
  for (const range of ranges
    .filter((range) => range.length > 0)
    .sort((a, b) => a.offset - b.offset)) {
    total += Math.max(
      0,
      range.offset + range.length - Math.max(end, range.offset),
    );
    end = Math.max(end, range.offset + range.length);
  }
  return total;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const paths = args.filter((arg) => arg !== "--modules");
  if (
    paths.length !== 1 ||
    paths[0] === undefined ||
    paths[0].startsWith("--")
  ) {
    throw new Error("Usage: bun scripts/inspect-bun.ts PATH [--modules]");
  }
  const result = inspectBun(await readFile(paths[0]));
  const javascript = result.modules.filter((module) => module.tags[1] === 1);
  const summary = {
    macho: result.macho,
    segments: result.segments,
    nativeEntry: result.nativeEntry,
    section: result.section,
    footer: result.footer,
    moduleCount: result.modules.length,
    entryPoint: result.modules[result.footer.entryPointId],
    contentsBytes: result.modules.reduce(
      (sum, module) => sum + module.source.length,
      0,
    ),
    javascriptModuleCount: javascript.length,
    javascriptContentsBytes: javascript.reduce(
      (sum, module) => sum + module.source.length,
      0,
    ),
    bytecodeUnionBytes: unionBytes(
      result.modules.map((module) => module.bytecode),
    ),
    ...(args.includes("--modules") ? { modules: result.modules } : {}),
  };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main().catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
