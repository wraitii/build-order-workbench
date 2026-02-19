import { applyNumericModifiers } from "./modifiers";
import {
    BuildOrderCommand,
    CommandResult,
    GameData,
    NumericModifier,
    ResourceMap,
    ResourceNodeInstance,
    SimOptions,
} from "./types";
import {
    AutoQueueRule,
    EPS,
    QueueRule,
    SimState,
    appendDslLineContext,
    compareEntityIdNatural,
    quantizeDuration,
    switchEntityActivity,
    toFutureTick,
} from "./sim_shared";
import { activateNodeDecay, computeEconomySnapshot } from "./economy";
import { shouldDebugAction, simDebug } from "./debug";
import { matchesNodeSelector } from "./node_selectors";
import { nextEligibleActorAvailabilityTime, pickEligibleActorIds } from "./actor_eligibility";
import { formatMMSS } from "./time_format";

const NON_DEBT_RESOURCE_FLOORS: Record<string, number> = {
    feudal: 0,
    dark_age_buildings: 0,
    feudal_age_buildings: 0,
    mill_built: 0,
    barracks_built: 0,
};
const DELAYED_ACTION_WARNING_SECONDS = 30;

function effectiveCosts(action: GameData["actions"][string], modifiers: NumericModifier[]): ResourceMap {
    const raw = action.costs ?? {};
    if (modifiers.length === 0) return raw;
    const result: ResourceMap = {};
    for (const [resource, cost] of Object.entries(raw)) {
        result[resource] = Math.max(
            0,
            applyNumericModifiers(cost, [`action.cost.${action.id}.${resource}`], modifiers),
        );
    }
    return result;
}

function canAfford(
    resources: Record<string, number>,
    costs: Record<string, number>,
    debtFloor: number,
    resourceFloorOverrides?: Record<string, number>,
): string | undefined {
    for (const [resource, cost] of Object.entries(costs)) {
        const floor = resourceFloorOverrides?.[resource] ?? debtFloor;
        if ((resources[resource] ?? 0) - cost < floor) return resource;
    }
    return undefined;
}

function timeToAffordWithCurrentRates(
    resources: Record<string, number>,
    costs: Record<string, number>,
    rates: Record<string, number>,
    debtFloor: number,
    resourceFloorOverrides?: Record<string, number>,
): number {
    let required = 0;
    for (const [resource, cost] of Object.entries(costs)) {
        const floor = resourceFloorOverrides?.[resource] ?? debtFloor;
        const deficit = cost - ((resources[resource] ?? 0) - floor);
        if (deficit <= 0) continue;
        const rate = rates[resource] ?? 0;
        if (rate <= 0) return Infinity;
        required = Math.max(required, deficit / rate);
    }
    return required;
}

function chargeCosts(state: SimState, costs: Record<string, number>): string[] {
    const crossedNegative: string[] = [];
    for (const [resource, cost] of Object.entries(costs)) {
        const before = state.resources[resource] ?? 0;
        const after = before - cost;
        state.resources[resource] = after;
        state.maxDebt = Math.min(state.maxDebt, after);
        if (before >= 0 && after < 0) {
            crossedNegative.push(resource);
        }
    }
    return crossedNegative;
}

function resolveManyWorkersConfig(
    action: GameData["actions"][string],
): { model: "aoe2"; additionalWorkerRate: number } | undefined {
    const config = action.many_workers;
    if (!config) return undefined;
    if (config === "aoe2") return { model: "aoe2", additionalWorkerRate: 1 / 3 };
    if (typeof config !== "object" || config.model !== "aoe2") return undefined;
    const additionalWorkerRate = config.additionalWorkerRate ?? 1 / 3;
    return { model: "aoe2", additionalWorkerRate };
}

function applyManyWorkersDuration(
    singleWorkerDuration: number,
    workerCount: number,
    config?: { model: "aoe2"; additionalWorkerRate: number },
): number {
    if (!config || workerCount <= 1) return singleWorkerDuration;
    const r = config.additionalWorkerRate;
    if (!Number.isFinite(r) || r <= 0) return singleWorkerDuration;
    return singleWorkerDuration / (1 + (workerCount - 1) * r);
}

function resolveTaskEfficiencyMultiplier(game: GameData, action: GameData["actions"][string]): number {
    const taskType = action.taskType ?? "default";
    const configured = game.taskEfficiency?.byTaskType?.[taskType] ?? game.taskEfficiency?.default ?? 1.4;
    if (!Number.isFinite(configured) || configured <= 0) return 1.4;
    return configured;
}

function mergeFloorOverrides(
    base?: Record<string, number>,
    extra?: Record<string, number>,
): Record<string, number> | undefined {
    if (!base && !extra) return undefined;
    const merged: Record<string, number> = { ...(base ?? {}) };
    for (const [resource, floor] of Object.entries(extra ?? {})) {
        merged[resource] = Math.max(merged[resource] ?? Number.NEGATIVE_INFINITY, floor);
    }
    return merged;
}

function baseResourceFloorOverrides(game: GameData): Record<string, number> | undefined {
    const overrides: Record<string, number> = {};
    const popResource = game.population?.resource;
    if (popResource) overrides[popResource] = game.population?.floor ?? 0;

    for (const [resource, floor] of Object.entries(NON_DEBT_RESOURCE_FLOORS)) {
        if ((game.resources ?? []).includes(resource)) {
            overrides[resource] = Math.max(overrides[resource] ?? Number.NEGATIVE_INFINITY, floor);
        }
    }

    return Object.keys(overrides).length > 0 ? overrides : undefined;
}

function queueResourceReservations(state: SimState, game: GameData, options: SimOptions): Record<string, number> {
    const reservedCosts: Record<string, number> = {};
    for (const rule of state.queueRules) {
        if (!rule.lastBlockedReason) continue;
        const action = game.actions[rule.actionId];
        if (!action) continue;
        const costs = effectiveCosts(action, state.activeModifiers);
        for (const [resource, cost] of Object.entries(costs)) {
            if (cost <= 0) continue;
            reservedCosts[resource] = (reservedCosts[resource] ?? 0) + cost;
        }
    }
    if (Object.keys(reservedCosts).length === 0) return {};
    const floors: Record<string, number> = {};
    const baseFloors = baseResourceFloorOverrides(game) ?? {};
    for (const [resource, totalCost] of Object.entries(reservedCosts)) {
        floors[resource] = (baseFloors[resource] ?? options.debtFloor) + totalCost;
    }
    return floors;
}

