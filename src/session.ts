import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, readdir, rename, rm, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";
import { messageSchema } from "./types.js";
import type { BackgroundTaskSnapshot } from "./background-agent-runtime.js";

export const sessionSchema = z.object({
  version: z.literal(1),
  id: z.uuid(),
  cwd: z.string(),
  model: z.string().min(1),
  updatedAt: z.iso.datetime(),
  messages: z.array(messageSchema),
  systemPrompt: z.string().optional(),
  planState: z
    .object({
      active: z.boolean(),
      slug: z.string().optional(),
      prePlanMode: z
        .enum(["default", "acceptEdits", "plan", "bypassPermissions"])
        .optional(),
      bypassAvailable: z.boolean().optional(),
    })
    .optional(),
  usage: z.object({
    input_tokens: z.number().nonnegative(),
    output_tokens: z.number().nonnegative(),
  }),
  compaction: z
    .object({
      compacted: z.boolean(),
      turnCounter: z.number().int().nonnegative(),
      consecutiveFailures: z.number().int().nonnegative(),
      consecutiveRapidRefills: z.number().int().nonnegative(),
    })
    .optional(),
});
export type Session = z.infer<typeof sessionSchema>;
export const subagentArchiveSchema = z.object({
  version: z.literal(1),
  parentSessionId: z.uuid(),
  agentId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  agentType: z.string(),
  cwd: z.string(),
  model: z.string(),
  updatedAt: z.iso.datetime(),
  messages: z.array(messageSchema),
  status: z.enum(["running", "completed", "max_turns", "interrupted"]),
});
export type SubagentArchive = z.infer<typeof subagentArchiveSchema>;

export function newSession(cwd: string, model: string): Session {
  return {
    version: 1,
    id: randomUUID(),
    cwd,
    model,
    updatedAt: new Date().toISOString(),
    messages: [],
    usage: { input_tokens: 0, output_tokens: 0 },
  };
}

export class SessionStore {
  private constructor(
    private readonly directory: string,
    private readonly cwd: string,
  ) {}

  static async create(
    cwd: string,
    home = process.env.TAU_HOME ?? join(homedir(), ".tau"),
  ): Promise<SessionStore> {
    const canonical = await realpath(cwd);
    const key = createHash("sha256")
      .update(canonical)
      .digest("hex")
      .slice(0, 24);
    return new SessionStore(join(resolve(home), "sessions", key), canonical);
  }

  pathFor(id: string): string {
    return join(this.directory, `${z.uuid().parse(id)}.json`);
  }

  /** Own JSON child archives are nested beneath the parent, outside latest-session selection. */
  subagentPathFor(parentSessionId: string, agentId: string): string {
    return join(
      this.directory,
      z.uuid().parse(parentSessionId),
      "subagents",
      `${subagentArchiveSchema.shape.agentId.parse(agentId)}.json`,
    );
  }

  backgroundOutputPathFor(parentSessionId: string, agentId: string): string {
    return this.subagentPathFor(parentSessionId, agentId).replace(
      /\.json$/,
      ".output",
    );
  }

  /** Owned JSON task state and message JSONL; native sidecars and symlink format are separate adapters. */
  async saveBackgroundTask(
    snapshot: Readonly<BackgroundTaskSnapshot>,
  ): Promise<void> {
    const parent = z.uuid().parse(snapshot.sessionId),
      agent = subagentArchiveSchema.shape.agentId.parse(snapshot.agentId);
    const base = this.subagentPathFor(parent, agent).replace(/\.json$/, "");
    const values = [
      [`${base}.task.json`, JSON.stringify({ version: 1, ...snapshot }) + "\n"],
      [
        this.backgroundOutputPathFor(parent, agent),
        snapshot.messages
          .map((message) => JSON.stringify(messageSchema.parse(message)))
          .join("\n") + (snapshot.messages.length ? "\n" : ""),
      ],
    ] as const;
    for (const [, text] of values)
      if (Buffer.byteLength(text) > 32 * 1024 * 1024)
        throw new Error(
          "Background archive exceeds 32 MiB; previous files preserved",
        );
    await mkdir(join(this.directory, parent, "subagents"), {
      recursive: true,
      mode: 0o700,
    });
    for (const [destination, text] of values) {
      const temporary = `${destination}.${randomUUID()}.tmp`;
      try {
        const file = await open(temporary, "wx", 0o600);
        try {
          await file.writeFile(text);
        } finally {
          await file.close();
        }
        await rename(temporary, destination);
      } finally {
        await rm(temporary, { force: true });
      }
    }
  }

