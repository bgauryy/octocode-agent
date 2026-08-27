import { RuntimeFailure } from '../contracts/errors.js';
import type { RpcRequest } from '../contracts/rpc.js';
export const parseRpcRequest = (input: unknown): RpcRequest => {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new RuntimeFailure('protocol', 'RPC request must be an object');
  const value = input as Record<string, unknown>;
  if (value.protocolVersion !== 1) throw new RuntimeFailure('unsupported-version', 'Unsupported RPC protocol major version');
  if (typeof value.requestId !== 'string' || typeof value.command !== 'object' || value.command === null || typeof (value.command as { type?: unknown }).type !== 'string') throw new RuntimeFailure('validation', 'Malformed RPC request');
  return value as unknown as RpcRequest;
};
