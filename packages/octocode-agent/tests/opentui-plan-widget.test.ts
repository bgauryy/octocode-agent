import { describe, expect, it } from 'vitest';
import {
  PlanWidget,
  type PlanWidgetSnapshot,
} from '../src/terminal/opentui/widgets/plan.js';

function snapshot(overrides: Partial<PlanWidgetSnapshot> = {}): PlanWidgetSnapshot {
  return {
    authority: 'runtime',
    planId: 'plan-1',
    scope: { sessionId: 'session-1', workspace: '/workspace' },
    revision: 3,
    phase: 'active',
    steps: [
      { id: 'discover', text: 'Map the implementation', status: 'done', checkCommand: 'yarn test', receipt: { authority: 'runtime', command: 'yarn test', status: 'SUCCESS', message: '42 tests passed' } },
      { id: 'implement', text: 'Build the widget', activeForm: 'Building the widget', status: 'doing', dependsOn: ['discover'], checkCommand: 'yarn test plan' },
      { id: 'verify', text: 'Verify accessibility', status: 'todo', dependsOn: ['implement'] },
    ],
    ...overrides,
  };
}

function activeWidget(value = snapshot()): PlanWidget {
  const widget = new PlanWidget('plan', value, { widthColumns: 72, viewportRows: 2 });
  widget.mount();
  widget.activate();
  widget.focus();
  return widget;
}

