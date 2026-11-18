import { contextUsage } from "./context-usage.js";
import type { Usage } from "./types.js";
import type { FileTokenCounter } from "./file-read.js";

export interface ContextRoom {
  readonly threshold: number;
  readonly apiLimit: number;
  held(): number;
  claimed(): number;
  claim(tokens: number): void;
}

/** One model round's auxiliary tool admission. A new instance resets its claims. */
export class ModelContextRoom implements ContextRoom {
  private claims = 0;
  constructor(private readonly limit: () => number, readonly apiLimit: number, readonly held: () => number) {}
  get threshold(): number { return this.limit(); }
  claimed(): number { return this.claims; }
  claim(tokens: number): void {
    if (!Number.isFinite(tokens) || tokens < 0) throw new Error("Invalid context-room token claim");
    this.claims += tokens;
  }
}

export interface ReadToolContext {
  room?: ContextRoom;
  parentUsage?: Usage;
  bytesPerToken: number;
  countTokens?: FileTokenCounter;
  remote?: boolean;
  inputFromAnotherMachine?: boolean;
}
export interface ReadAllowance { roomTokens?: number; raised?: { maxTokens: number; maxSizeBytes: number } }

export function readAllowance(context: ReadToolContext | undefined, maxTokens: number, maxSizeBytes: number): ReadAllowance {
  const room = context?.room;
  if (!room || context.remote || context.inputFromAnotherMachine) return {};
  const usage = context.parentUsage ? contextUsage(context.parentUsage) : undefined;
  const inputs = usage ? usage.input_tokens + usage.cache_creation_input_tokens + usage.cache_read_input_tokens : 0;
  const parent = usage && inputs > 0 ? inputs + usage.output_tokens : 0;
  const held = Math.max(parent, room.held()) + room.claimed();
  const roomTokens = Math.max(0, Math.floor((room.threshold - held) * 0.7));
  return roomTokens <= maxTokens ? { roomTokens } : { roomTokens,
    raised: { maxTokens: roomTokens, maxSizeBytes: Math.max(maxSizeBytes, roomTokens * context.bytesPerToken * 3) } };
}
