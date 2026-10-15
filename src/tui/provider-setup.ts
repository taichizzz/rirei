import type { AgentId } from '../agents/adapter.js';

export const PROVIDER_SETUP: Record<
  AgentId,
  { executable: string; documentation: string }
> = {
  claude: {
    executable: 'claude',
    documentation: 'https://code.claude.com/docs/en/setup',
  },
  codex: {
    executable: 'codex',
    documentation: 'https://developers.openai.com/codex/cli',
  },
  gemini: {
    executable: 'gemini',
    documentation: 'https://geminicli.com/docs/get-started/installation/',
  },
  antigravity: {
    executable: 'agy',
    documentation: 'https://antigravity.google/',
  },
  opencode: {
    executable: 'opencode',
    documentation: 'https://opencode.ai/docs/',
  },
};