  async saveSubagent(archive: SubagentArchive): Promise<void> {
    const parsed = subagentArchiveSchema.parse({
      ...archive,
      updatedAt: new Date().toISOString(),
    });
    if (parsed.cwd !== this.cwd)
      throw new Error("Subagent belongs to another working directory");
    const serialized = JSON.stringify(parsed) + "\n";
    if (Buffer.byteLength(serialized) > 32 * 1024 * 1024)
      throw new Error(
        "Subagent archive exceeds 32 MiB; previous archive was preserved",
      );
    const destination = this.subagentPathFor(
      parsed.parentSessionId,
      parsed.agentId,
    );
    await mkdir(join(this.directory, parsed.parentSessionId, "subagents"), {
      recursive: true,
      mode: 0o700,
    });
    const temporary = `${destination}.${randomUUID()}.tmp`;
    try {
      const file = await open(temporary, "wx", 0o600);
      try {
        await file.writeFile(serialized);
      } finally {
        await file.close();
      }
      await rename(temporary, destination);
    } finally {
      await rm(temporary, { force: true });
    }
  }

  async save(session: Session): Promise<void> {
    const parsed = sessionSchema.parse({
      ...session,
      updatedAt: new Date().toISOString(),
    });
    if (parsed.cwd !== this.cwd)
      throw new Error("Session belongs to another working directory");
    const serialized = JSON.stringify(parsed) + "\n";
    if (Buffer.byteLength(serialized) > 32 * 1024 * 1024)
      throw new Error(
        "Session exceeds 32 MiB limit; previous saved session was preserved",
      );
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const destination = this.pathFor(parsed.id);
    const temporary = `${destination}.${randomUUID()}.tmp`;
    try {
      const file = await open(temporary, "wx", 0o600);
      try {
        await file.writeFile(serialized);
      } finally {
        await file.close();
      }
      await rename(temporary, destination);
    } finally {
      await rm(temporary, { force: true });
    }
  }

  async load(id: string): Promise<Session> {
    const safeId = z.uuid().parse(id);
    const file = await open(
      this.pathFor(safeId),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    let content: string;
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size > 32 * 1024 * 1024)
        throw new Error("Session must be a regular file under 32 MiB");
      const buffer = Buffer.alloc(info.size + 1);
      let size = 0;
      while (size < buffer.length) {
        const { bytesRead } = await file.read(
          buffer,
          size,
          buffer.length - size,
          null,
        );
        if (!bytesRead) break;
        size += bytesRead;
      }
      if (size > info.size) throw new Error("Session changed while loading");
      content = buffer.subarray(0, size).toString("utf8");
    } finally {
      await file.close();
    }
    const session = sessionSchema.parse(JSON.parse(content));
    if (session.id !== safeId || session.cwd !== this.cwd)
      throw new Error("Session identity or working directory mismatch");
    return session;
  }

  async latest(): Promise<Session> {
    let names: string[];
    try {
      names = await readdir(this.directory);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        throw new Error("No saved sessions in this directory");
      throw error;
    }
    const sessions = await Promise.all(
      names
        .filter((name) => name.endsWith(".json"))
        .map((name) => this.load(name.slice(0, -5))),
    );
    sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const latest = sessions[0];
    if (!latest) throw new Error("No saved sessions in this directory");
    return latest;
  }
}