export function resolveNodeTargets(
    state: SimState,
    resourceNodeIds?: string[],
    resourceNodeSelectors?: string[],
): ResourceNodeInstance[] {
    const out: ResourceNodeInstance[] = [];
    const seen = new Set<string>();

    for (const id of resourceNodeIds ?? []) {
        const node = state.resourceNodeById[id];
        if (!node || seen.has(node.id)) continue;
        seen.add(node.id);
        out.push(node);
    }

    if (resourceNodeSelectors && resourceNodeSelectors.length > 0) {
        const nodes = [...state.resourceNodes].sort((a, b) => compareEntityIdNatural(a.id, b.id));
        for (const node of nodes) {
            if (seen.has(node.id)) continue;
            if (resourceNodeSelectors.some((selector) => matchesNodeSelector(node, selector))) {
                seen.add(node.id);
                out.push(node);
            }
        }
    }

    return out;
}

function pickGatherNode(
    entType: string,
    targets: ResourceNodeInstance[],
    assignedCount: Record<string, number>,
): ResourceNodeInstance | undefined {
    return targets.find((t) => {
        if ((t.rateByEntityType[entType] ?? 0) <= 0) return false;
        if (t.remainingStock !== undefined && t.remainingStock <= EPS) return false;
        if (t.maxWorkers !== undefined && (assignedCount[t.id] ?? 0) >= t.maxWorkers) return false;
        return true;
    });
}

function activateDecayOnFirstGather(node: ResourceNodeInstance): void {
    activateNodeDecay(node);
}

function resolveConsumableNodes(
    state: SimState,
    prototypeId: string,
    count: number,
): ResourceNodeInstance[] | undefined {
    const available = [...state.resourceNodes]
        .filter(
            (node) =>
                node.prototypeId === prototypeId &&
                !node.depleted &&
                (node.remainingStock === undefined || node.remainingStock > EPS),
        )
        .sort((a, b) => compareEntityIdNatural(a.id, b.id));
    if (available.length < count) return undefined;
    return available.slice(0, count);
}

function consumeResourceNodes(state: SimState, specs: Array<{ prototypeId: string; count?: number }>): boolean {
    if (specs.length === 0) return true;

    const requiredByPrototype: Record<string, number> = {};
    for (const spec of specs) {
        const count = Math.max(1, spec.count ?? 1);
        requiredByPrototype[spec.prototypeId] = (requiredByPrototype[spec.prototypeId] ?? 0) + count;
    }

    const picked: ResourceNodeInstance[] = [];
    for (const [prototypeId, count] of Object.entries(requiredByPrototype)) {
        const nodes = resolveConsumableNodes(state, prototypeId, count);
        if (!nodes) return false;
        picked.push(...nodes);
    }

    for (const node of picked) {
        node.remainingStock = 0;
        node.depleted = true;
        for (const ent of state.entities) {
            if (ent.resourceNodeId !== node.id) continue;
            delete ent.resourceNodeId;
            if (ent.busyUntil <= state.now + EPS) {
                switchEntityActivity(state, ent.id, "idle", "idle");
            }
        }
    }
    return true;
}

export function assignEntityToGatherTargets(
    state: SimState,
    entityId: string,
    resourceNodeIds?: string[],
    resourceNodeSelectors?: string[],
): boolean {
    const ent = state.entities.find((e) => e.id === entityId);
    if (!ent) return false;

    const targets = resolveNodeTargets(state, resourceNodeIds, resourceNodeSelectors);
    if (targets.length === 0) return false;

    const assignedCount: Record<string, number> = {};
    for (const e of state.entities) {
        if (e.resourceNodeId) assignedCount[e.resourceNodeId] = (assignedCount[e.resourceNodeId] ?? 0) + 1;
    }

    const node = pickGatherNode(ent.entityType, targets, assignedCount);
    if (!node) return false;

    ent.resourceNodeId = node.id;
    activateDecayOnFirstGather(node);
    if (ent.busyUntil <= state.now + EPS) {
        switchEntityActivity(state, ent.id, "gather", `${node.produces}:${node.prototypeId}`);
    }
    return true;
}

export function tryScheduleActionNow(
    state: SimState,
    game: GameData,
    options: SimOptions,
    cmd: Pick<
        Extract<BuildOrderCommand, { type: "queueAction" }>,
        "actionId" | "actorSelectors" | "actorResourceNodeIds" | "actorResourceNodeSelectors"
    >,
    extraResourceFloorOverrides?: Record<string, number>,
    commandSourceLine?: number,
):
    | { status: "scheduled"; completionTime: number; actionId: string; actors: string[]; startedAt: number }
    | { status: "blocked"; reason: "NO_ACTORS" | "INSUFFICIENT_RESOURCES" | "POP_CAP" | "NO_RESOURCE_NODES" }
    | { status: "invalid"; message: string } {
    const action = game.actions[cmd.actionId];
    if (!action) {
        return { status: "invalid", message: `Action '${cmd.actionId}' not found.` };
    }

    if (cmd.actorSelectors && cmd.actorSelectors.length > 0) {
        for (const selector of cmd.actorSelectors) {
            if (!selector.match(/^(.*)-(\d+)$/) && !action.actorTypes.includes(selector)) {
                return { status: "invalid", message: `Actor type '${selector}' cannot perform '${action.id}'.` };
            }
        }
    }

    const actorCount =
        cmd.actorSelectors && cmd.actorSelectors.length > 0 ? cmd.actorSelectors.length : (action.actorCount ?? 1);
    const actorRequest: Parameters<typeof pickEligibleActorIds>[1] = {
        actorTypes: action.actorTypes,
        actorCount,
        idleOnly: true,
    };
    if (cmd.actorSelectors !== undefined) actorRequest.actorSelectors = cmd.actorSelectors;
    if (cmd.actorResourceNodeIds !== undefined) actorRequest.actorResourceNodeIds = cmd.actorResourceNodeIds;
    if (cmd.actorResourceNodeSelectors !== undefined)
        actorRequest.actorResourceNodeSelectors = cmd.actorResourceNodeSelectors;
    const actorIds = pickEligibleActorIds(state, actorRequest);
    if (actorIds.length < actorCount) {
        return { status: "blocked", reason: "NO_ACTORS" };
    }

    if (!consumeResourceNodes(state, action.consumesResourceNodes ?? [])) {
        return { status: "blocked", reason: "NO_RESOURCE_NODES" };
    }

    const costs = effectiveCosts(action, state.activeModifiers);
    const populationResource = game.population?.resource;
    const resourceFloorOverrides = mergeFloorOverrides(baseResourceFloorOverrides(game), extraResourceFloorOverrides);
    const blockedResource = canAfford(state.resources, costs, options.debtFloor, resourceFloorOverrides);
    if (blockedResource !== undefined) {
        return {
            status: "blocked",
            reason: blockedResource === populationResource ? "POP_CAP" : "INSUFFICIENT_RESOURCES",
        };
    }

    const crossedNegative = chargeCosts(state, costs);
    if (crossedNegative.length > 0) {
        const crossedWithValues = crossedNegative
            .map((resource) => `${resource}=${(state.resources[resource] ?? 0).toFixed(2)}`)
            .join(", ");
        state.violations.push({
            time: state.now,
            code: "NEGATIVE_RESOURCE",
            message: appendDslLineContext(
                `'${action.id}' pushed resources below zero: ${crossedWithValues} (debt-floor=${options.debtFloor}).`,
                commandSourceLine,
            ),
        });
    }

    const singleWorkerDuration = applyNumericModifiers(
        action.duration,
        [`action.duration.${action.id}`],
        state.activeModifiers,
    );
    const manyWorkers = resolveManyWorkersConfig(action);
    const baseDuration = applyManyWorkersDuration(singleWorkerDuration, actorIds.length, manyWorkers);
    const taskEfficiency = resolveTaskEfficiencyMultiplier(game, action);
    const duration = quantizeDuration(baseDuration * taskEfficiency);
    for (const id of actorIds) {
        const ent = state.entities.find((e) => e.id === id);
        if (!ent) continue;
        ent.busyUntil = state.now + duration;
        // Force a boundary for each queued run, even if the same action restarts immediately.
        switchEntityActivity(state, id, "action", action.id, true);
    }

    state.events.push({
        time: state.now + duration,
        actionId: action.id,
        actors: actorIds,
    });

    const clickTimes = state.actionClickTimes[action.id] ?? [];
    clickTimes.push(state.now);
    state.actionClickTimes[action.id] = clickTimes;

    return {
        status: "scheduled",
        completionTime: state.now + duration,
        actionId: action.id,
        actors: [...actorIds],
        startedAt: state.now,
    };
}

