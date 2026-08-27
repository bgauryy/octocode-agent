import { TextRenderable, createCliRenderer } from '@opentui/core';

import {
  createOpenTuiTerminal,
  type OpenTuiTerminal,
  type PresentationState,
} from './index.js';

function frameText(state: PresentationState): string {
  const sections = [
    state.title ?? 'Octocode',
    state.header == null ? '' : String(state.header),
    state.transcript,
    ...Object.entries(state.statuses).map(([name, value]) => `${name}: ${value}`),
    ...state.notifications.map((item) => `[${item.severity}] ${item.message}`),
    state.footer == null ? '' : String(state.footer),
  ];
  return sections.filter(Boolean).join('\n');
}

/** Production OpenTUI renderer factory. All toolkit types remain in this directory. */
export function createDefaultOpenTuiTerminal(): OpenTuiTerminal {
  return createOpenTuiTerminal({
    async createRenderer() {
      const renderer = await createCliRenderer({ exitOnCtrlC: false });
      const view = new TextRenderable(renderer, {
        id: 'octocode-agent-root',
        content: frameText({
          ready: false,
          working: 'idle',
          transcript: '',
          statuses: {},
          notifications: [],
        }),
      });
      renderer.root.add(view);
      return {
        render(state) {
          view.content = frameText(state);
        },
        destroy() {
          renderer.destroy();
        },
      };
    },
  });
}
