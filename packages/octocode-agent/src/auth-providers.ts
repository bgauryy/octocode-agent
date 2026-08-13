/**
 * Single source of truth for LLM provider auth rows.
 * Consumed by the `auth` report and the interactive `auth login` wizard.
 */
export interface AuthProvider {
  keyVar: string;
  label: string;
  url: string;
  host: string;
}

export const AUTH_PROVIDERS: readonly AuthProvider[] = [
  {
    keyVar: 'ANTHROPIC_API_KEY',
    label: 'Claude (Anthropic)',
    url: 'https://console.anthropic.com',
    host: 'console.anthropic.com',
  },
  {
    keyVar: 'OPENAI_API_KEY',
    label: 'GPT-4 (OpenAI)',
    url: 'https://platform.openai.com/api-keys',
    host: 'platform.openai.com/api-keys',
  },
  {
    keyVar: 'GEMINI_API_KEY',
    label: 'Gemini (Google)',
    url: 'https://aistudio.google.com/app/apikey',
    host: 'aistudio.google.com/app/apikey',
  },
  { keyVar: 'MISTRAL_API_KEY', label: 'Mistral', url: 'https://console.mistral.ai', host: 'console.mistral.ai' },
  { keyVar: 'GROQ_API_KEY', label: 'Groq', url: 'https://console.groq.com', host: 'console.groq.com' },
];