function commandFailureResult(rule: QueueRule, message: string): CommandResult {
    return {
        index: rule.commandIndex,
        type: "queueAction",
        requestedAt: rule.requestedAt,
        status: "failed",
        message,
    };
}

function commandScheduledResult(rule: QueueRule, startedAt: number): CommandResult {
    return {
        index: rule.commandIndex,
        type: "queueAction",
        requestedAt: rule.requestedAt,
        startedAt,
        delayedBy: startedAt - rule.requestedAt,
        status: "scheduled",
    };
}

function pushCommandScheduledResult(
    state: SimState,
    commandIndex: number,
    type: BuildOrderCommand["type"],
    requestedAt: number,
): void {
    state.commandResults.push({
        index: commandIndex,
        type,
        requestedAt,
        startedAt: state.now,
        delayedBy: state.now - requestedAt,
        status: "scheduled",
    });
}

function pushCommandFailedResult(
    state: SimState,
    commandIndex: number,
    type: BuildOrderCommand["type"],
    requestedAt: number,
    message: string,
): void {
    state.commandResults.push({
        index: commandIndex,
        type,
        requestedAt,
        status: "failed",
        message,
    });
}

function pushInvalidAssignment(
    state: SimState,
    commandIndex: number,
    type: BuildOrderCommand["type"],
    requestedAt: number,
    message: string,
): void {
    pushViolationForCommand(state, commandIndex, type, requestedAt, "INVALID_ASSIGNMENT", message);
}

function pushNoUnitAvailable(
    state: SimState,
    commandIndex: number,
    type: BuildOrderCommand["type"],
    requestedAt: number,
    message: string,
): void {
    pushViolationForCommand(state, commandIndex, type, requestedAt, "NO_UNIT_AVAILABLE", message);
}

function pushNoResource(
    state: SimState,
    commandIndex: number,
    type: BuildOrderCommand["type"],
    requestedAt: number,
    message: string,
): void {
    pushViolationForCommand(state, commandIndex, type, requestedAt, "NO_RESOURCE", message);
}

function pushResourceFull(
    state: SimState,
    commandIndex: number,
    type: BuildOrderCommand["type"],
    requestedAt: number,
    message: string,
): void {
    pushViolationForCommand(state, commandIndex, type, requestedAt, "RESOURCE_FULL", message);
}

function pushViolationForCommand(
    state: SimState,
    commandIndex: number,
    type: BuildOrderCommand["type"],
    requestedAt: number,
    code: "INVALID_ASSIGNMENT" | "NO_UNIT_AVAILABLE" | "NO_RESOURCE" | "RESOURCE_FULL",
    message: string,
): void {
    const withLine = appendDslLineContext(message, state.commandSourceLines[commandIndex]);
    state.violations.push({ time: state.now, code, message: withLine });
    pushCommandFailedResult(state, commandIndex, type, requestedAt, withLine);
}

function pluralize(word: string, count: number): string {
    if (count === 1) return word;
    if (word.endsWith("s")) return word;
    return `${word}s`;
}

function describeSelector(selector: string): string {
    if (selector.startsWith("res:")) return selector.slice("res:".length);
    if (selector.startsWith("proto:")) return selector.slice("proto:".length);
    if (selector.startsWith("tag:")) return selector.slice("tag:".length);
    if (selector.startsWith("actor:")) return selector.slice("actor:".length);
    if (selector.startsWith("id:")) return selector.slice("id:".length);
    return selector;
}

function describeSelectorList(selectors?: string[]): string | undefined {
    if (!selectors || selectors.length === 0) return undefined;
    return selectors.map(describeSelector).join(" / ");
}

function describeNodeTargets(resourceNodeIds?: string[], resourceNodeSelectors?: string[]): string | undefined {
    const selectorText = describeSelectorList(resourceNodeSelectors);
    if (selectorText) return selectorText;
    if (resourceNodeIds && resourceNodeIds.length > 0) return resourceNodeIds.join(" / ");
    return undefined;
}

function describeQueueWho(rule: Pick<QueueRule, "actorSelectors" | "actorResourceNodeSelectors">): string {
    const actorText = describeSelectorList(rule.actorSelectors);
    const fromText = describeSelectorList(rule.actorResourceNodeSelectors);
    if (actorText && fromText) return ` for ${actorText} from ${fromText}`;
    if (actorText) return ` for ${actorText}`;
    if (fromText) return ` for actors from ${fromText}`;
    return "";
}

