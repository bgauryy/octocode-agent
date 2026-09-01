import { randomUUID } from 'node:crypto';

import {
  RuntimeFailure,
  createEffectSet,
  jsonSchemaError,
  type JsonSchema,
  type ToolDefinition,
} from '@octocodeai/agent-core';

import {
  assertNativeArtifactPreviewManifestV1,
  createNativeArtifactPreviewController,
  type NativeArtifactPreviewController,
} from './native-artifact-preview.js';
import type { NativeFileSystemPort } from './native-file-tool.js';
import { openNativeApprovedOAuthUrl } from './native-mcp-oauth.js';

const INPUT_SCHEMA: JsonSchema = {
  oneOf: [
    {
      type: 'object',
      properties: {
        action: { const: 'open' },
        manifest: {
          type: 'object',
          properties: {
            schemaVersion: { const: 1 },
            artifacts: { type: 'array', minItems: 1, maxItems: 64, items: { type: 'object' } },
          },
          required: ['schemaVersion', 'artifacts'],
          additionalProperties: false,
        },
      },
      required: ['action', 'manifest'],
      additionalProperties: false,
    },
    {
      type: 'object',
      properties: { action: { const: 'close' }, previewId: { type: 'string', minLength: 1, maxLength: 128 } },
      required: ['action', 'previewId'],
      additionalProperties: false,
    },
    { type: 'object', properties: { action: { const: 'status' } }, required: ['action'], additionalProperties: false },
  ],
};

export interface NativeArtifactPreviewToolOptions {
  readonly fileSystem: NativeFileSystemPort;
  readonly openUrl?: (url: string) => Promise<{ ok: boolean }>;
  readonly maxActive?: number;
}

export interface NativeArtifactPreviewToolLifecycle {
  readonly tool: ToolDefinition;
  close(): Promise<void>;
}

export function createNativeArtifactPreviewTool(options: NativeArtifactPreviewToolOptions): NativeArtifactPreviewToolLifecycle {
  const active = new Map<string, { controller: NativeArtifactPreviewController; artifactCount: number }>();
  const maximum = Number.isSafeInteger(options.maxActive) && options.maxActive! >= 1 && options.maxActive! <= 8 ? options.maxActive! : 4;
  const openUrl = options.openUrl ?? openNativeApprovedOAuthUrl;
  const close = async (): Promise<void> => {
    const controllers = [...active.values()].map(({ controller }) => controller);
    active.clear();
    await Promise.allSettled(controllers.map((controller) => controller.close()));
  };
  const tool: ToolDefinition = {
    name: 'artifactPreview',
    label: 'Artifact preview',
    description: 'Open or close an approval-gated, allowlist-only loopback preview for verified workspace artifacts.',
    schemaVersion: 1,
    inputSchema: INPUT_SCHEMA,
    outputSchema: { type: 'object' },
    outputVersion: 1,
    policy: {
      effects: createEffectSet('read', 'network', 'process'),
      trust: 'workspace', approval: 'on-request', plan: 'allowed',
      resolve(input) {
        const status = typeof input === 'object' && input !== null && !Array.isArray(input)
          && (input as Record<string, unknown>).action === 'status';
        return status
          ? { effects: createEffectSet('read'), trust: 'workspace', approval: 'never' }
          : { effects: createEffectSet('read', 'network', 'process'), trust: 'workspace', approval: 'on-request' };
      },
      concurrency: () => ({ lane: 'native-artifact-preview', maxActive: 1 }),
    },
    async execute(request) {
      const invalid = jsonSchemaError(request.input, INPUT_SCHEMA);
      if (invalid) throw new RuntimeFailure('validation', invalid);
      const input = request.input as { action: 'status' } | { action: 'close'; previewId: string } | { action: 'open'; manifest: unknown };
      if (input.action === 'status') {
        return {
          ok: true,
          content: { active: [...active.entries()].map(([previewId, value]) => ({ previewId, artifactCount: value.artifactCount })) },
          detailsVersion: 1,
        };
      }
      if (input.action === 'close') {
        const entry = active.get(input.previewId);
        if (!entry) throw new RuntimeFailure('validation', 'Unknown artifact preview');
        active.delete(input.previewId);
        await entry.controller.close();
        return { ok: true, content: { previewId: input.previewId, state: 'closed' }, detailsVersion: 1 };
      }
      if (active.size >= maximum) throw new RuntimeFailure('tool-execution', 'Too many artifact previews are active');
      const manifest = assertNativeArtifactPreviewManifestV1(input.manifest);
      const controller = createNativeArtifactPreviewController({ fileSystem: options.fileSystem, manifest });
      const previewId = `preview-${randomUUID()}`;
      try {
        const url = await controller.urlFor(manifest.artifacts[0]!.artifactId);
        if (request.signal.aborted) throw new RuntimeFailure('cancelled', 'Artifact preview cancelled');
        const opened = await openUrl(url);
        if (!opened.ok) throw new RuntimeFailure('tool-execution', 'Artifact preview browser could not be opened');
        active.set(previewId, { controller, artifactCount: manifest.artifacts.length });
        return { ok: true, content: { previewId, state: 'opened', artifactCount: manifest.artifacts.length }, detailsVersion: 1 };
      } catch (error) {
        await controller.close();
        throw error;
      }
    },
  };
  return { tool, close };
}
