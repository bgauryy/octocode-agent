import type {
  AgentRuntime,
  AutomationDefinition,
} from "@octocodeai/agent-core";

import type { RuntimePlanSnapshot } from "./native-plan.js";
import type {
  NativeWorkerOperationIntent,
  NativeWorkerOperationsController,
} from "./native-worker-operations.js";
import {
  nativeCommandAlias,
  nativeCommandHelpItems,
} from "./native-command-catalog.js";
import {
  NATIVE_SETTINGS_SECTIONS,
  type NativeSettingsSection,
} from "./native-settings-page.js";
import type {
  NativeInteractivePresentationPort,
  NativePresentationWidget,
} from "./presentation/contracts.js";
import { NATIVE_DESIGN_CONTENT } from "./presentation/design/tokens.js";

export interface NativeSkillSummary {
  readonly name: string;
  readonly description: string;
}

export interface NativeAutomationCommandService {
  list(): Promise<readonly AutomationDefinition[]>;
  cancel(id: string, expectedRevision: number): Promise<AutomationDefinition>;
  run(id: string): Promise<void>;
}

const runtimeAutomations = new WeakMap<AgentRuntime, NativeAutomationCommandService>();

export function bindNativeRuntimeAutomations(
  runtime: AgentRuntime,
  automations: NativeAutomationCommandService,
): () => void {
  runtimeAutomations.set(runtime, automations);
  return () => runtimeAutomations.delete(runtime);
}

export interface NativeSlashCommandContext {
  readonly runtime: AgentRuntime;
  readonly terminal: NativeInteractivePresentationPort;
  readonly currentPlan: () => RuntimePlanSnapshot | undefined;
  readonly skills: () => readonly NativeSkillSummary[];
  readonly thinkingSupported?: boolean;
  readonly automations?: NativeAutomationCommandService;
  readonly workerOperations?: Pick<NativeWorkerOperationsController, "open" | "dispatch">;
  readonly onContextCleared?: () => void;
  readonly openSettings?: (section?: NativeSettingsSection) => Promise<{
    readonly ok: boolean;
    readonly url?: string;
    readonly message?: string;
  }>;
}

export type NativeSlashCommandOutcome = "not-command" | "handled" | "exit";

function presentWidget(
  terminal: NativeInteractivePresentationPort,
  widget: NativePresentationWidget,
): void {
  terminal.accept({
    type: "presentation-changed",
    property: "widget",
    value: widget,
  });
}

function notify(
  terminal: NativeInteractivePresentationPort,
  severity: "info" | "success" | "warning" | "error",
  message: string,
): void {
  terminal.accept({ type: "notification", severity, message });
}

function commandFailure(
  terminal: NativeInteractivePresentationPort,
  command: string,
  message: string,
): void {
  notify(terminal, "error", `${command}: ${message}`);
}

function errorMessage(
  result: Awaited<ReturnType<AgentRuntime["execute"]>>,
): string | undefined {
  return result.ok ? undefined : result.error.message;
}

function toolLine(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return "Unnamed tool";
  const item = value as Record<string, unknown>;
  const name =
    typeof item.label === "string"
      ? item.label
      : typeof item.name === "string"
        ? item.name
        : "Unnamed tool";
  const identifier =
    typeof item.name === "string" && item.name !== name
      ? ` (${item.name})`
      : "";
  const description =
    typeof item.description === "string" && item.description.trim()
      ? ` — ${item.description}`
      : "";
  const policy =
    typeof item.policy === "object" && item.policy !== null
      ? (item.policy as Record<string, unknown>)
      : undefined;
  const policyParts =
    policy === undefined
      ? []
      : ["effect", "trust", "approval", "plan"].flatMap((key) =>
          typeof policy[key] === "string"
            ? [`${key}: ${String(policy[key])}`]
            : [],
        );
  return `${name}${identifier}${description}${policyParts.length === 0 ? "" : ` [${policyParts.join(" · ")}]`}`;
}

