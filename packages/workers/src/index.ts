export * from "./agent.ts";
import { runAppAgent, remember } from "./agent.ts";
import type { AppPolicy } from "@deploybug/policy";
import type { ToolProvider } from "@deploybug/providers";
import { resolveProvider, type ModelsConfig } from "@deploybug/checker";

export interface WorkerTask { tool: string; args: Record<string, unknown>; instruction?: string; user?: string; credentials?: Record<string, string> }

export class WorkerDefinition {
  constructor(public app: string, public policy: AppPolicy, private provider: ToolProvider, private models: ModelsConfig, private liveReads?: ToolProvider) {}

  async run(task: WorkerTask): Promise<unknown> {
    const allowed = new Set(this.policy.tools.map(t => t.name));
    if (!allowed.has(task.tool)) throw new Error(`${this.app}-worker cannot use ${task.tool}`);
    const kind = this.policy.tools.find(t => t.name === task.tool)!.kind;
    if (kind === "read" && process.env.DRY_RUN === "1" && process.env.READS_LIVE === "1" && this.liveReads)
      return this.liveReads.execute(task.tool, task.args, { user: task.user, credentials: task.credentials });
    const { key, base } = resolveProvider(this.models, this.models.brain.provider);
    if (!key || !base || process.env.DRY_RUN === "1") { const r = await this.provider.execute(task.tool, task.args, { user: task.user, credentials: task.credentials }); remember(this.app, `ran ${task.tool}`); return r; }

    const result = await this.provider.execute(task.tool, task.args, { user: task.user, credentials: task.credentials });
    const reads = this.policy.tools.filter(t => t.kind === "read" && t.name !== task.tool).map(t => ({ name: t.name, description: `Read ${this.app} data`, run: (a: Record<string, unknown>) => (this.liveReads ?? this.provider).execute(t.name, a, { user: task.user, credentials: task.credentials }) }));
    const review = await runAppAgent({ app: this.app, model: { model: this.models.brain.model, key, base }, readTools: reads,
      instruction: `Policy already approved and ran ${task.tool}. Result: ${JSON.stringify(result).slice(0, 4000)}. Report it briefly.`,
      systemPrompt: `You are the ${this.app}-worker in Deploy Bug. You only report and propose; you cannot run write actions.` }).catch(e => ({ summary: `agent unavailable: ${String(e).slice(0, 120)}`, proposals: [] }));
    return { result, summary: review.summary };
  }
}

export class WorkerFactory {
  private defs = new Map<string, WorkerDefinition>();
  constructor(private providers: Record<string, ToolProvider>, private models: ModelsConfig) {}
  register(app: string, policy: AppPolicy) {
    const p = this.providers[policy.provider];
    if (!p) throw new Error(`no provider '${policy.provider}' for ${app}`);
    this.defs.set(app, new WorkerDefinition(app, policy, p, this.models, this.providers[`${policy.provider}-live`]));
  }
  get(app: string) { return this.defs.get(app); }
  list() { return [...this.defs.keys()].map(a => `${a}-worker`); }
}
export * from "./consensus.ts";
export * from "./toolkits.ts";
export * from "./pool.ts";
