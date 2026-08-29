import type { RuntimeErrorData } from './errors.js';
import type { RuntimeCommand } from './runtime.js';
import type { RuntimeEvent } from './events.js';
export interface RpcRequest { readonly protocolVersion: 1; readonly requestId: string; readonly command: RuntimeCommand; }
export type RpcResponse = { readonly protocolVersion: 1; readonly requestId: string; readonly ok: true; readonly data?: unknown } | { readonly protocolVersion: 1; readonly requestId: string; readonly ok: false; readonly error: RuntimeErrorData };
export interface RpcEvent { readonly protocolVersion: 1; readonly sequence: number; readonly event: RuntimeEvent; }
export interface RpcProtocolError { readonly protocolVersion?: number; readonly requestId?: string; readonly category: 'parse' | 'version' | 'validation'; readonly message: string; }