function describeResourceShortfallNow(
    state: SimState,
    game: GameData,
    options: SimOptions,
    action: GameData["actions"][string],
): string | undefined {
    const costs = effectiveCosts(action, state.activeModifiers);
    const entries = Object.entries(costs);
    if (entries.length === 0) return undefined;

    const resourceFloorOverrides = baseResourceFloorOverrides(game);
    const shortfalls = entries
        .map(([resource, cost]) => {
            const floor = resourceFloorOverrides?.[resource] ?? options.debtFloor;
            const availableAboveFloor = (state.resources[resource] ?? 0) - floor;
            const missing = cost - availableAboveFloor;
            return missing > EPS ? `missing ${missing.toFixed(0)} ${resource}` : undefined;
        })
        .filter((x): x is string => Boolean(x));
    if (shortfalls.length === 0) return undefined;
    return shortfalls.join(", ");
}

export type GatherAssignFailure = {
    ok: false;
    reason: "NO_TARGET_NODES" | "MISSING_ACTORS" | "NO_GATHER_SLOT";
    message: string;
};

export function classifyGatherAssignFailure(
    failure: GatherAssignFailure,
    resourceNodeIds?: string[],
    resourceNodeSelectors?: string[],
): { code: "NO_RESOURCE" | "RESOURCE_FULL" | "INVALID_ASSIGNMENT"; message: string } {
    if (failure.reason === "NO_TARGET_NODES") {
        const targets = describeNodeTargets(resourceNodeIds, resourceNodeSelectors);
        return {
            code: "NO_RESOURCE",
            message: targets
                ? `Could not find any '${targets}' to gather from.`
                : "Could not find any resource nodes to gather from.",
        };
    }
    if (failure.reason === "NO_GATHER_SLOT") {
        const targets = describeNodeTargets(resourceNodeIds, resourceNodeSelectors);
        return {
            code: "RESOURCE_FULL",
            message: targets
                ? `All '${targets}' gathering spots are full right now.`
                : "All matching gathering spots are full right now.",
        };
    }
    return { code: "INVALID_ASSIGNMENT", message: failure.message };
}

function describeAssignGatherAttempt(
    cmd: Extract<BuildOrderCommand, { type: "assignGather" }>,
    requestedCount: number,
): string {
    const actorCountText = `${requestedCount} ${pluralize(cmd.actorType, requestedCount)}`;
    const fromSelectors = describeSelectorList(cmd.actorResourceNodeSelectors);
    const toSelectors = describeSelectorList(cmd.resourceNodeSelectors);
    const fromText = fromSelectors ? ` from ${fromSelectors}` : "";
    const toText = toSelectors ? toSelectors : "the requested targets";
    return `Tried to assign ${actorCountText}${fromText} to ${toText}`;
}

function computeBlockedNextAttempt(
    state: SimState,
    game: GameData,
    options: SimOptions,
    rule: Pick<
        QueueRule | AutoQueueRule,
        "actionId" | "actorSelectors" | "actorResourceNodeIds" | "actorResourceNodeSelectors"
    >,
    reason: "NO_ACTORS" | "INSUFFICIENT_RESOURCES" | "POP_CAP" | "NO_RESOURCE_NODES",
    extraResourceFloorOverrides?: Record<string, number>,
): number {
    const action = game.actions[rule.actionId];
    if (!action) return Number.POSITIVE_INFINITY;

    if (reason === "NO_ACTORS") {
        const nextEventTime =
            state.events.filter((e) => e.time > state.now + EPS).sort((a, b) => a.time - b.time)[0]?.time ?? Infinity;
        const availabilityRequest: Parameters<typeof nextEligibleActorAvailabilityTime>[1] = {
            actorTypes: action.actorTypes,
            actorCount: action.actorCount ?? 1,
        };
        if (rule.actorSelectors !== undefined) availabilityRequest.actorSelectors = rule.actorSelectors;
        if (rule.actorResourceNodeIds !== undefined)
            availabilityRequest.actorResourceNodeIds = rule.actorResourceNodeIds;
        if (rule.actorResourceNodeSelectors !== undefined) {
            availabilityRequest.actorResourceNodeSelectors = rule.actorResourceNodeSelectors;
        }
        const nextActorAt = nextEligibleActorAvailabilityTime(state, availabilityRequest);
        return Math.min(nextEventTime, toFutureTick(nextActorAt));
    }

    if (reason === "POP_CAP") {
        const nextEventTime =
            state.events.filter((e) => e.time > state.now + EPS).sort((a, b) => a.time - b.time)[0]?.time ?? Infinity;
        return Number.isFinite(nextEventTime) ? toFutureTick(nextEventTime) : Number.POSITIVE_INFINITY;
    }

    if (reason === "NO_RESOURCE_NODES") {
        const nextEventTime =
            state.events.filter((e) => e.time > state.now + EPS).sort((a, b) => a.time - b.time)[0]?.time ?? Infinity;
        return Number.isFinite(nextEventTime) ? toFutureTick(nextEventTime) : Number.POSITIVE_INFINITY;
    }

    const econ = computeEconomySnapshot(state);
    const resourceFloorOverrides = mergeFloorOverrides(baseResourceFloorOverrides(game), extraResourceFloorOverrides);
    const dtToAfford = timeToAffordWithCurrentRates(
        state.resources,
        effectiveCosts(action, state.activeModifiers),
        econ.resourceRates,
        options.debtFloor,
        resourceFloorOverrides,
    );
    return Number.isFinite(dtToAfford) ? toFutureTick(state.now + Math.max(dtToAfford, 0)) : Number.POSITIVE_INFINITY;
}

function sampleHumanDelaySeconds(state: SimState, actionId: string): number {
    const buckets = state.humanDelays[actionId];
    if (!buckets || buckets.length === 0) return 0;

    const pickRoll = Math.random();
    let cumulative = 0;
    for (const bucket of buckets) {
        cumulative += bucket.chance;
        if (pickRoll > cumulative + EPS) continue;
        if (bucket.maxSeconds <= bucket.minSeconds + EPS) return Math.max(0, bucket.minSeconds);
        const span = bucket.maxSeconds - bucket.minSeconds;
        return Math.max(0, bucket.minSeconds + Math.random() * span);
    }
    return 0;
}

export function registerQueueAction(
    state: SimState,
    cmd: Extract<BuildOrderCommand, { type: "queueAction" }>,
    commandIndex: number,
    options?: { warnOnLongDelay?: boolean },
): void {
    const requestedAt = state.now;
    const iterations = Math.max(1, cmd.count ?? 1);
    const rule: QueueRule = {
        commandIndex,
        requestedAt,
        actionId: cmd.actionId,
        warnOnLongDelay: options?.warnOnLongDelay ?? true,
        totalIterations: iterations,
        completedIterations: 0,
        nextAttemptAt: state.now,
    };
    if (cmd.actorSelectors !== undefined) rule.actorSelectors = [...cmd.actorSelectors];
    if (cmd.actorResourceNodeIds !== undefined) rule.actorResourceNodeIds = [...cmd.actorResourceNodeIds];
    if (cmd.actorResourceNodeSelectors !== undefined)
        rule.actorResourceNodeSelectors = [...cmd.actorResourceNodeSelectors];
    state.queueRules.push(rule);
}

