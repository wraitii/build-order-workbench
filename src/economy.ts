import { applyNumericModifiers } from "./modifiers";
import { GameData, ResourceNodeDef, ResourceNodeInstance } from "./types";
import {
    EPS,
    SimState,
    cloneResources,
    findNextEventTime,
    switchEntityActivity,
    toFutureTick,
    toTick,
} from "./sim_shared";

export interface TargetEconomy {
    target: ResourceNodeInstance;
    rate: number;
    workers: string[];
}

interface NodeDrain {
    target: ResourceNodeInstance;
    rate: number;
}

export interface EconomySnapshot {
    resourceRates: Record<string, number>;
    targetEconomy: TargetEconomy[];
    nodeDrains: NodeDrain[];
    nextDepletionTime?: number;
}

export interface NodeDepletionEvent {
    nodeId: string;
    nodePrototypeId: string;
    actors: string[];
}

function resourceNodeStockKeys(node: ResourceNodeInstance): string[] {
    return [`gather.stock.node.${node.prototypeId}`, ...node.tags.map((t) => `gather.stock.tag.${t}`)];
}

function resourceNodeRateKeys(node: ResourceNodeInstance, entityType: string): string[] {
    return [
        `gather.rate.node.${node.prototypeId}`,
        `gather.rate.entity.${entityType}`,
        ...node.tags.map((t) => `gather.rate.tag.${t}`),
    ];
}

function resourceNodeSecondaryRateKeys(
    node: ResourceNodeInstance,
    entityType: string,
    secondaryResource: string,
): string[] {
    return [
        `gather.secondary.${secondaryResource}.resource.${node.produces}`,
        `gather.secondary.${secondaryResource}.node.${node.prototypeId}`,
        `gather.secondary.${secondaryResource}.entity.${entityType}`,
        ...node.tags.map((t) => `gather.secondary.${secondaryResource}.tag.${t}`),
    ];
}

function listSecondaryResources(modifiers: { selector: string }[]): string[] {
    const out = new Set<string>();
    for (const mod of modifiers) {
        const m = mod.selector.match(/^gather\.secondary\.([^.]+)\./);
        if (!m?.[1]) continue;
        out.add(m[1]);
    }
    return [...out];
}

export function instantiateResourceNode(state: SimState, prototype: ResourceNodeDef): ResourceNodeInstance {
    state.resourceNodeCounter += 1;
    const id = `${prototype.id}-${state.resourceNodeCounter}`;

    const node: ResourceNodeInstance = {
        id,
        prototypeId: prototype.id,
        name: `${prototype.name} ${state.resourceNodeCounter}`,
        produces: prototype.produces,
        rateByEntityType: { ...prototype.rateByEntityType },
        tags: [...(prototype.tags ?? [])],
    };

    if (prototype.maxWorkers !== undefined) node.maxWorkers = prototype.maxWorkers;
    if (prototype.stock !== undefined) {
        node.remainingStock = Math.max(
            0,
            applyNumericModifiers(prototype.stock, resourceNodeStockKeys(node), state.activeModifiers),
        );
    }
    if (prototype.decayRatePerSecond !== undefined) node.decayRatePerSecond = prototype.decayRatePerSecond;
    if (prototype.decayStart !== undefined) node.decayStart = prototype.decayStart;
    if ((node.decayRatePerSecond ?? 0) > 0) {
        node.decayActive = node.decayStart !== "on_first_gather";
    }

    state.resourceNodes.push(node);
    state.resourceNodeById[node.id] = node;
    return node;
}

export function activateNodeDecay(node: ResourceNodeInstance): void {
    if ((node.decayRatePerSecond ?? 0) <= 0) return;
    if (node.decayStart !== "on_first_gather") return;
    node.decayActive = true;
}

export function applyStockModifierToExistingNodes(
    state: SimState,
    mod: { selector: string; op: "mul" | "add" | "set"; value: number },
): void {
    if (!mod.selector.startsWith("gather.stock.")) return;
    for (const node of state.resourceNodes) {
        if (node.remainingStock === undefined) continue;
        node.remainingStock = Math.max(
            0,
            applyNumericModifiers(node.remainingStock, resourceNodeStockKeys(node), [mod]),
        );
    }
}

