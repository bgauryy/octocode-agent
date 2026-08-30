/**
 * Single source of truth for LLM provider auth rows.
 * Consumed by the `auth` report and the interactive `auth login` wizard.
 */
export interface AuthProvider {
  keyVar: string;
  label: string;
  url?: string;
  host?: string;
  protocol: 'openai-chat-completions' | 'openai-responses' | 'anthropic-messages';
}

/** Credentials accepted by the composed native model adapter. */
export const AUTH_PROVIDERS: readonly AuthProvider[] = [
  {
    keyVar: 'OCTOCODE_MODEL_API_KEY',
    label: 'Configured OpenAI-compatible endpoint',
    url: 'https://platform.openai.com/docs/api-reference/chat',
    host: 'OpenAI Chat Completions protocol',
    protocol: 'openai-chat-completions',
  },
  {
    keyVar: 'OPENAI_API_KEY',
    label: 'OpenAI',
    url: 'https://platform.openai.com/api-keys',
    host: 'platform.openai.com/api-keys',
    protocol: 'openai-responses',
  },
  {
    keyVar: 'ANTHROPIC_API_KEY',
    label: 'Anthropic',
    url: 'https://console.anthropic.com/settings/keys',
    host: 'console.anthropic.com/settings/keys',
    protocol: 'anthropic-messages',
  },
];
