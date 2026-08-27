import { RuntimeFailure } from '../contracts/errors.js';
import { eventId, toolCallId, turnId, type SessionId } from '../contracts/identity.js';
import type { AgentRuntime, RuntimeCommand, RuntimeCommandResult, RuntimeSnapshot } from '../contracts/runtime.js';
import type { RuntimeEvent } from '../contracts/events.js';
import type { ModelPort, ModelRequest } from '../contracts/ports.js';
import { ToolRegistry } from './registries.js';
import { PolicyChain } from './policy.js';

export interface RuntimeKernelOptions { readonly sessionId: SessionId; readonly model: ModelPort; readonly tools?: ToolRegistry; readonly policy?: PolicyChain; readonly maxIterations?: number; readonly cwd?: string; readonly emit?: (event: RuntimeEvent) => Promise<void>; readonly now?: () => number; }
export class RuntimeKernel implements AgentRuntime {
  readonly #listeners = new Set<(event: RuntimeEvent) => void>();
  readonly #options: RuntimeKernelOptions;
  #state: RuntimeSnapshot['state'] = 'created'; #active: AbortController | null = null; #pendingCancel: string | null = null; #revision = 0; #model: RuntimeSnapshot['model'] = null; #thinking: string | null = null; #usage = { inputTokens: 0, outputTokens: 0 }; #sequence = 0;
  constructor(options: RuntimeKernelOptions) { this.#options = options; }
  async start(): Promise<void> { if (this.#state !== 'created') return; this.#state = 'starting'; await this.#emit('runtime.ready', 'notification', {}); this.#state = 'ready'; this.#revision += 1; }
  async submit(input: string): Promise<void> {
    if (this.#state === 'created') await this.start(); if (this.#state !== 'ready') throw new RuntimeFailure('internal-invariant', `Runtime cannot submit while ${this.#state}`);
    this.#state = 'running'; this.#revision += 1; const controller = new AbortController(); this.#active = controller; if (this.#pendingCancel !== null) { controller.abort(this.#pendingCancel); this.#pendingCancel = null; } const id = turnId(`turn:${this.#sequence + 1}`);
    await this.#emit('input.received', 'before', { text: input }); await this.#emit('turn.started', 'notification', { turnId: id });
    let stop: string = 'error';
    try { if (controller.signal.aborted) stop = 'cancelled'; else stop = await this.#runModelToolLoop(input, id, controller.signal); }
    catch (error) { if (!controller.signal.aborted) { this.#state = 'failed'; await this.#emit('runtime.failed', 'notification', { message: error instanceof Error ? error.message : 'Model failed' }); throw error; } stop = 'cancelled'; }
    finally { this.#active = null; if (this.#state !== 'failed') this.#state = 'ready'; this.#revision += 1; await this.#emit('turn.ended', 'after', { turnId: id, stop }); }
  }
  async cancel(reason = 'cancelled'): Promise<void> { if (this.#active === null) this.#pendingCancel = reason; else this.#active.abort(reason); }
  async execute(command: RuntimeCommand): Promise<RuntimeCommandResult> { try { switch (command.type) { case 'input.submit': case 'input.steer': case 'input.follow-up': await this.submit(command.text); return { ok: true }; case 'input.cancel': await this.cancel(command.reason); return { ok: true }; case 'model.select': this.#model = { providerId: command.providerId, modelId: command.modelId }; this.#revision += 1; await this.#emit('model.selected', 'notification', this.#model); return { ok: true }; case 'model.thinking': this.#thinking = command.level; this.#revision += 1; await this.#emit('model.thinking-level-selected', 'notification', { level: command.level }); return { ok: true }; case 'context.usage': case 'runtime.snapshot': return { ok: true, data: this.snapshot() }; case 'runtime.stop': await this.stop(); return { ok: true }; default: return { ok: false, error: new RuntimeFailure('unsupported-capability', `Command ${command.type} requires a composed service`).toJSON() }; } } catch (error) { const failure = error instanceof RuntimeFailure ? error : new RuntimeFailure('internal-invariant', error instanceof Error ? error.message : 'Runtime command failed'); return { ok: false, error: failure.toJSON() }; } }
  snapshot(): RuntimeSnapshot { return { schemaVersion: 1, state: this.#state, sessionId: this.#options.sessionId, activeTurn: this.#active !== null, model: this.#model, thinkingLevel: this.#thinking, usage: this.#usage, revision: this.#revision }; }
  subscribe(listener: (event: RuntimeEvent) => void): () => void { this.#listeners.add(listener); return () => this.#listeners.delete(listener); }
  async stop(): Promise<void> { if (this.#state === 'stopped') return; this.#state = 'stopping'; this.#active?.abort('runtime stopping'); await this.#emit('runtime.stopping', 'notification', {}); this.#state = 'stopped'; this.#revision += 1; await this.#emit('runtime.stopped', 'notification', {}); }
  async #emit(type: RuntimeEvent['type'], phase: RuntimeEvent['phase'], payload: unknown): Promise<void> { const event: RuntimeEvent = { schemaVersion: 1, eventVersion: 1, id: eventId(`runtime:${++this.#sequence}`), type, phase, sessionId: this.#options.sessionId, timestamp: this.#options.now?.() ?? Date.now(), cwd: this.#options.cwd ?? process.cwd(), mode: 'headless', trust: { workspace: 'unknown', managedOnly: false }, payload: payload as Readonly<unknown> }; for (const listener of this.#listeners) listener(event); await this.#options.emit?.(event); }
  async #runModelToolLoop(input: string, activeTurnId: ReturnType<typeof turnId>, signal: AbortSignal): Promise<string> {
    const messages: Array<ModelRequest['messages'][number]> = [{ role: 'user', content: input }]; const effects = new Set<string>(); const maxIterations = this.#options.maxIterations ?? 16;
    for (let iteration = 0; iteration < maxIterations; iteration += 1) {
      if (signal.aborted) return 'cancelled'; const calls: { id: string; name: string; input: unknown }[] = []; const text: string[] = [];
      await this.#emit('provider.request-started', 'notification', { iteration });
      const modelTools = this.#options.tools?.list().map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
      const result = await this.#options.model.run({ messages, ...(this.#model === null ? {} : { model: this.#model }), ...(this.#thinking === null ? {} : { thinkingLevel: this.#thinking }), ...(modelTools === undefined || modelTools.length === 0 ? {} : { tools: modelTools, toolChoice: 'auto' as const }) }, { signal, emit: async (delta) => { if (delta.type === 'tool-call') calls.push({ id: delta.id, name: delta.name, input: delta.input }); else if (delta.type === 'text') text.push(delta.text); await this.#emit('message.delta', 'notification', delta); } });
      this.#usage = { inputTokens: this.#usage.inputTokens + result.usage.inputTokens, outputTokens: this.#usage.outputTokens + result.usage.outputTokens }; await this.#emit('provider.response-received', 'after', { iteration, stop: result.stop, usage: result.usage });
      if (text.length > 0 || calls.length > 0) messages.push({ role: 'assistant', content: text.join(''), ...(calls.length === 0 ? {} : { toolCalls: calls }) });
      if (result.stop !== 'tool' || calls.length === 0) return result.stop;
      for (const [index, call] of calls.entries()) {
        if (signal.aborted) return 'cancelled'; const callId = toolCallId(call.id || `${activeTurnId}:${iteration}:${index}:${call.name}`); if (effects.has(callId)) throw new RuntimeFailure('internal-invariant', `Duplicate effect: ${callId}`); effects.add(callId);
        await this.#emit('tool.requested', 'permission', { callId, name: call.name, input: call.input }); const definition = this.#options.tools?.get(call.name);
        if (definition === undefined) { const content = { error: `Unknown tool: ${call.name}` }; await this.#emit('tool.blocked', 'after', { callId, name: call.name, category: 'unsupported-capability' }); messages.push({ role: 'tool', toolCallId: callId, content: JSON.stringify(content) }); continue; }
        const policy = await (this.#options.policy ?? new PolicyChain()).evaluate({ operation: `tool:${call.name}`, trust: { workspace: 'unknown', managedOnly: false }, effect: definition.policy.effect, metadata: { callId, tool: call.name } });
        if (policy.effect === 'deny') { const content = { error: policy.reason, category: policy.category }; await this.#emit('tool.blocked', 'after', { callId, name: call.name, ...content, policy: policy.receipts }); messages.push({ role: 'tool', toolCallId: callId, content: JSON.stringify(content) }); continue; }
        await this.#emit('tool.started', 'notification', { callId, name: call.name });
        try { const toolResult = await definition.execute({ input: call.input, callId, context: { sessionId: this.#options.sessionId, turnId: activeTurnId, cwd: this.#options.cwd ?? process.cwd(), mode: 'headless', trust: { workspace: 'unknown', managedOnly: false }, signal }, signal, update: async (update) => this.#emit('tool.updated', 'notification', { callId, name: call.name, update }) }); await this.#emit('tool.ended', 'after', { callId, name: call.name, result: toolResult }); messages.push({ role: 'tool', toolCallId: callId, content: JSON.stringify(toolResult) }); }
        catch (error) { if (signal.aborted) return 'cancelled'; const failure = error instanceof RuntimeFailure ? error : new RuntimeFailure('tool-execution', error instanceof Error ? error.message : 'Tool failed'); await this.#emit('tool.ended', 'after', { callId, name: call.name, error: failure.toJSON() }); messages.push({ role: 'tool', toolCallId: callId, content: JSON.stringify({ error: failure.toJSON() }) }); }
      }
    }
    throw new RuntimeFailure('internal-invariant', `Model/tool loop exceeded ${maxIterations} iterations`);
  }
}
export const createRuntimeKernel = (options: RuntimeKernelOptions): AgentRuntime => new RuntimeKernel(options);
