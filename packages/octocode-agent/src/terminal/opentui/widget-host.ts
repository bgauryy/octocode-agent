import type { WidgetContract, WidgetRenderAdapter } from './widgets/contracts.js';

export interface WidgetHostAdapter extends WidgetRenderAdapter {
  focusWidget?(widgetId: string | undefined): void;
}

export type NavigableWidgetGuard<TWidget extends WidgetContract> = (
  widget: WidgetContract,
) => widget is TWidget;

/**
 * Owns widget identity, lifecycle, and focus independently from presentation
 * projection. Controllers compose this host instead of maintaining parallel
 * widget maps and focus state.
 */
export class WidgetHost<TNavigable extends WidgetContract> {
  private readonly widgets = new Map<string, WidgetContract>();
  private focusedWidgetId?: string;

  constructor(
    private readonly adapter: WidgetHostAdapter,
    private readonly isNavigable: NavigableWidgetGuard<TNavigable>,
  ) {}

  register(widget: WidgetContract): void {
    const existing = this.widgets.get(widget.id);
    if (existing !== undefined && existing !== widget) {
      throw new Error(`widget id ${widget.id} is already registered`);
    }
    if (widget.lifecycle === 'created') widget.mount();
    if (widget.lifecycle === 'mounted' || widget.lifecycle === 'disabled') widget.activate();
    this.widgets.set(widget.id, widget);
  }

  remove(widget: WidgetContract): void {
    if (this.focusedWidgetId === widget.id) {
      this.focusedWidgetId = undefined;
      this.adapter.focusWidget?.(undefined);
    }
    widget.destroy(this.adapter);
    this.widgets.delete(widget.id);
  }

  focus(widgetId: string | undefined): boolean {
    const current = this.focused();
    if (widgetId === undefined) {
      current?.blur();
      current?.render(this.adapter);
      this.focusedWidgetId = undefined;
      this.adapter.focusWidget?.(undefined);
      return true;
    }

    const target = this.widgets.get(widgetId);
    if (!target || !this.isNavigable(target) || target.lifecycle !== 'active') return false;
    if (current !== target) {
      current?.blur();
      current?.render(this.adapter);
      target.focus();
      target.render(this.adapter);
      this.focusedWidgetId = target.id;
    }
    this.adapter.focusWidget?.(target.id);
    return true;
  }

  focused(): TNavigable | undefined {
    const widget = this.focusedWidgetId === undefined
      ? undefined
      : this.widgets.get(this.focusedWidgetId);
    return widget && this.isNavigable(widget) ? widget : undefined;
  }

  destroy(): void {
    for (const widget of [...this.widgets.values()]) widget.destroy(this.adapter);
    this.widgets.clear();
    if (this.focusedWidgetId !== undefined) this.adapter.focusWidget?.(undefined);
    this.focusedWidgetId = undefined;
  }
}
