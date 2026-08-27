declare const brand: unique symbol;
export type Brand<T, Name extends string> = T & { readonly [brand]: Name };

export type SessionId = Brand<string, 'SessionId'>;
export type EventId = Brand<string, 'EventId'>;
export type SessionEventId = Brand<string, 'SessionEventId'>;
export type TurnId = Brand<string, 'TurnId'>;
export type ToolCallId = Brand<string, 'ToolCallId'>;
export type RequestId = Brand<string, 'RequestId'>;
export type EffectId = Brand<string, 'EffectId'>;
export type BranchId = Brand<string, 'BranchId'>;
export type PluginId = Brand<string, 'PluginId'>;
export type Revision = Brand<string, 'Revision'>;

export const sessionId = (value: string): SessionId => value as SessionId;
export const eventId = (value: string): EventId => value as EventId;
export const sessionEventId = (value: string): SessionEventId => value as SessionEventId;
export const turnId = (value: string): TurnId => value as TurnId;
export const toolCallId = (value: string): ToolCallId => value as ToolCallId;
export const requestId = (value: string): RequestId => value as RequestId;
export const effectId = (value: string): EffectId => value as EffectId;
export const branchId = (value: string): BranchId => value as BranchId;
export const pluginId = (value: string): PluginId => value as PluginId;
export const revision = (value: string): Revision => value as Revision;
