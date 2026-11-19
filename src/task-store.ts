import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  rmdir,
  unlink,
  utimes,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { isAbsolute, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";

export const taskStatusSchema = z.enum(["pending", "in_progress", "completed"]);
export const localTaskSchema = z.object({
  id: z.string(),
  subject: z.string(),
  description: z.string(),
  activeForm: z.string().optional(),
  owner: z.string().optional(),
  status: taskStatusSchema,
  blocks: z.array(z.string()),
  blockedBy: z.array(z.string()),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type LocalTask = z.infer<typeof localTaskSchema>;
export type LocalTaskPatch = Partial<Omit<LocalTask, "id">>;
export interface LocalTaskStoreOptions {
  /** Explicit absolute disposable task root; no home/settings discovery occurs. */
  root: string;
  listId: string;
  maxFileBytes?: number;
  lock?: { retries?: number; staleMs?: number; updateMs?: number };
  onDiagnostic?(message: string): void;
}
export const sanitizeTaskIdentity = (value: string) =>
  value.replace(/[^a-zA-Z0-9_-]/g, "-");
/** Ordinary local subset of XC: callers resolve team/served identities separately. */
export function localTaskListIdentity(context: {
  environmentListId?: string;
  sessionListId?: string;
  ownTaskListId?: string;
  sessionId: string;
}): string {
  return (
    context.environmentListId ||
    context.sessionListId ||
    (context.ownTaskListId ?? context.sessionId)
  );
}
export function mergeTaskMetadata(
  existing: Readonly<Record<string, unknown>> | undefined,
  patch: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  Reflect.setPrototypeOf(result, null);
  Object.assign(result, existing);
  for (const [key, value] of Object.entries(patch))
    if (value === null) delete result[key];
    else
      Object.defineProperty(result, key, {
        value,
        enumerable: true,
        writable: true,
        configurable: true,
      });
  return result;
}
const queues = new Map<string, Promise<void>>();
async function serialize<T>(key: string, run: () => Promise<T>): Promise<T> {
  const previous = queues.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolveGate) => {
    release = resolveGate;
  });
  const tail = previous.catch(() => {}).then(() => gate);
  queues.set(key, tail);
  await previous.catch(() => {});
  try {
    return await run();
  } finally {
    release();
    if (queues.get(key) === tail) queues.delete(key);
  }
}
const code = (error: unknown): unknown =>
  typeof error === "object" && error !== null && "code" in error
    ? error.code
    : undefined;

/** Independent filesystem implementation of the ordinary local task data contract. */
export class LocalTaskStore {
  readonly directory: string;
  readonly listId: string;
  private readonly maximum: number;
  constructor(private readonly options: LocalTaskStoreOptions) {
    if (!isAbsolute(options.root))
      throw new Error("Task store root must be absolute");
    if (!options.listId)
      throw new Error("Task store requires an explicit nonempty list id");
    this.listId = options.listId;
    this.directory = join(
      resolve(options.root),
      sanitizeTaskIdentity(options.listId),
    );
    this.maximum = options.maxFileBytes ?? 1_000_000;
    if (!Number.isSafeInteger(this.maximum) || this.maximum < 1)
      throw new Error("Invalid task file bound");
    if (
      options.lock?.retries !== undefined &&
      (!Number.isSafeInteger(options.lock.retries) || options.lock.retries < 0)
    )
      throw new Error("Invalid task lock retry bound");
    for (const value of [options.lock?.staleMs, options.lock?.updateMs])
      if (value !== undefined && (!Number.isFinite(value) || value <= 0))
        throw new Error("Invalid task lock interval");
  }
  private path(id: string): string {
    return join(this.directory, sanitizeTaskIdentity(id) + ".json");
  }
  private async read(
    path: string,
    maximum = this.maximum,
  ): Promise<string | undefined> {
    let file: Awaited<ReturnType<typeof open>> | undefined;
    try {
      file = await open(
        path,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > maximum)
        throw new Error("Task entry must be a bounded regular file");
      const buffer = Buffer.alloc(stat.size + 1);
      let size = 0;
      while (size < buffer.length) {
        const read = await file.read(buffer, size, buffer.length - size, null);
        if (!read.bytesRead) break;
        size += read.bytesRead;
      }
      if (size > stat.size) throw new Error("Task entry changed while reading");
      return new TextDecoder("utf-8", { fatal: true }).decode(
        buffer.subarray(0, size),
      );
    } catch (error) {
      if (code(error) !== "ENOENT")
        this.options.onDiagnostic?.(`Task entry could not be read: ${path}`);
      return undefined;
    } finally {
      await file?.close();
    }
  }
  private async entries(): Promise<string[]> {
    try {
      return await readdir(this.directory);
    } catch {
      return [];
    }
  }
  async get(id: string): Promise<LocalTask | null> {
    try {
      if (!(await lstat(this.directory)).isDirectory()) return null;
    } catch {
      return null;
    }
    const raw = await this.read(this.path(id));
    if (raw === undefined) return null;
    try {
      const parsed = localTaskSchema.safeParse(JSON.parse(raw));
      return parsed.success ? parsed.data : null;
    } catch {
      this.options.onDiagnostic?.(`Task ${id} contains invalid JSON`);
      return null;
    }
  }
  async list(): Promise<LocalTask[]> {
    const ids = (await this.entries())
      .filter((name) => name.endsWith(".json"))
      .map((name) => name.replace(".json", ""));
    return (await Promise.all(ids.map((id) => this.get(id))))
      .filter((value): value is LocalTask => value !== null)
      .sort((a, b) => Number(a.id) - Number(b.id));
  }
  private async write(path: string, value: string): Promise<void> {
    if (Buffer.byteLength(value) > this.maximum)
      throw new Error("Task entry exceeds configured file bound");
    const temporary = join(this.directory, `.task-${randomUUID()}.tmp`);
    try {
      const file = await open(temporary, "wx", 0o600);
      try {
        await file.writeFile(value, "utf8");
      } finally {
        await file.close();
      }
      await rename(temporary, path);
    } finally {
      await unlink(temporary).catch(() => {});
    }
  }
  private async save(task: LocalTask): Promise<void> {
    await this.write(
      this.path(task.id),
      JSON.stringify(localTaskSchema.parse(task), null, 2),
    );
  }
  private async highWater(): Promise<number> {
    const raw = await this.read(join(this.directory, ".highwatermark"), 128);
    const n = Number.parseInt(raw ?? "0", 10);
    return Number.isNaN(n) ? 0 : n;
  }
  private async ensureDirectory(): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    if (!(await lstat(this.directory)).isDirectory())
      throw new Error("Task namespace must be a directory");
  }
  private async locked<T>(
    operation: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    return serialize(this.directory, async () => {
      signal?.throwIfAborted();
      await this.ensureDirectory();
      const anchor = join(this.directory, ".lock"),
        lease = anchor + ".lock",
        owner = randomUUID();
      const retries = this.options.lock?.retries ?? 30,
        stale = Math.max(2000, this.options.lock?.staleMs ?? 10000),
        update = Math.max(
          1000,
          Math.min(stale / 2, this.options.lock?.updateMs ?? stale / 2),
        );
      try {
        const file = await open(anchor, "wx", 0o600);
        await file.close();
      } catch (error) {
        if (code(error) !== "EEXIST") throw error;
      }
      for (let attempt = 0; ; attempt++) {
        signal?.throwIfAborted();
        try {
          await mkdir(lease);
          break;
        } catch (error) {
          if (code(error) !== "EEXIST") throw error;
          const stat = await lstat(lease).catch(() => undefined);
          if (stat?.isDirectory() && Date.now() - stat.mtimeMs > stale) {
            await unlink(join(lease, "owner")).catch(() => {});
            await rmdir(lease).catch(() => {});
          }
          if (attempt >= retries) throw new Error("Task store lock is busy");
          await delay(
            Math.min(100, 5 * 2 ** attempt),
            undefined,
            signal ? { signal } : undefined,
          );
        }
      }
      const ownerPath = join(lease, "owner");
      const file = await open(ownerPath, "wx", 0o600);
      try {
        await file.writeFile(owner);
      } finally {
        await file.close();
      }
      const owned = async () => (await this.read(ownerPath, 128)) === owner;
      const beat = setInterval(() => {
        void owned()
          .then((ours) => {
            if (ours) {
              const now = new Date();
              return utimes(lease, now, now);
            }
          })
          .catch(() => {});
      }, update);
      beat.unref();
      try {
        signal?.throwIfAborted();
        return await operation();
      } finally {
        clearInterval(beat);
        if (await owned()) {
          await unlink(ownerPath).catch(() => {});
          await rmdir(lease).catch(() => {});
        }
      }
    });
  }
  async create(
    input: {
      subject: string;
      description: string;
      activeForm?: string;
      metadata?: Record<string, unknown>;
    },
    signal?: AbortSignal,
  ): Promise<LocalTask> {
    return this.locked(async () => {
      const maximum = (await this.entries())
        .filter((name) => name.endsWith(".json"))
        .reduce(
          (max, name) => {
            const n = Number.parseInt(name.replace(".json", ""), 10);
            return Number.isNaN(n) ? max : Math.max(max, n);
          },
          await this.highWater(),
        );
      if (!Number.isSafeInteger(maximum + 1))
        throw new Error("Task id space exhausted");
      const task = localTaskSchema.parse({
        id: String(maximum + 1),
        ...input,
        status: "pending",
        blocks: [],
        blockedBy: [],
      });
      await this.save(task);
      return task;
    }, signal);
  }
  async update(
    id: string,
    patch: LocalTaskPatch,
    signal?: AbortSignal,
  ): Promise<LocalTask | null> {
    return this.locked(async () => {
      const current = await this.get(id);
      if (!current) return null;
      const task = localTaskSchema.parse({ ...current, ...patch, id });
      await this.save(task);
      return task;
    }, signal);
  }
  async addDependency(
    blocker: string,
    blocked: string,
    signal?: AbortSignal,
  ): Promise<boolean> {
    return this.locked(async () => {
      const before = await this.get(blocker),
        after = await this.get(blocked);
      if (!before || !after) return false;
      if (blocker === blocked) {
        if (!before.blocks.includes(blocked)) before.blocks.push(blocked);
        if (!before.blockedBy.includes(blocker)) before.blockedBy.push(blocker);
        await this.save(before);
        return true;
      }
      if (!before.blocks.includes(blocked)) {
        before.blocks.push(blocked);
        await this.save(before);
      }
      if (!after.blockedBy.includes(blocker)) {
        after.blockedBy.push(blocker);
        await this.save(after);
      }
      return true;
    }, signal);
  }
  async delete(id: string, signal?: AbortSignal): Promise<boolean> {
    return this.locked(async () => {
      const numeric = Number.parseInt(id, 10);
      if (!Number.isNaN(numeric) && numeric > (await this.highWater()))
        await this.write(
          join(this.directory, ".highwatermark"),
          String(numeric),
        );
      try {
        await unlink(this.path(id));
      } catch (error) {
        if (code(error) === "ENOENT") return false;
        throw error;
      }
      for (const task of await this.list()) {
        const blocks = task.blocks.filter((value) => value !== id),
          blockedBy = task.blockedBy.filter((value) => value !== id);
        if (
          blocks.length !== task.blocks.length ||
          blockedBy.length !== task.blockedBy.length
        )
          await this.save({ ...task, blocks, blockedBy });
      }
      return true;
    }, signal);
  }
}
export function createLocalTaskStore(
  options: LocalTaskStoreOptions,
): LocalTaskStore {
  return new LocalTaskStore(options);
}