export function processQueueRules(
    state: SimState,
    game: GameData,
    options: SimOptions,
    onActionClicked?: (actionId: string, actors: string[], startedAt: number) => void,
): void {
    let changed = false;
    let guard = 0;

    do {
        guard += 1;
        if (guard > 1_000_000) {
            throw new Error(`processQueueRules loop guard tripped (now=${state.now}).`);
        }
        changed = false;

        for (const rule of [...state.queueRules]) {
            if (state.now + EPS < rule.nextAttemptAt) continue;

            const queueCmd: Pick<
                Extract<BuildOrderCommand, { type: "queueAction" }>,
                "actionId" | "actorSelectors" | "actorResourceNodeIds" | "actorResourceNodeSelectors"
            > = {
                actionId: rule.actionId,
            };
            if (rule.actorSelectors !== undefined) queueCmd.actorSelectors = rule.actorSelectors;
            if (rule.actorResourceNodeIds !== undefined) queueCmd.actorResourceNodeIds = rule.actorResourceNodeIds;
            if (rule.actorResourceNodeSelectors !== undefined)
                queueCmd.actorResourceNodeSelectors = rule.actorResourceNodeSelectors;

            const result = tryScheduleActionNow(
                state,
                game,
                options,
                queueCmd,
                undefined,
                state.commandSourceLines[rule.commandIndex],
            );
            if (shouldDebugAction(rule.actionId)) {
                simDebug(
                    "processQueueRules.attempt",
                    `action=${rule.actionId}`,
                    `now=${state.now}`,
                    `nextAttemptAt=${rule.nextAttemptAt}`,
                    `result=${result.status}${result.status === "blocked" ? `:${result.reason}` : ""}`,
                );
            }

            if (result.status === "scheduled") {
                const delayedBy = state.now - rule.requestedAt;
                if (
                    rule.warnOnLongDelay !== false &&
                    rule.completedIterations === 0 &&
                    delayedBy > DELAYED_ACTION_WARNING_SECONDS + EPS
                ) {
                    const firstBlockedContext = rule.firstBlockedMessage ? ` ${rule.firstBlockedMessage}` : "";
                    const message = appendDslLineContext(
                        `'${rule.actionId}' fired at ${formatMMSS(state.now)} after waiting ${formatMMSS(delayedBy)}.${firstBlockedContext}`,
                        state.commandSourceLines[rule.commandIndex],
                    );
                    state.violations.push({ time: state.now, code: "DELAYED_ACTION", message });
                }
                state.commandResults.push(commandScheduledResult(rule, state.now));
                onActionClicked?.(result.actionId, result.actors, result.startedAt);
                rule.completedIterations += 1;
                delete rule.lastBlockedReason;
                delete rule.firstBlockedMessage;
                changed = true;
                if (rule.completedIterations >= rule.totalIterations) {
                    state.queueRules = state.queueRules.filter((r) => r !== rule);
                } else {
                    rule.delayUntil = toFutureTick(
                        result.completionTime + sampleHumanDelaySeconds(state, rule.actionId),
                    );
                    rule.nextAttemptAt = rule.delayUntil;
                    // Reset requestedAt so delayedBy for the next iteration only
                    // measures genuine blocking time (resource/actor shortage), not
                    // natural sequential wait from the previous iteration.
                    rule.requestedAt = rule.delayUntil;
                    delete rule.firstBlockedMessage;
                }
                continue;
            }

            if (result.status === "invalid") {
                const message = appendDslLineContext(result.message, state.commandSourceLines[rule.commandIndex]);
                state.commandResults.push(commandFailureResult(rule, message));
                state.violations.push({ time: state.now, code: "ACTION_NOT_FOUND", message });
                state.queueRules = state.queueRules.filter((r) => r !== rule);
                continue;
            }

            rule.lastBlockedReason = result.reason;
            if (options.strict && (result.reason === "INSUFFICIENT_RESOURCES" || result.reason === "POP_CAP")) {
                state.violations.push({
                    time: state.now,
                    code: result.reason === "POP_CAP" ? "HOUSED" : "INSUFFICIENT_RESOURCES",
                    message: appendDslLineContext(
                        result.reason === "POP_CAP"
                            ? `Population is full, so '${rule.actionId}' could not start at ${state.now.toFixed(2)}s${describeQueueWho(rule)}.`
                            : `Could not queue '${rule.actionId}' at ${state.now.toFixed(2)}s due to insufficient resources.`,
                        state.commandSourceLines[rule.commandIndex],
                    ),
                });
                const iter = rule.completedIterations + 1;
                state.commandResults.push(
                    commandFailureResult(rule, `Could not schedule iteration ${iter}/${rule.totalIterations}.`),
                );
                state.queueRules = state.queueRules.filter((r) => r !== rule);
                continue;
            }
            if (!options.strict && !rule.firstBlockedMessage) {
                const firstBlockedAt = formatMMSS(state.now);
                if (result.reason === "NO_ACTORS") {
                    rule.firstBlockedMessage = `First blocked at ${firstBlockedAt} due to no available actors${describeQueueWho(rule)}.`;
                } else if (result.reason === "POP_CAP") {
                    rule.firstBlockedMessage =
                        `First blocked at ${firstBlockedAt} because population was full${describeQueueWho(rule)}.`;
                } else if (result.reason === "NO_RESOURCE_NODES") {
                    rule.firstBlockedMessage =
                        `First blocked at ${firstBlockedAt} due to missing required map resource nodes.`;
                } else {
                    const action = game.actions[rule.actionId];
                    const gap =
                        action !== undefined
                            ? describeResourceShortfallNow(state, game, options, action)
                            : undefined;
                    rule.firstBlockedMessage = gap
                        ? `First blocked at ${firstBlockedAt} due to insufficient resources: ${gap}.`
                        : `First blocked at ${firstBlockedAt} due to insufficient resources.`;
                }
            }

            const nextAttemptAt = computeBlockedNextAttempt(state, game, options, rule, result.reason);
            rule.nextAttemptAt = nextAttemptAt;
            if (shouldDebugAction(rule.actionId)) {
                simDebug(
                    "processQueueRules.blocked",
                    `action=${rule.actionId}`,
                    `reason=${result.reason}`,
                    `now=${state.now}`,
                    `nextAttemptAt=${nextAttemptAt}`,
                );
            }
        }
    } while (changed);
}