export function computeEconomySnapshot(state: SimState): EconomySnapshot {
    const resourceRates: Record<string, number> = {};
    const grouped: Record<string, TargetEconomy> = {};
    const gatherRateByNodeId: Record<string, number> = {};
    const secondaryResources = listSecondaryResources(state.activeModifiers);

    for (const ent of state.entities) {
        if (ent.busyUntil > state.now + EPS || !ent.resourceNodeId) continue;
        const node = state.resourceNodeById[ent.resourceNodeId];
        if (!node) continue;
        if (node.remainingStock !== undefined && node.remainingStock <= EPS) continue;

        const baseRate = node.rateByEntityType[ent.entityType] ?? 0;
        if (baseRate <= 0) continue;

        const effectiveRate = applyNumericModifiers(
            baseRate,
            resourceNodeRateKeys(node, ent.entityType),
            state.activeModifiers,
        );
        if (effectiveRate <= 0) continue;

        const bucket = grouped[node.id] ?? { target: node, rate: 0, workers: [] };
        bucket.rate += effectiveRate;
        bucket.workers.push(ent.id);
        grouped[node.id] = bucket;
        gatherRateByNodeId[node.id] = (gatherRateByNodeId[node.id] ?? 0) + effectiveRate;

        for (const secondaryResource of secondaryResources) {
            const factor = applyNumericModifiers(
                0,
                resourceNodeSecondaryRateKeys(node, ent.entityType, secondaryResource),
                state.activeModifiers,
            );
            if (factor <= 0) continue;
            resourceRates[secondaryResource] = (resourceRates[secondaryResource] ?? 0) + effectiveRate * factor;
        }
    }

    let nextDepletionTime: number | undefined;
    const targetEconomy = Object.values(grouped);
    const nodeDrains: NodeDrain[] = [];
    for (const item of targetEconomy) {
        resourceRates[item.target.produces] = (resourceRates[item.target.produces] ?? 0) + item.rate;
    }

    for (const node of state.resourceNodes) {
        if (node.remainingStock === undefined || node.remainingStock <= EPS) continue;
        const gatherRate = gatherRateByNodeId[node.id] ?? 0;
        const decayRate = node.decayActive ? Math.max(0, node.decayRatePerSecond ?? 0) : 0;
        const totalDrainRate = gatherRate + decayRate;
        if (totalDrainRate <= 0) continue;
        nodeDrains.push({ target: node, rate: totalDrainRate });
        const t = state.now + node.remainingStock / totalDrainRate;
        if (nextDepletionTime === undefined || t < nextDepletionTime) nextDepletionTime = t;
    }

    return nextDepletionTime === undefined
        ? { resourceRates, targetEconomy, nodeDrains }
        : { resourceRates, targetEconomy, nodeDrains, nextDepletionTime };
}

function handleDepletedNodes(state: SimState): NodeDepletionEvent[] {
    const events: NodeDepletionEvent[] = [];
    for (const node of state.resourceNodes) {
        if (node.remainingStock === undefined || node.remainingStock > EPS || node.depleted) continue;
        node.depleted = true;
        const actors: string[] = [];
        for (const ent of state.entities) {
            if (ent.resourceNodeId !== node.id) continue;
            actors.push(ent.id);
            delete ent.resourceNodeId;
            if (ent.busyUntil <= state.now + EPS) switchEntityActivity(state, ent.id, "idle", "idle");
        }
        events.push({ nodeId: node.id, nodePrototypeId: node.prototypeId, actors });
    }
    return events;
}

export function advanceTime(
    state: SimState,
    targetTime: number,
    onEventComplete: (state: SimState, game: GameData, actionId: string, actors: string[]) => void,
    game: GameData,
    onNodeDepleted?: (state: SimState, event: NodeDepletionEvent) => void,
): void {
    targetTime = toTick(targetTime);
    if (targetTime <= state.now + EPS) return;

    let guard = 0;
    while (state.now + EPS < targetTime) {
        guard += 1;
        if (guard > 1_000_000) {
            throw new Error(`advanceTime loop guard tripped (now=${state.now}, target=${targetTime}).`);
        }
        const nextEventTime = findNextEventTime(state.events, state.now) ?? Infinity;
        const econ = computeEconomySnapshot(state);
        const nextDepletionTick =
            econ.nextDepletionTime !== undefined ? toFutureTick(econ.nextDepletionTime) : Infinity;
        const stepTo = Math.min(targetTime, nextEventTime, nextDepletionTick);
        const dt = stepTo - state.now;

        if (dt > EPS) {
            state.resourceTimeline.push({
                start: state.now,
                end: stepTo,
                startResources: cloneResources(state.resources),
                gatherRates: cloneResources(econ.resourceRates),
            });

            for (const [resource, rate] of Object.entries(econ.resourceRates)) {
                state.resources[resource] = (state.resources[resource] ?? 0) + rate * dt;
            }
            for (const item of econ.nodeDrains) {
                if (item.target.remainingStock === undefined) continue;
                item.target.remainingStock = Math.max(0, item.target.remainingStock - item.rate * dt);
            }

            state.now = stepTo;
            const depleted = handleDepletedNodes(state);
            if (onNodeDepleted) {
                for (const event of depleted) onNodeDepleted(state, event);
            }
        } else {
            state.now = stepTo;
        }

        if (Math.abs(state.now - nextEventTime) <= EPS) {
            const due = state.events.filter((e) => Math.abs(e.time - state.now) <= EPS);
            state.events = state.events.filter((e) => Math.abs(e.time - state.now) > EPS);
            for (const ev of due) onEventComplete(state, game, ev.actionId, ev.actors);
        }
    }
}
