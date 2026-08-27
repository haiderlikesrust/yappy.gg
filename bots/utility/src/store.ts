import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * A JSON file that survives a restart, and a crash mid-write.
 *
 * A reminder is a promise. Losing one because the process was restarted is
 * the whole failure mode of a reminder bot, so state is written after every
 * change — to a temporary file, then renamed over the real one, which on every
 * filesystem this runs on is atomic. Without the rename, a kill during
 * `writeFile` leaves a truncated file, and the next boot finds no reminders at
 * all rather than the ones from before.
 *
 * Postgres would be the answer at a scale this bot does not have. Twenty
 * reminders in a JSON file is not a database problem.
 */
export class Store<T> {
  private state: T;
  private writing: Promise<void> = Promise.resolve();

  private constructor(
    private readonly path: string,
    initial: T,
  ) {
    this.state = initial;
  }

  static async open<T>(path: string, fallback: T): Promise<Store<T>> {
    let initial = fallback;
    try {
      initial = JSON.parse(await readFile(path, 'utf8')) as T;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        // A corrupt file is worth shouting about rather than silently starting
        // empty — that is somebody's reminders.
        console.error(`[store] ${path} unreadable, starting empty:`, err);
      }
    }
    return new Store(path, initial);
  }

  get(): T {
    return this.state;
  }

  /** Replace the state and persist it. Writes are serialised, so two rapid
   *  changes cannot interleave into half of each. */
  async set(next: T): Promise<void> {
    this.state = next;
    this.writing = this.writing.then(() => this.flush()).catch((err) => {
      console.error('[store] write failed:', err);
    });
    return this.writing;
  }

  private async flush(): Promise<void> {
    const body = JSON.stringify(this.state, null, 2);
    await mkdir(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.${process.pid}.tmp`;
    await writeFile(tmp, body, 'utf8');
    await rename(tmp, this.path);
  }
}