function describeResourceShortfallAtEvaluation(
    state: SimState,
    game: GameData,
    options: SimOptions,
    action: GameData["actions"][string],
): string | undefined {
    const costs = effectiveCosts(action, state.activeModifiers);
    const entries = Object.entries(costs);
    if (entries.length === 0) return undefined;

    const resourceFloorOverrides = baseResourceFloorOverrides(game);
    const shortfalls = entries
        .map(([resource, cost]) => {
            const floor = resourceFloorOverrides?.[resource] ?? options.debtFloor;
            const availableAboveFloor = (state.resources[resource] ?? 0) - floor;
            const missing = cost - availableAboveFloor;
            return missing > EPS ? `missing ${missing.toFixed(0)} ${resource}` : undefined;
        })
        .filter((x): x is string => Boolean(x));
    if (shortfalls.length === 0) return undefined;
    return `Resource gap at sim end: ${shortfalls.join(", ")}.`;
}

function describeActorAvailabilityAtEvaluation(
    state: SimState,
    action: GameData["actions"][string],
    rule: Pick<QueueRule, "actorSelectors" | "actorResourceNodeIds" | "actorResourceNodeSelectors">,
    evaluationTime: number,
): string | undefined {
    const availabilityRequest: Parameters<typeof nextEligibleActorAvailabilityTime>[1] = {
        actorTypes: action.actorTypes,
        actorCount: action.actorCount ?? 1,
    };
    if (rule.actorSelectors !== undefined) availabilityRequest.actorSelectors = rule.actorSelectors;
    if (rule.actorResourceNodeIds !== undefined) availabilityRequest.actorResourceNodeIds = rule.actorResourceNodeIds;
    if (rule.actorResourceNodeSelectors !== undefined) {
        availabilityRequest.actorResourceNodeSelectors = rule.actorResourceNodeSelectors;
    }
    const nextActorAt = nextEligibleActorAvailabilityTime(state, availabilityRequest);
    if (!Number.isFinite(nextActorAt)) return undefined;
    const actorTypes = action.actorTypes.length > 0 ? action.actorTypes.join(", ") : "none";
    if (nextActorAt > evaluationTime + EPS) {
        return `Required actors (${actorTypes}) next available at ${nextActorAt.toFixed(0)}s.`;
    }
    return `Requires actors of type: ${actorTypes}.`;
}

export function finalizeQueueRulesAtEvaluation(
    state: SimState,
    game: GameData,
    options: SimOptions,
    evaluationTime: number,
): void {
    for (const rule of state.queueRules) {
        const action = game.actions[rule.actionId];
        const reason = rule.lastBlockedReason ?? "INSUFFICIENT_RESOURCES";
        const remainingIterations = Math.max(1, rule.totalIterations - rule.completedIterations);
        const code = reason === "NO_ACTORS" ? "NO_ACTORS" : reason === "POP_CAP" ? "HOUSED" : "RESOURCE_STALL";
        const firstBlockedContext = rule.firstBlockedMessage ? ` ${rule.firstBlockedMessage}` : "";
        const contextParts: string[] = [];
        if (action) {
            if (reason === "NO_ACTORS") {
                const actorHint = describeActorAvailabilityAtEvaluation(state, action, rule, evaluationTime);
                if (actorHint) contextParts.push(actorHint);
            }
            if (reason === "INSUFFICIENT_RESOURCES") {
                const resourceHint = describeResourceShortfallAtEvaluation(state, game, options, action);
                if (resourceHint) contextParts.push(resourceHint);
            }
            if (reason === "NO_RESOURCE_NODES") {
                contextParts.push("Required map resource nodes were unavailable.");
            }
        }
        const context = contextParts.length > 0 ? ` ${contextParts.join(" ")}` : "";
        const message = appendDslLineContext(
            reason === "NO_ACTORS"
                ? `${remainingIterations} more '${rule.actionId}' action could not be scheduled before sim ended at ${formatMMSS(evaluationTime)} due to no available actors.${firstBlockedContext}${context}`
                : reason === "POP_CAP"
                  ? `Population was full, so ${remainingIterations} '${rule.actionId}' action could not be scheduled before sim ended at ${formatMMSS(evaluationTime)}${describeQueueWho(rule)}.${firstBlockedContext}${context}`
                  : `${remainingIterations} more '${rule.actionId}' action could not be scheduled before sim ended at ${formatMMSS(evaluationTime)}.${firstBlockedContext}${context}`,
            state.commandSourceLines[rule.commandIndex],
        );
        state.violations.push({ time: state.now, code, message });

        const iter = rule.completedIterations + 1;
        state.commandResults.push(
            commandFailureResult(rule, `Could not schedule iteration ${iter}/${rule.totalIterations}.`),
        );
    }
    state.queueRules = [];
}

export function registerAutoQueue(
    state: SimState,
    cmd: Extract<BuildOrderCommand, { type: "autoQueue" }>,
    commandIndex: number,
): void {
    const requestedAt = state.now;
    const rule: AutoQueueRule = {
        actionId: cmd.actionId,
        nextAttemptAt: state.now,
    };
    if (cmd.actorType !== undefined) rule.actorSelectors = [cmd.actorType];
    if (cmd.actorIds !== undefined) rule.actorSelectors = [...cmd.actorIds];
    if (cmd.actorResourceNodeIds !== undefined) rule.actorResourceNodeIds = [...cmd.actorResourceNodeIds];
    if (cmd.actorResourceNodeSelectors !== undefined)
        rule.actorResourceNodeSelectors = [...cmd.actorResourceNodeSelectors];
    const existingIdx = state.autoQueueRules.findIndex(
        (r) =>
            r.actionId === rule.actionId &&
            JSON.stringify(r.actorSelectors ?? []) === JSON.stringify(rule.actorSelectors ?? []) &&
            JSON.stringify(r.actorResourceNodeIds ?? []) === JSON.stringify(rule.actorResourceNodeIds ?? []) &&
            JSON.stringify(r.actorResourceNodeSelectors ?? []) ===
                JSON.stringify(rule.actorResourceNodeSelectors ?? []),
    );
    if (existingIdx >= 0) {
        state.autoQueueRules[existingIdx] = rule;
    } else {
        state.autoQueueRules.push(rule);
    }
    pushCommandScheduledResult(state, commandIndex, cmd.type, requestedAt);
}

