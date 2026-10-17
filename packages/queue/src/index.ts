export interface QueueStatus { backend: string; concurrency: number; running: number; waiting: number; completed: number; failed: number }
export interface JobQueue {
  add<T>(name: string, fn: () => Promise<T>): Promise<T>;
  status(): QueueStatus;
}

export class InProcessQueue implements JobQueue {
  private running = 0; private completed = 0; private failed = 0;
  private waiting: (() => void)[] = [];
  constructor(public concurrency = 2) {}
  async add<T>(_name: string, fn: () => Promise<T>): Promise<T> {
    if (this.running >= this.concurrency) await new Promise<void>(r => this.waiting.push(r));
    this.running++;
    try { const v = await fn(); this.completed++; return v; }
    catch (e) { this.failed++; throw e; }
    finally { this.running--; this.waiting.shift()?.(); }
  }
  status(): QueueStatus { return { backend: "in-process", concurrency: this.concurrency, running: this.running, waiting: this.waiting.length, completed: this.completed, failed: this.failed }; }
}

export function createQueue(): JobQueue {
  const backend = process.env.QUEUE_BACKEND ?? "memory";
  const c = Number(process.env.QUEUE_CONCURRENCY ?? 2);
  if (backend !== "memory") throw new Error(`queue backend '${backend}' not installed yet (add packages/queue BullMQ adapter)`);
  return new InProcessQueue(c);
}
