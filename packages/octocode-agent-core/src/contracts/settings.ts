import type { Revision } from './identity.js';

export type SettingScope = 'session' | 'workspace' | 'global' | 'managed' | 'imported';
export type SettingKind =
  | { readonly type: 'boolean' }
  | { readonly type: 'enum'; readonly values: readonly string[] }
  | { readonly type: 'string'; readonly pattern?: string }
  | { readonly type: 'integer'; readonly minimum?: number; readonly maximum?: number }
  | { readonly type: 'duration'; readonly minimumMs?: number; readonly maximumMs?: number }
  | { readonly type: 'path' }
  | { readonly type: 'secret-reference' }
  | { readonly type: 'object' }
  | { readonly type: 'list' };
export type ApplicationTiming = 'immediate' | 'next-model-request' | 'next-session' | 'process-restart' | 'manual-refresh';
export interface SettingDefinition { readonly key: string; readonly schemaVersion: number; readonly section: string; readonly order: number; readonly kind: SettingKind; readonly scopes: readonly SettingScope[]; readonly defaultValue: unknown; readonly mutability: 'editable' | 'read-only'; readonly application: ApplicationTiming; readonly visibility: 'public' | 'sensitive-metadata' | 'secret-reference' | 'never-render'; readonly owner: string; readonly documentation: string; readonly classificationReason?: string; readonly validate?: (value: unknown) => boolean; readonly normalize?: (value: unknown) => unknown; }
export interface SettingValue { readonly key: string; readonly value: unknown; readonly stored: boolean; readonly scope: SettingScope; readonly provenance: 'default' | 'environment' | 'cli' | 'workspace' | 'global' | 'imported' | 'runtime' | 'policy'; readonly revision: Revision; readonly warnings: readonly string[]; readonly application: ApplicationTiming; }
export interface SettingsSnapshot { readonly schemaVersion: 1; readonly revision: Revision; readonly definitions: readonly SettingDefinition[]; readonly values: readonly SettingValue[]; readonly revisionVector: Readonly<Record<string, Revision>>; readonly sourceHealth: readonly { readonly id: string; readonly state: 'healthy' | 'warning' | 'failed'; readonly message?: string }[]; }
export type SettingsAction = 'set' | 'unset' | 'upsert-model' | 'remove-model' | 'upsert-provider' | 'remove-provider' | 'replace-model-source' | 'import-model-source' | 'refresh-models';
export interface SettingsMutation { readonly protocolVersion: 1; readonly requestId: string; readonly action: SettingsAction; readonly scope: 'session' | 'workspace' | 'global'; readonly expectedRevision: Revision; readonly payload: unknown; }
export type SettingsMutationResult =
  | { readonly ok: true; readonly requestId: string; readonly revision: Revision; readonly storedValue?: SettingValue; readonly effectiveValue?: SettingValue; readonly application: ApplicationTiming; readonly redactedImpact: readonly string[]; readonly auditReceiptId: string }
  | { readonly ok: false; readonly requestId: string; readonly error: { readonly category: 'validation' | 'conflict' | 'policy' | 'persistence'; readonly message: string; readonly currentRevision?: Revision } };