export function stopAutoQueue(
    state: SimState,
    cmd: Extract<BuildOrderCommand, { type: "stopAutoQueue" }>,
    commandIndex: number,
): void {
    const requestedAt = state.now;
    state.autoQueueRules = state.autoQueueRules.filter((rule) => {
        if (rule.actionId !== cmd.actionId) return true;
        if (
            cmd.actorType !== undefined &&
            JSON.stringify(rule.actorSelectors ?? []) !== JSON.stringify([cmd.actorType])
        )
            return true;
        if (
            cmd.actorResourceNodeIds !== undefined &&
            JSON.stringify(rule.actorResourceNodeIds ?? []) !== JSON.stringify(cmd.actorResourceNodeIds)
        )
            return true;
        if (
            cmd.actorResourceNodeSelectors !== undefined &&
            JSON.stringify(rule.actorResourceNodeSelectors ?? []) !== JSON.stringify(cmd.actorResourceNodeSelectors)
        )
            return true;
        return false;
    });
    pushCommandScheduledResult(state, commandIndex, cmd.type, requestedAt);
}

export function processAutoQueue(
    state: SimState,
    game: GameData,
    options: SimOptions,
    blockedActorTypes?: string[],
    onActionClicked?: (actionId: string, actors: string[], startedAt: number) => void,
): void {
    let changed = false;
    let guard = 0;
    const applyDelayFloor = (rule: AutoQueueRule, nextAttemptAt: number): number => {
        if (rule.delayUntil === undefined) return nextAttemptAt;
        return Math.max(nextAttemptAt, rule.delayUntil);
    };

    do {
        guard += 1;
        if (guard > 1_000_000) {
            throw new Error(`processAutoQueue loop guard tripped (now=${state.now}).`);
        }
        changed = false;
        const reservedFloors = queueResourceReservations(state, game, options);
        for (const rule of [...state.autoQueueRules]) {
            if (state.now + EPS < rule.nextAttemptAt) continue;
            const ruleAction = game.actions[rule.actionId];
            if (!ruleAction) {
                rule.nextAttemptAt = Number.POSITIVE_INFINITY;
                continue;
            }
            if (
                blockedActorTypes &&
                blockedActorTypes.length > 0 &&
                ruleAction.actorTypes.some((t) => blockedActorTypes.includes(t))
            ) {
                if (shouldDebugAction(rule.actionId)) {
                    simDebug(
                        "processAutoQueue.skip",
                        `action=${rule.actionId}`,
                        "reason=BLOCKED_ACTOR_TYPE",
                        `now=${state.now}`,
                    );
                }
                continue;
            }

            const queueCmd: Pick<
                Extract<BuildOrderCommand, { type: "queueAction" }>,
                "actionId" | "actorSelectors" | "actorResourceNodeIds" | "actorResourceNodeSelectors"
            > = {
                actionId: rule.actionId,
            };
            if (rule.actorSelectors !== undefined) queueCmd.actorSelectors = rule.actorSelectors;
            if (rule.actorResourceNodeIds !== undefined) queueCmd.actorResourceNodeIds = rule.actorResourceNodeIds;
            if (rule.actorResourceNodeSelectors !== undefined)
                queueCmd.actorResourceNodeSelectors = rule.actorResourceNodeSelectors;
            const result = tryScheduleActionNow(state, game, options, queueCmd, reservedFloors);
            if (shouldDebugAction(rule.actionId)) {
                simDebug(
                    "processAutoQueue.attempt",
                    `action=${rule.actionId}`,
                    `now=${state.now}`,
                    `nextAttemptAt=${rule.nextAttemptAt}`,
                    `result=${result.status}${result.status === "blocked" ? `:${result.reason}` : ""}`,
                );
            }

            if (result.status === "scheduled") {
                onActionClicked?.(result.actionId, result.actors, result.startedAt);
                // Auto-queue may fire multiple times in the same tick as long as
                // there are still eligible actors/resources after each click.
                delete rule.lastBlockedReason;
                rule.delayUntil = toFutureTick(result.completionTime + sampleHumanDelaySeconds(state, rule.actionId));
                rule.nextAttemptAt = state.now;
                changed = true;
                if (shouldDebugAction(rule.actionId)) {
                    simDebug(
                        "processAutoQueue.scheduled",
                        `action=${rule.actionId}`,
                        `now=${state.now}`,
                        `nextAttemptAt=${rule.nextAttemptAt}`,
                    );
                }
                continue;
            }

            if (result.status === "invalid") {
                state.violations.push({ time: state.now, code: "ACTION_NOT_FOUND", message: result.message });
                state.autoQueueRules = state.autoQueueRules.filter((r) => r !== rule);
                continue;
            }

            if (result.reason === "NO_ACTORS") {
                rule.lastBlockedReason = "NO_ACTORS";
                rule.nextAttemptAt = applyDelayFloor(
                    rule,
                    computeBlockedNextAttempt(state, game, options, rule, result.reason),
                );
                if (shouldDebugAction(rule.actionId)) {
                    simDebug(
                        "processAutoQueue.blocked",
                        `action=${rule.actionId}`,
                        "reason=NO_ACTORS",
                        `now=${state.now}`,
                        `nextAttemptAt=${rule.nextAttemptAt}`,
                    );
                }
                continue;
            }

            if (result.reason === "POP_CAP") {
                if (rule.lastBlockedReason !== "POP_CAP") {
                    state.violations.push({
                        time: state.now,
                        code: "HOUSED",
                        message: `Population is full, so auto-queue '${rule.actionId}' is waiting. Build houses before this step.`,
                    });
                }
                rule.lastBlockedReason = "POP_CAP";
                rule.nextAttemptAt = applyDelayFloor(
                    rule,
                    computeBlockedNextAttempt(state, game, options, rule, result.reason),
                );
                if (shouldDebugAction(rule.actionId)) {
                    simDebug(
                        "processAutoQueue.blocked",
                        `action=${rule.actionId}`,
                        "reason=POP_CAP",
                        `now=${state.now}`,
                        `nextAttemptAt=${rule.nextAttemptAt}`,
                    );
                }
                continue;
            }
            rule.lastBlockedReason = result.reason;
            rule.nextAttemptAt = applyDelayFloor(
                rule,
                computeBlockedNextAttempt(state, game, options, rule, result.reason, reservedFloors),
            );
            if (shouldDebugAction(rule.actionId)) {
                simDebug(
                    "processAutoQueue.blocked",
                    `action=${rule.actionId}`,
                    "reason=INSUFFICIENT_RESOURCES",
                    `now=${state.now}`,
                    `nextAttemptAt=${rule.nextAttemptAt}`,
                );
            }
        }
    } while (changed);
}

