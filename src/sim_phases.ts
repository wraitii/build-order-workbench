import { EventQueue } from "./event_queue";
import { NodeDepletionEvent } from "./economy";
import { EPS, SimState } from "./sim_shared";
import { BuildOrderCommand, GameData, SimOptions } from "./types";
import { matchesNodeSelector } from "./node_selectors";

export interface TriggerEventContext {
    actors: string[];
    createdNodeIds?: string[];
}

export interface TriggerEvent {
    kind: "clicked" | "completed" | "depleted";
    actionId?: string;
    nodeId?: string;
    context: TriggerEventContext;
}

type BoundaryPhase = "completion" | "depletion" | "deferred" | "trigger" | "automation";

type BoundaryEvent =
    | { kind: "completion"; actionId: string; actors: string[] }
    | { kind: "depletion"; event: NodeDepletionEvent }
    | { kind: "trigger"; event: TriggerEvent }
    | { kind: "deferred" }
    | { kind: "automation" };

export function processTriggers(
    state: SimState,
    game: GameData,
    options: SimOptions,
    event: TriggerEvent,
    executeCommand: (
        state: SimState,
        game: GameData,
        options: SimOptions,
        cmd: BuildOrderCommand,
        commandIndex: number,
        triggerContext?: TriggerEventContext,
    ) => void,
): void {
    for (const rule of state.triggerRules) {
        if (rule.trigger.kind === "clicked" || rule.trigger.kind === "completed") {
            if (event.kind !== rule.trigger.kind) continue;
            if (event.actionId !== rule.trigger.actionId) continue;
        } else if (rule.trigger.kind === "depleted") {
            if (event.kind !== "depleted") continue;
            if (!event.nodeId) continue;
            const node = state.resourceNodeById[event.nodeId];
            if (!node) continue;
            if (!matchesNodeSelector(node, rule.trigger.resourceNodeSelector)) continue;
        } else if (rule.trigger.kind === "exhausted") {
            const selector = rule.trigger.resourceNodeSelector;
            if (event.kind !== "depleted") continue;
            if (!event.nodeId) continue;
            const depletedNode = state.resourceNodeById[event.nodeId];
            if (!depletedNode) continue;
            if (!matchesNodeSelector(depletedNode, selector)) continue;
            const matchingNodes = state.resourceNodes.filter((node) => matchesNodeSelector(node, selector));
            if (matchingNodes.length === 0) continue;
            const allDepleted = matchingNodes.every(
                (node) => node.depleted || (node.remainingStock ?? Infinity) <= EPS,
            );
            if (!allDepleted) continue;
        }
        executeCommand(state, game, options, rule.command, rule.sourceCommandIndex, event.context);
    }
}

export function processBoundaryPhases(
    state: SimState,
    game: GameData,
    options: SimOptions,
    completions: Array<{ actionId: string; actors: string[] }>,
    depletions: NodeDepletionEvent[],
    callbacks: {
        onComplete: (
            state: SimState,
            game: GameData,
            actionId: string,
            actors: string[],
        ) => { createdNodeIds: string[] };
        onDeferred: () => void;
        onAutomation: () => void;
        onAutomationWake?: () => void;
        executeCommand: (
            state: SimState,
            game: GameData,
            options: SimOptions,
            cmd: BuildOrderCommand,
            commandIndex: number,
            triggerContext?: TriggerEventContext,
        ) => void;
    },
): void {
    const phasePriority: Record<BoundaryPhase, number> = {
        completion: 10,
        depletion: 20,
        deferred: 30,
        trigger: 40,
        automation: 50,
    };
    const queue = new EventQueue<BoundaryPhase, BoundaryEvent>(phasePriority);

    for (const completion of completions) {
        queue.push(state.now, "completion", {
            kind: "completion",
            actionId: completion.actionId,
            actors: [...completion.actors],
        });
    }
    for (const depletion of depletions) {
        queue.push(state.now, "depletion", { kind: "depletion", event: depletion });
    }
    queue.push(state.now, "deferred", { kind: "deferred" });
    queue.push(state.now, "automation", { kind: "automation" });

    while (!queue.isEmpty()) {
        const item = queue.pop();
        if (!item) break;

        if (item.payload.kind === "completion") {
            const { createdNodeIds } = callbacks.onComplete(state, game, item.payload.actionId, item.payload.actors);
            callbacks.onAutomationWake?.();
            queue.push(state.now, "trigger", {
                kind: "trigger",
                event: {
                    kind: "completed",
                    actionId: item.payload.actionId,
                    context: { actors: [...item.payload.actors], createdNodeIds },
                },
            });
            continue;
        }

        if (item.payload.kind === "depletion") {
            const nodeId = item.payload.event.nodeId;
            if (state.nodeDepletionTimes[nodeId] === undefined) {
                state.nodeDepletionTimes[nodeId] = state.now;
            }
            callbacks.onAutomationWake?.();
            queue.push(state.now, "trigger", {
                kind: "trigger",
                event: {
                    kind: "depleted",
                    nodeId: item.payload.event.nodeId,
                    context: { actors: [...item.payload.event.actors] },
                },
            });
            continue;
        }

        if (item.payload.kind === "deferred") {
            callbacks.onDeferred();
            continue;
        }

        if (item.payload.kind === "trigger") {
            processTriggers(state, game, options, item.payload.event, callbacks.executeCommand);
            continue;
        }

        callbacks.onAutomation();
    }
}
