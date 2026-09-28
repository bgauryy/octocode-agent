import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Editor, type EditorTheme, Key, matchesKey, visibleWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui';

export interface AskOption {
  label: string;
  description?: string;
}

export interface AskQuestion {
  question: string;
  header?: string;
  options: AskOption[];
  multiSelect?: boolean;
}

export interface AskAnswer {
  question: string;
  answer: string;
  custom: boolean;
}

export interface AskResult {
  answers: AskAnswer[];
  cancelled: boolean;
}

const TYPE_OWN = 'Type something.';

/**
 * Inline question dialog (adapted from Pi's questionnaire example): a tab per
 * question plus Submit, ↑↓ to move, Space to toggle in multi-select, Enter to
 * choose, and a free-text row on every question.
 */
export function showAskDialog(ctx: ExtensionContext, questions: AskQuestion[], signal?: AbortSignal): Promise<AskResult> {
  return ctx.ui.custom<AskResult>((tui, theme, _keybindings, done) => {
    const isMulti = questions.length > 1;
    const answers = new Map<number, AskAnswer>();
    const toggled = new Map<number, Set<number>>();
    let tab = 0;
    let cursor = 0;
    let typing = false;
    let cache: string[] | undefined;

    const editorTheme: EditorTheme = {
      borderColor: (text) => theme.fg('accent', text),
      selectList: {
        selectedPrefix: (text) => theme.fg('accent', text),
        selectedText: (text) => theme.fg('accent', text),
        description: (text) => theme.fg('muted', text),
        scrollInfo: (text) => theme.fg('dim', text),
        noMatch: (text) => theme.fg('warning', text),
      },
    };
    const editor = new Editor(tui, editorTheme);

    const refresh = () => {
      cache = undefined;
      tui.requestRender();
    };
    let finished = false;
    const finish = (cancelled: boolean) => {
      if (finished) return;
      finished = true;
      signal?.removeEventListener('abort', onAbort);
      done({ answers: questions.flatMap((_, index) => answers.get(index) ?? []), cancelled });
    };
    // The run was aborted (e.g. the user interrupted the agent) while the dialog was open.
    const onAbort = () => finish(true);
    if (signal?.aborted) queueMicrotask(onAbort);
    else signal?.addEventListener('abort', onAbort, { once: true });
    const rows = (q: AskQuestion) => [...q.options.map((option) => option.label), TYPE_OWN];

    const answer = (index: number, value: AskAnswer) => {
      answers.set(index, value);
      if (!isMulti) return finish(false);
      tab = index < questions.length - 1 ? index + 1 : questions.length;
      cursor = 0;
      refresh();
    };

    editor.onSubmit = (value) => {
      const q = questions[tab]!;
      const text = value.trim();
      typing = false;
      editor.setText('');
      if (!text) return refresh();
      const picked = [...(toggled.get(tab) ?? [])].map((index) => q.options[index]!.label);
      answer(tab, { question: q.question, answer: [...picked, text].join(', '), custom: true });
    };

    function handleInput(data: string): void {
      if (typing) {
        if (matchesKey(data, Key.escape)) {
          typing = false;
          editor.setText('');
        } else editor.handleInput(data);
        return refresh();
      }
      if (isMulti && (matchesKey(data, Key.tab) || matchesKey(data, Key.right))) {
        tab = (tab + 1) % (questions.length + 1);
        cursor = 0;
        return refresh();
      }
      if (isMulti && (matchesKey(data, Key.shift('tab')) || matchesKey(data, Key.left))) {
        tab = (tab + questions.length) % (questions.length + 1);
        cursor = 0;
        return refresh();
      }
      if (matchesKey(data, Key.escape)) return finish(true);
      if (tab === questions.length) {
        if (matchesKey(data, Key.enter) && answers.size === questions.length) finish(false);
        return;
      }
      const q = questions[tab]!;
      const count = rows(q).length;
      if (matchesKey(data, Key.up)) cursor = (cursor + count - 1) % count;
      else if (matchesKey(data, Key.down)) cursor = (cursor + 1) % count;
      else if (/^[1-9]$/.test(data) && Number(data) <= count) {
        // Number keys jump to the numbered row; Enter still confirms (Space toggles in multi-select).
        cursor = Number(data) - 1;
      }
      else if (q.multiSelect && matchesKey(data, Key.space) && cursor < q.options.length) {
        const set = toggled.get(tab) ?? new Set<number>();
        if (set.has(cursor)) set.delete(cursor);
        else set.add(cursor);
        toggled.set(tab, set);
      } else if (matchesKey(data, Key.enter)) {
        if (cursor === q.options.length) {
          typing = true;
          return refresh();
        }
        if (q.multiSelect) {
          // Nothing toggled (or everything untoggled again): Enter picks the highlighted option.
          const set = toggled.get(tab)?.size ? toggled.get(tab)! : new Set<number>([cursor]);
          const labels = [...set].sort((a, b) => a - b).map((index) => q.options[index]!.label);
          return answer(tab, { question: q.question, answer: labels.join(', '), custom: false });
        }
        return answer(tab, { question: q.question, answer: q.options[cursor]!.label, custom: false });
      } else return;
      refresh();
    }

    function render(width: number): string[] {
      if (cache) return cache;
      const w = Math.max(1, width);
      const lines: string[] = [];
      const add = (prefix: string, text: string) => {
        const wrapped = wrapTextWithAnsi(text, Math.max(1, w - visibleWidth(prefix)));
        wrapped.forEach((line, index) => lines.push(`${index === 0 ? prefix : ' '.repeat(visibleWidth(prefix))}${line}`));
      };
      lines.push(theme.fg('accent', '─'.repeat(w)));
      if (isMulti) {
        const tabs = questions.map((q, index) => {
          const label = ` ${answers.has(index) ? '■' : '□'} ${q.header ?? `Q${index + 1}`} `;
          return index === tab ? theme.bg('selectedBg', theme.fg('text', label)) : theme.fg(answers.has(index) ? 'success' : 'muted', label);
        });
        const submit = ' ✓ Submit ';
        tabs.push(tab === questions.length ? theme.bg('selectedBg', theme.fg('text', submit)) : theme.fg(answers.size === questions.length ? 'success' : 'dim', submit));
        add(' ', tabs.join(' '));
        lines.push('');
      }
      if (tab === questions.length) {
        for (const [index, q] of questions.entries()) {
          const given = answers.get(index);
          add(' ', `${theme.fg('muted', `${q.header ?? `Q${index + 1}`}: `)}${given ? theme.fg('text', given.answer) : theme.fg('warning', '(unanswered)')}`);
        }
        lines.push('');
        add(' ', answers.size === questions.length ? theme.fg('success', 'Enter to submit') : theme.fg('warning', 'Answer every question to submit'));
      } else {
        const q = questions[tab]!;
        const set = toggled.get(tab) ?? new Set<number>();
        add(' ', theme.bold(q.question));
        lines.push('');
        rows(q).forEach((label, index) => {
          const selected = index === cursor;
          const box = q.multiSelect && index < q.options.length ? (set.has(index) ? '[x] ' : '[ ] ') : '';
          add(selected ? theme.fg('accent', '› ') : '  ', theme.fg(selected ? 'accent' : 'text', `${index + 1}. ${box}${label}`));
          const description = q.options[index]?.description;
          if (description) add('     ', theme.fg('muted', description));
        });
        if (typing) {
          lines.push('');
          for (const line of editor.render(Math.max(1, w - 2))) lines.push(` ${line}`);
        }
      }
      lines.push('');
      const help = typing
        ? 'Enter submit · Esc back'
        : [isMulti ? 'Tab/←→ questions' : '', '↑↓/1-9 move', questions[tab]?.multiSelect ? 'Space toggle' : '', 'Enter choose', 'Esc cancel'].filter(Boolean).join(' · ');
      add(' ', theme.fg('dim', help));
      lines.push(theme.fg('accent', '─'.repeat(w)));
      cache = lines;
      return lines;
    }

    // Focusable: pass focus through to the editor so it emits the cursor marker (hardware cursor, IME placement).
    return {
      get focused() {
        return editor.focused;
      },
      set focused(value: boolean) {
        editor.focused = value;
      },
      render,
      invalidate: () => {
        cache = undefined;
        editor.invalidate();
      },
      handleInput,
      dispose: () => signal?.removeEventListener('abort', onAbort),
    };
  });
}