export function setSpawnGatherRule(
    state: SimState,
    cmd: Extract<BuildOrderCommand, { type: "setSpawnGather" }>,
    commandIndex: number,
): void {
    const requestedAt = state.now;
    const rule: { resourceNodeIds?: string[]; resourceNodeSelectors?: string[] } = {};
    if (cmd.resourceNodeIds !== undefined) rule.resourceNodeIds = cmd.resourceNodeIds;
    if (cmd.resourceNodeSelectors !== undefined) rule.resourceNodeSelectors = cmd.resourceNodeSelectors;
    state.spawnGatherRules[cmd.entityType] = rule;
    pushCommandScheduledResult(state, commandIndex, cmd.type, requestedAt);
}

export function assignGather(
    state: SimState,
    cmd: Extract<BuildOrderCommand, { type: "assignGather" }>,
    commandIndex: number,
    options?: { allowEmptySelectorMatch?: boolean },
): void {
    const requestedAt = state.now;
    let requestedCount: number;
    if (cmd.all) {
        const allRequest: Parameters<typeof pickEligibleActorIds>[1] = {
            actorTypes: [cmd.actorType],
            actorCount: state.entities.length,
            idleOnly: false,
        };
        if (cmd.actorResourceNodeIds !== undefined) allRequest.actorResourceNodeIds = cmd.actorResourceNodeIds;
        if (cmd.actorResourceNodeSelectors !== undefined) {
            allRequest.actorResourceNodeSelectors = cmd.actorResourceNodeSelectors;
        }
        requestedCount = pickEligibleActorIds(state, allRequest).length;
    } else {
        requestedCount = cmd.actorSelectors?.length ?? cmd.count ?? 0;
    }
    if (
        requestedCount === 0 &&
        !options?.allowEmptySelectorMatch &&
        (cmd.actorResourceNodeIds?.length ?? 0) + (cmd.actorResourceNodeSelectors?.length ?? 0) > 0
    ) {
        const requestedCountFromSelectors = cmd.count ?? 1;
        const attempt = describeAssignGatherAttempt(cmd, requestedCountFromSelectors);
        const msg = `${attempt}, but none were available.`;
        pushNoUnitAvailable(state, commandIndex, cmd.type, requestedAt, msg);
        return;
    }
    const assignRequest: Parameters<typeof pickEligibleActorIds>[1] = {
        actorTypes: [cmd.actorType],
        actorCount: requestedCount,
        idleOnly: false,
    };
    if (cmd.actorSelectors !== undefined) assignRequest.actorSelectors = cmd.actorSelectors;
    if (cmd.actorResourceNodeIds !== undefined) assignRequest.actorResourceNodeIds = cmd.actorResourceNodeIds;
    if (cmd.actorResourceNodeSelectors !== undefined)
        assignRequest.actorResourceNodeSelectors = cmd.actorResourceNodeSelectors;
    const actorIds = pickEligibleActorIds(state, assignRequest);
    if (actorIds.length < requestedCount) {
        const attempt = describeAssignGatherAttempt(cmd, requestedCount);
        const availableText =
            actorIds.length === 0
                ? "none were available"
                : `only ${actorIds.length} ${pluralize(cmd.actorType, actorIds.length)} were available`;
        const msg = `${attempt}, but ${availableText}.`;
        pushNoUnitAvailable(state, commandIndex, cmd.type, requestedAt, msg);
        return;
    }

    const assignResult = assignGatherByEntityIds(state, actorIds, cmd.resourceNodeIds, cmd.resourceNodeSelectors);
    if (!assignResult.ok) {
        const mapped = classifyGatherAssignFailure(assignResult, cmd.resourceNodeIds, cmd.resourceNodeSelectors);
        if (mapped.code === "NO_RESOURCE") {
            pushNoResource(state, commandIndex, cmd.type, requestedAt, mapped.message);
            return;
        }
        if (mapped.code === "RESOURCE_FULL") {
            pushResourceFull(state, commandIndex, cmd.type, requestedAt, mapped.message);
            return;
        }
        pushInvalidAssignment(state, commandIndex, cmd.type, requestedAt, mapped.message);
        return;
    }
    pushCommandScheduledResult(state, commandIndex, cmd.type, requestedAt);
}

export function assignGatherByEntityIds(
    state: SimState,
    actorIds: string[],
    resourceNodeIds?: string[],
    resourceNodeSelectors?: string[],
): { ok: true } | GatherAssignFailure {
    const targets = resolveNodeTargets(state, resourceNodeIds, resourceNodeSelectors);
    if (targets.length === 0) {
        return { ok: false, reason: "NO_TARGET_NODES", message: "No valid resource nodes for gather assignment." };
    }

    const picked = actorIds
        .map((id) => state.entities.find((e) => e.id === id))
        .filter((e): e is NonNullable<typeof e> => Boolean(e));
    if (picked.length < actorIds.length) {
        return {
            ok: false,
            reason: "MISSING_ACTORS",
            message: `assign requested specific IDs, found ${picked.length}/${actorIds.length}.`,
        };
    }

    const assignedCount: Record<string, number> = {};
    for (const e of state.entities) {
        if (e.resourceNodeId) assignedCount[e.resourceNodeId] = (assignedCount[e.resourceNodeId] ?? 0) + 1;
    }

    for (const ent of picked) {
        const currentNodeId = ent.resourceNodeId;
        if (currentNodeId) {
            const currentNode = state.resourceNodeById[currentNodeId];
            const currentIsTarget = currentNode && targets.some((target) => target.id === currentNode.id);
            const currentSupportsGather =
                currentNode &&
                (currentNode.rateByEntityType[ent.entityType] ?? 0) > 0 &&
                (currentNode.remainingStock === undefined || currentNode.remainingStock > EPS);
            if (currentIsTarget && currentSupportsGather) {
                activateDecayOnFirstGather(currentNode);
                if (ent.busyUntil <= state.now + EPS) {
                    switchEntityActivity(state, ent.id, "gather", `${currentNode.produces}:${currentNode.prototypeId}`);
                }
                continue;
            }
        }

        const node = pickGatherNode(ent.entityType, targets, assignedCount);
        if (!node) {
            return {
                ok: false,
                reason: "NO_GATHER_SLOT",
                message: "All matching gathering spots are full right now.",
            };
        }

        ent.resourceNodeId = node.id;
        activateDecayOnFirstGather(node);
        assignedCount[node.id] = (assignedCount[node.id] ?? 0) + 1;
        if (ent.busyUntil <= state.now + EPS) {
            switchEntityActivity(state, ent.id, "gather", `${node.produces}:${node.prototypeId}`);
        }
    }

    return { ok: true };
}