function automationSchedule(definition: AutomationDefinition): string {
  const schedule = definition.schedule;
  if (schedule.kind === "once") return `once at ${schedule.at}`;
  if (schedule.kind === "interval")
    return `every ${schedule.everyMs}ms from ${schedule.anchorAt}`;
  return `cron ${schedule.expression} (${schedule.timeZone})`;
}

function automationLine(definition: AutomationDefinition): string {
  return `${definition.id} · ${definition.state} · revision ${definition.revision} · ${automationSchedule(definition)} · ${definition.action.name}@${definition.action.version}`;
}

function commandGeneration(value: string | undefined): number | undefined {
  if (value === undefined || !/^(?:0|[1-9]\d*)$/u.test(value)) return undefined;
  const generation = Number(value);
  return Number.isSafeInteger(generation) ? generation : undefined;
}

export async function handleNativeSlashCommand(
  line: string,
  context: NativeSlashCommandContext,
): Promise<NativeSlashCommandOutcome> {
  const trimmed = line.trim();
  if (!trimmed.startsWith("/")) return "not-command";
  const [rawName = "", ...rawArgs] = trimmed.slice(1).split(/\s+/);
  const requestedName = rawName.toLocaleLowerCase("en-US");
  const alias = nativeCommandAlias(requestedName);
  const name = alias?.target ?? requestedName;
  const args =
    rawArgs.length === 0 && alias?.defaultArgs
      ? [...alias.defaultArgs]
      : rawArgs;
  if (name === "exit" || name === "quit") return "exit";

  if (name === "help") {
    presentWidget(context.terminal, {
      id: "native-command-output",
      kind: "list",
      title: "Native commands",
      items: [
        ...nativeCommandHelpItems(),
        "@path — Insert a validated workspace file reference",
      ],
    });
    return "handled";
  }

  if (name === "status") {
    const snapshot = context.runtime.snapshot();
    presentWidget(context.terminal, {
      id: "native-command-output",
      kind: "key-value",
      title: "Runtime status",
      rows: [
        { label: "State", value: snapshot.state },
        { label: "Session", value: String(snapshot.sessionId) },
        {
          label: "Model",
          value:
            snapshot.model === null
              ? "not selected"
              : `${snapshot.model.providerId}/${snapshot.model.modelId}`,
        },
        { label: "Thinking", value: snapshot.thinkingLevel ?? "default" },
        { label: "Input tokens", value: String(snapshot.usage.inputTokens) },
        { label: "Output tokens", value: String(snapshot.usage.outputTokens) },
        ...(snapshot.usage.cachedInputTokens === undefined
          ? []
          : [
              {
                label: "Cached input tokens",
                value: String(snapshot.usage.cachedInputTokens),
              },
            ]),
        ...(snapshot.usage.cacheWriteInputTokens === undefined
          ? []
          : [
              {
                label: "Cache write tokens",
                value: String(snapshot.usage.cacheWriteInputTokens),
              },
            ]),
      ],
    });
    return "handled";
  }

  if (name === "automations") {
    const action = args[0];
    const automations =
      context.automations ?? runtimeAutomations.get(context.runtime);
    if (automations === undefined) {
      commandFailure(
        context.terminal,
        "/automations",
        "durable automations are unavailable in this mode",
      );
      return "handled";
    }
    if (action === "list" && args.length === 1) {
      try {
        const definitions = await automations.list();
        presentWidget(context.terminal, {
          id: "native-command-output",
          kind: "list",
          title: `Automations (${definitions.length})`,
          items:
            definitions.length === 0
              ? ["No durable automations configured."]
              : definitions.map(automationLine),
        });
      } catch {
        commandFailure(
          context.terminal,
          "/automations",
          "could not list durable automations",
        );
      }
      return "handled";
    }
    if (action === "cancel" && args.length === 3) {
      const id = args[1]!;
      const rawRevision = args[2]!;
      if (
        !/^(?:0|[1-9]\d*)$/u.test(rawRevision) ||
        !Number.isSafeInteger(Number(rawRevision))
      ) {
        commandFailure(
          context.terminal,
          "/automations",
          "revision must be a canonical non-negative integer",
        );
        return "handled";
      }
      try {
        const cancelled = await automations.cancel(
          id,
          Number(rawRevision),
        );
        notify(
          context.terminal,
          "success",
          `Automation cancelled: ${cancelled.id} (revision ${cancelled.revision})`,
        );
      } catch {
        commandFailure(
          context.terminal,
          "/automations",
          "could not cancel the requested automation",
        );
      }
      return "handled";
    }
    if (action === "run" && args.length === 2) {
      try {
        await automations.run(args[1]!);
        notify(
          context.terminal,
          "success",
          `Automation run requested: ${args[1]}`,
        );
      } catch {
        commandFailure(
          context.terminal,
          "/automations",
          "could not run the requested automation",
        );
      }
      return "handled";
    }
    commandFailure(
      context.terminal,
      "/automations",
      "usage: /automations list | /automations cancel <id> <revision> | /automations run <id>",
    );
    return "handled";
  }

  if (name === "workers") {
    const operations = context.workerOperations;
    if (operations === undefined) {
      commandFailure(context.terminal, "/workers", "worker inbox operations are unavailable in this mode");
      return "handled";
    }
    const action = args[0];
    try {
      if ((action === "list" || action === "refresh") && args.length === 1) {
        const inbox = await operations.open();
        context.terminal.accept({ type: "worker-inbox-changed", inbox });
        return "handled";
      }
      const workerId = args[1];
      const expectedGeneration = commandGeneration(args[2]);
      if (action === "status" && workerId !== undefined && expectedGeneration !== undefined && args.length === 3) {
        const inbox = await operations.dispatch({ type: "inspect", expectedGeneration, workerId });
        context.terminal.accept({ type: "worker-inbox-changed", inbox });
        return "handled";
      }
      if (
        (action === "send" || action === "follow-up" || action === "steer") &&
        workerId !== undefined && expectedGeneration !== undefined && args.length >= 4
      ) {
        const text = args.slice(3).join(" ").trim();
        const intent: NativeWorkerOperationIntent = { type: action, expectedGeneration, workerId, text };
        const inbox = await operations.dispatch(intent);
        context.terminal.accept({ type: "worker-inbox-changed", inbox });
        return "handled";
      }
      if (
        (action === "abort" || action === "kill") &&
        workerId !== undefined && expectedGeneration !== undefined && args.length >= 3
      ) {
        const reason = args.slice(3).join(" ").trim();
        const intent: NativeWorkerOperationIntent = {
          type: action,
          expectedGeneration,
          workerId,
          ...(reason.length === 0 ? {} : { reason }),
        };
        const inbox = await operations.dispatch(intent);
        context.terminal.accept({ type: "worker-inbox-changed", inbox });
        return "handled";
      }
    } catch (error) {
      commandFailure(
        context.terminal,
        "/workers",
        error instanceof Error ? error.message : "worker operation failed; refresh the inbox before retrying",
      );
      return "handled";
    }
    commandFailure(
      context.terminal,
      "/workers",
      "usage: /workers list | status <worker-id> <generation> | send|follow-up|steer <worker-id> <generation> <message> | abort|kill <worker-id> <generation> [reason]",
    );
    return "handled";
  }

  if (name === "settings") {
    const section = args[0];
    if (
      args.length > 1 ||
      (section !== undefined &&
        !(NATIVE_SETTINGS_SECTIONS as readonly string[]).includes(section))
    ) {
      commandFailure(
        context.terminal,
        "/settings",
        `section must be one of: ${NATIVE_SETTINGS_SECTIONS.join(", ")}`,
      );
      return "handled";
    }
    if (context.openSettings === undefined) {
      commandFailure(
        context.terminal,
        "/settings",
        "the local settings page is unavailable in this mode",
      );
      return "handled";
    }
    try {
      notify(context.terminal, "info", NATIVE_DESIGN_CONTENT.settingsOpening);
      const result = await context.openSettings(
        section as NativeSettingsSection | undefined,
      );
      const suffix = result.url ? ` · ${result.url}` : "";
      if (result.ok)
        notify(context.terminal, "success", `Settings opened${suffix}`);
      else
        notify(
          context.terminal,
          "warning",
          `${result.message ?? "Could not open the browser; open the local page manually."}${suffix}`,
        );
    } catch {
      commandFailure(
        context.terminal,
        "/settings",
        "could not start the local settings page",
      );
    }
    return "handled";
  }

  if (name === "thinking") {
    const level = args[0];
    if (!level) {
      commandFailure(context.terminal, "/thinking", "usage: /thinking <level>");
      return "handled";
    }
    if (context.thinkingSupported !== true) {
      commandFailure(
        context.terminal,
        "/thinking",
        "the configured model adapter does not support thinking controls",
      );
      return "handled";
    }
    const result = await context.runtime.execute({
      type: "model.thinking",
      level,
    });
    const failure = errorMessage(result);
    if (failure) commandFailure(context.terminal, "/thinking", failure);
    else notify(context.terminal, "success", `Thinking level: ${level}`);
    return "handled";
  }

  if (name === "clear") {
    if (args.length > 0) {
      commandFailure(context.terminal, "/clear", "usage: /clear");
      return "handled";
    }
    const result = await context.runtime.execute({ type: "session.create" });
    const failure = errorMessage(result);
    if (failure) commandFailure(context.terminal, "/clear", failure);
    else {
      if (context.onContextCleared === undefined)
        context.terminal.accept({ type: "context-cleared" });
      else context.onContextCleared();
      notify(
        context.terminal,
        "success",
        "Context cleared. New session started.",
      );
    }
    return "handled";
  }

  if (name === "compact") {
    const result = await context.runtime.execute({
      type: "context.compact",
      reason: "manual",
    });
    const failure = errorMessage(result);
    if (failure) commandFailure(context.terminal, "/compact", failure);
    else notify(context.terminal, "success", "Context compacted.");
    return "handled";
  }

  if (name === "cancel") {
    if (!context.terminal.cancelInteraction?.())
      await context.runtime.cancel("slash command");
    notify(context.terminal, "info", "Cancellation requested.");
    return "handled";
  }

  if (name === "steer") {
    const text = args.join(" ").trim();
    if (!text) {
      commandFailure(context.terminal, "/steer", "usage: /steer <message>");
      return "handled";
    }
    const result = await context.runtime.execute({ type: "input.steer", text });
    const failure = errorMessage(result);
    if (failure) commandFailure(context.terminal, "/steer", failure);
    else notify(context.terminal, "success", "Steering requested.");
    return "handled";
  }

  if (name === "plan") {
    if (args.length > 0 && args[0] !== "show") {
      commandFailure(context.terminal, "/plan", "usage: /plan show");
      return "handled";
    }
    const plan = context.currentPlan();
    if (plan === undefined || plan.phase === "empty")
      notify(context.terminal, "info", "No active plan.");
    else context.terminal.accept({ type: "plan-changed", plan });
    return "handled";
  }

  if (name === "skills") {
    const skills = context.skills();
    presentWidget(context.terminal, {
      id: "native-command-output",
      kind: "list",
      title: `Agent Skills (${skills.length})`,
      items:
        skills.length === 0
          ? ["No enabled Agent Skills discovered."]
          : skills.map((skill) => `${skill.name} — ${skill.description}`),
    });
    return "handled";
  }

  if (name === "tools") {
    const result = await context.runtime.execute({ type: "tools.list" });
    const failure = errorMessage(result);
    if (failure) commandFailure(context.terminal, "/tools", failure);
    else {
      const data = result.ok && Array.isArray(result.data) ? result.data : [];
      presentWidget(context.terminal, {
        id: "native-command-output",
        kind: "list",
        title: `Tools (${data.length})`,
        items:
          data.length === 0
            ? ["No runtime tools registered."]
            : data.map(toolLine),
      });
    }
    return "handled";
  }

  commandFailure(context.terminal, trimmed, "unknown command; use /help");
  return "handled";
}
