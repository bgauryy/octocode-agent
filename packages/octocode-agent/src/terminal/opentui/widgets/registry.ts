import {
  MAX_WIDGET_KIND_LENGTH,
  MAX_WIDGET_REGISTRY_ENTRIES,
  WidgetContractError,
  type WidgetContract,
  type WidgetDefinition,
  type WidgetFactory,
} from './contracts.js';

const KIND_PATTERN = /^[a-z][a-z0-9.-]*$/;

export interface WidgetRegistryOptions {
  readonly maxEntries?: number;
}

export class WidgetRegistry {
  private readonly definitions = new Map<string, WidgetDefinition<unknown>>();
  private readonly factoryKinds = new Map<WidgetFactory<unknown>, string>();
  private readonly createdInstances = new WeakSet<object>();
  private readonly maxEntries: number;

  constructor(options: WidgetRegistryOptions = {}) {
    const maxEntries = options.maxEntries ?? MAX_WIDGET_REGISTRY_ENTRIES;
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > MAX_WIDGET_REGISTRY_ENTRIES) {
      throw new WidgetContractError('validation', 'registry maxEntries is outside its supported bound');
    }
    this.maxEntries = maxEntries;
  }

  register<TConstructionInput, TWidget extends WidgetContract>(
    definition: WidgetDefinition<TConstructionInput, TWidget>,
  ): void {
    if (definition.kind.length > MAX_WIDGET_KIND_LENGTH || !KIND_PATTERN.test(definition.kind)) {
      throw new WidgetContractError('validation', 'widget definition kind is invalid');
    }
    if (typeof definition.create !== 'function') {
      throw new WidgetContractError('validation', 'widget definition create must be a function');
    }
    if (this.definitions.has(definition.kind)) {
      throw new WidgetContractError('duplicate', `duplicate widget kind '${definition.kind}'`);
    }
    const existingFactoryKind = this.factoryKinds.get(definition.create as WidgetFactory<unknown>);
    if (existingFactoryKind !== undefined) {
      throw new WidgetContractError(
        'duplicate',
        `widget factory is already registered for kind '${existingFactoryKind}'`,
      );
    }
    if (this.definitions.size >= this.maxEntries) {
      throw new WidgetContractError('capacity', 'widget registry capacity exceeded');
    }
    if (!Number.isSafeInteger(definition.order)) {
      throw new WidgetContractError('validation', 'widget definition order must be a safe integer');
    }
    const registered: WidgetDefinition<unknown> = Object.freeze({
      kind: definition.kind,
      order: definition.order,
      create: (id: string, input: unknown) => definition.create(id, input as TConstructionInput),
    });
    this.definitions.set(definition.kind, registered);
    this.factoryKinds.set(definition.create as WidgetFactory<unknown>, definition.kind);
  }

  list(): readonly WidgetDefinition[] {
    return Object.freeze([...this.definitions.values()].sort(
      (left, right) => left.order - right.order || left.kind.localeCompare(right.kind),
    ));
  }

  create<TWidget extends WidgetContract = WidgetContract>(kind: string, id: string): TWidget;
  create<TConstructionInput, TWidget extends WidgetContract = WidgetContract>(
    kind: string,
    id: string,
    input: TConstructionInput,
  ): TWidget;
  create<TWidget extends WidgetContract = WidgetContract>(
    kind: string,
    id: string,
    input?: unknown,
  ): TWidget {
    const definition = this.definitions.get(kind);
    if (!definition) throw new WidgetContractError('not-found', `unknown widget kind '${kind}'`);
    const widget = definition.create(id, input);
    if (typeof widget !== 'object' || widget === null || widget.kind !== kind || widget.id !== id) {
      throw new WidgetContractError(
        'mismatch',
        `widget factory returned mismatched identity for kind '${kind}' and id '${id}'`,
      );
    }
    if (this.createdInstances.has(widget)) {
      throw new WidgetContractError('mismatch', `widget factory reused an instance for kind '${kind}' and id '${id}'`);
    }
    this.createdInstances.add(widget);
    return widget as TWidget;
  }
}