describe('PlanWidget', () => {
  it('renders a labeled, ordered, read-only plan and marks the current step textually', () => {
    const widget = activeWidget();
    const observed: unknown[] = [];
    const state = widget.render({
      render: (value) => observed.push(value),
      destroy: () => undefined,
    });

    expect(observed).toEqual([state]);
    expect(widget.capabilities).toEqual({ focusable: true, inputMode: 'keys' });
    expect(state.accessibility).toMatchObject({ role: 'list', label: 'Execution plan' });
    expect(state.regions.map((region) => region.id)).toEqual([
      'summary',
      'list-label',
      'step-discover',
      'step-implement',
      'help',
    ]);
    expect(state.regions[3]?.text).toContain('>> CURRENT');
    expect(state.regions[3]?.text).toContain('2. [DOING]');
    expect(widget.toPlainText()).toContain('Plan plan-1 — revision 3 — phase ACTIVE');
    expect(widget.toPlainText()).toContain('depends on: discover');
    expect(widget.toPlainText()).toContain('verification: SUCCESS');
    expect(widget.toPlainText()).toContain('3. [TODO] verify: Verify accessibility');
  });

  it('supports navigation only and preserves the viewport across resize', () => {
    const widget = activeWidget();

    expect(widget.handleInput({ type: 'key', key: 'ArrowDown' })).toEqual({ status: 'handled' });
    expect(widget.scrollOffset).toBe(1);
    expect(widget.render().regions.some((region) => region.id === 'step-verify')).toBe(true);

    widget.resize(32, 2);
    expect(widget.scrollOffset).toBe(1);
    expect(widget.render().regions.find((region) => region.id === 'step-implement')?.text).toContain('CURRENT');
    expect(widget.handleInput({ type: 'submit' })).toEqual({ status: 'ignored' });
    expect(widget.handleInput({ type: 'select', index: 0 })).toEqual({ status: 'ignored' });
  });

  it('announces material phase, current-step, and completion changes without render noise', () => {
    const widget = activeWidget();
    expect(widget.takeAnnouncements()).toEqual([]);
    widget.render();
    widget.render();
    expect(widget.takeAnnouncements()).toEqual([]);

    widget.update(snapshot({
      revision: 4,
      phase: 'complete',
      steps: snapshot().steps.map((step) => ({
        ...step,
        status: 'done' as const,
        ...(step.checkCommand === undefined
          ? {}
          : { receipt: step.receipt ?? { authority: 'runtime' as const, command: step.checkCommand, status: 'SUCCESS' as const, message: 'verified' } }),
      })),
    }));
    expect(widget.takeAnnouncements()).toEqual([
      'Plan phase changed to complete.',
      'No plan step is currently active.',
      'Plan progress changed to 3 of 3 steps complete.',
    ]);
    widget.render();
    expect(widget.takeAnnouncements()).toEqual([]);
  });

  it('sanitizes terminal controls and recognizable secret material in all output', () => {
    const widget = activeWidget(snapshot({
      steps: [{
        id: 'safe',
        text: '\u001b[31mCall API with token=super-secret-value',
        activeForm: 'Bearer abcdefghijklmnop',
        status: 'doing',
        checkCommand: 'API_KEY=abcdef1234567890 yarn test',
        receipt: { authority: 'runtime', command: 'API_KEY=abcdef1234567890 yarn test', status: 'FAILED', message: 'sk-abcdefghijklmnopqrstuvwxyz password=hunter2' },
      }],
    }));
    const output = widget.toPlainText();
    expect(output).not.toContain('\u001b');
    expect(output).not.toContain('super-secret-value');
    expect(output).not.toContain('abcdefghijklmnop');
    expect(output).not.toContain('abcdef1234567890');
    expect(output).not.toContain('hunter2');
    expect(output).toContain('[REDACTED]');
  });

  it('rejects stale revisions, identity drift, reordered IDs, invalid dependencies, and fabricated verification shapes', () => {
    const widget = activeWidget();
    expect(() => widget.update(snapshot({ revision: 2 }))).toThrow(/stale/i);
    expect(() => widget.update(snapshot({ revision: 4, planId: 'other' }))).toThrow(/identity/i);
    expect(() => widget.update(snapshot({ revision: 4, steps: [...snapshot().steps].reverse() }))).toThrow(/reorder/i);
    expect(() => new PlanWidget('plan-bad-dependency', snapshot({
      steps: [{ id: 'one', text: 'One', status: 'todo', dependsOn: ['missing'] }],
    }))).toThrow(/dependency/i);
    expect(() => new PlanWidget('plan-bad-receipt', snapshot({
      steps: [{ id: 'one', text: 'One', status: 'done', receipt: { authority: 'runtime', command: '', status: 'SUCCESS', message: 'ok' } }],
    }))).toThrow(/receipt command/i);
  });

  it('rejects agent-authored snapshots and receipts at the provenance boundary', () => {
    const unauthorizedSnapshot = { ...snapshot(), authority: 'agent' } as unknown as PlanWidgetSnapshot;
    expect(() => new PlanWidget('unauthorized-plan', unauthorizedSnapshot)).toThrow(/runtime authority/i);

    const unauthorizedReceipt = snapshot({
      steps: [{
        id: 'one',
        text: 'One',
        status: 'done',
        checkCommand: 'yarn test',
        receipt: {
          authority: 'agent',
          command: 'yarn test',
          status: 'SUCCESS',
          message: 'claimed pass',
        },
      }],
    } as unknown as Partial<PlanWidgetSnapshot>);
    expect(() => new PlanWidget('unauthorized-receipt', unauthorizedReceipt)).toThrow(/runtime authority/i);
  });

  it('uses the shared sanitizer against bidi and terminal-string injection and rejects poisoned IDs', () => {
    const widget = activeWidget(snapshot({
      steps: [{
        id: 'safe',
        text: 'Start\u202Etxt.exe\u202C end\u001b]8;;https://evil.invalid\u0007click\u001b]8;;\u0007',
        status: 'doing',
      }],
    }));
    const output = widget.toPlainText();
    expect(output).not.toContain('\u202E');
    expect(output).not.toContain('\u202C');
    expect(output).not.toContain('\u001b]');
    expect(output).not.toContain('https://evil.invalid');
    expect(output).toContain('Starttxt.exe endclick');

    expect(() => new PlanWidget('poisoned-id', snapshot({
      steps: [{ id: 'safe\u202Eevil', text: 'One', status: 'todo' }],
    }))).toThrow(/bidi|stable id/i);
  });

  it('keeps blockers and unverified completion explicit in the complete alternate snapshot', () => {
    const widget = activeWidget(snapshot({
      steps: [
        { id: 'approval', text: 'Wait for approval', status: 'todo' },
        { id: 'blocked', text: 'Continue after approval', status: 'todo', dependsOn: ['approval'] },
        { id: 'done', text: 'Claimed complete', status: 'done' },
      ],
    }));
    const plain = widget.toPlainText();
    expect(plain).toContain('blocked by: approval [TODO]');
    expect(plain).toContain('verification: NOT RECORDED');
  });
});
