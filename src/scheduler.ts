import { applyNumericModifiers } from "./modifiers";
import { BuildOrderCommand, CommandResult, GameData, ResourceNodeInstance, SimOptions } from "./types";
import {
    AutoQueueRule,
    EPS,
    QueueRule,
    SimState,
    compareEntityIdNatural,
    quantizeDuration,
    switchEntityActivity,
    toFutureTick,
} from "./sim_shared";
import { computeEconomySnapshot } from "./economy";
import { shouldDebugAction, simDebug } from "./debug";
import { matchesNodeSelector } from "./node_selectors";
import { nextEligibleActorAvailabilityTime, pickEligibleActorIds } from "./actor_eligibility";

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
):
    | { status: "scheduled"; completionTime: number; actionId: string; actors: string[]; startedAt: number }
    | { status: "blocked"; reason: "NO_ACTORS" | "INSUFFICIENT_RESOURCES" | "POP_CAP" }
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

    const costs = action.costs ?? {};
    const populationResource = game.population?.resource;
    const resourceFloorOverrides = populationResource
        ? { [populationResource]: game.population?.floor ?? 0 }
        : undefined;
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
      message: `Warning: '${action.id}' pushed ${crossedWithValues} (debt-floor=${options.debtFloor}).`,
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
    state.violations.push({ time: state.now, code: "INVALID_ASSIGNMENT", message });
    pushCommandFailedResult(state, commandIndex, type, requestedAt, message);
}

function computeBlockedNextAttempt(
    state: SimState,
    game: GameData,
    options: SimOptions,
    rule: Pick<
        QueueRule | AutoQueueRule,
        "actionId" | "actorSelectors" | "actorResourceNodeIds" | "actorResourceNodeSelectors"
    >,
    reason: "NO_ACTORS" | "INSUFFICIENT_RESOURCES" | "POP_CAP",
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

    const econ = computeEconomySnapshot(state);
    const populationResource = game.population?.resource;
    const resourceFloorOverrides = populationResource
        ? { [populationResource]: game.population?.floor ?? 0 }
        : undefined;
    const dtToAfford = timeToAffordWithCurrentRates(
        state.resources,
        action.costs ?? {},
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
): void {
    const requestedAt = cmd.at ?? state.now;
    const iterations = Math.max(1, cmd.count ?? 1);
    const rule: QueueRule = {
        commandIndex,
        requestedAt,
        actionId: cmd.actionId,
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

            const result = tryScheduleActionNow(state, game, options, queueCmd);
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
                state.commandResults.push(commandScheduledResult(rule, state.now));
                onActionClicked?.(result.actionId, result.actors, result.startedAt);
                rule.completedIterations += 1;
                delete rule.lastBlockedReason;
                changed = true;
                if (rule.completedIterations >= rule.totalIterations) {
                    state.queueRules = state.queueRules.filter((r) => r !== rule);
                } else {
                    rule.delayUntil = toFutureTick(
                        result.completionTime + sampleHumanDelaySeconds(state, rule.actionId),
                    );
                    rule.nextAttemptAt = rule.delayUntil;
                }
                continue;
            }

            if (result.status === "invalid") {
                state.commandResults.push(commandFailureResult(rule, result.message));
                state.violations.push({ time: state.now, code: "ACTION_NOT_FOUND", message: result.message });
                state.queueRules = state.queueRules.filter((r) => r !== rule);
                continue;
            }

            rule.lastBlockedReason = result.reason;
            if (options.strict && (result.reason === "INSUFFICIENT_RESOURCES" || result.reason === "POP_CAP")) {
                state.violations.push({
                    time: state.now,
                    code: result.reason === "POP_CAP" ? "HOUSED" : "INSUFFICIENT_RESOURCES",
                    message:
                        result.reason === "POP_CAP"
                            ? `population capacity blocks '${rule.actionId}' at ${state.now.toFixed(2)}s.`
                            : `Insufficient resources for '${rule.actionId}' at ${state.now.toFixed(2)}s.`,
                });
                const iter = rule.completedIterations + 1;
                state.commandResults.push(
                    commandFailureResult(rule, `Could not schedule iteration ${iter}/${rule.totalIterations}.`),
                );
                state.queueRules = state.queueRules.filter((r) => r !== rule);
                continue;
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

export function finalizeQueueRulesAtEvaluation(state: SimState, evaluationTime: number): void {
    for (const rule of state.queueRules) {
        const reason = rule.lastBlockedReason ?? "INSUFFICIENT_RESOURCES";
        const code = reason === "NO_ACTORS" ? "NO_ACTORS" : reason === "POP_CAP" ? "HOUSED" : "RESOURCE_STALL";
        const message =
            reason === "NO_ACTORS"
                ? `No available actors to perform '${rule.actionId}'.`
                : reason === "POP_CAP"
                  ? `Could not schedule '${rule.actionId}' before evaluation time (${evaluationTime.toFixed(2)}s): population capacity.`
                  : `Could not schedule '${rule.actionId}' before evaluation time (${evaluationTime.toFixed(2)}s).`;
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
    const requestedAt = cmd.at ?? state.now;
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
    const requestedAt = cmd.at ?? state.now;
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

    do {
        guard += 1;
        if (guard > 1_000_000) {
            throw new Error(`processAutoQueue loop guard tripped (now=${state.now}).`);
        }
        changed = false;
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
            const result = tryScheduleActionNow(state, game, options, queueCmd);
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
                rule.delayUntil = toFutureTick(result.completionTime + sampleHumanDelaySeconds(state, rule.actionId));
                rule.nextAttemptAt = rule.delayUntil;
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
                rule.nextAttemptAt = computeBlockedNextAttempt(state, game, options, rule, result.reason);
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
                rule.nextAttemptAt = computeBlockedNextAttempt(state, game, options, rule, result.reason);
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
            rule.nextAttemptAt = computeBlockedNextAttempt(state, game, options, rule, result.reason);
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
    const requestedAt = cmd.at ?? state.now;
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
): void {
    const requestedAt = cmd.at ?? state.now;
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
        const msg = cmd.actorSelectors
            ? `assignGather requested specific ${cmd.actorType} selectors, found ${actorIds.length}/${requestedCount}.`
            : `assignGather requested ${requestedCount} '${cmd.actorType}', found ${actorIds.length}.`;
        pushInvalidAssignment(state, commandIndex, cmd.type, requestedAt, msg);
        return;
    }

    const assignResult = assignGatherByEntityIds(state, actorIds, cmd.resourceNodeIds, cmd.resourceNodeSelectors);
    if (!assignResult.ok) {
        pushInvalidAssignment(state, commandIndex, cmd.type, requestedAt, assignResult.message);
        return;
    }
    pushCommandScheduledResult(state, commandIndex, cmd.type, requestedAt);
}

export function assignGatherByEntityIds(
    state: SimState,
    actorIds: string[],
    resourceNodeIds?: string[],
    resourceNodeSelectors?: string[],
): { ok: true } | { ok: false; message: string } {
    const targets = resolveNodeTargets(state, resourceNodeIds, resourceNodeSelectors);
    if (targets.length === 0) {
        return { ok: false, message: "No valid resource nodes for gather assignment." };
    }

    const picked = actorIds
        .map((id) => state.entities.find((e) => e.id === id))
        .filter((e): e is NonNullable<typeof e> => Boolean(e));
    if (picked.length < actorIds.length) {
        return { ok: false, message: `assign requested specific IDs, found ${picked.length}/${actorIds.length}.` };
    }

    const assignedCount: Record<string, number> = {};
    for (const e of state.entities) {
        if (e.resourceNodeId) assignedCount[e.resourceNodeId] = (assignedCount[e.resourceNodeId] ?? 0) + 1;
    }

    for (const ent of picked) {
        const node = pickGatherNode(ent.entityType, targets, assignedCount);
        if (!node) {
            return { ok: false, message: `No gather slot available for '${ent.id}' on requested resource nodes.` };
        }

        ent.resourceNodeId = node.id;
        assignedCount[node.id] = (assignedCount[node.id] ?? 0) + 1;
        if (ent.busyUntil <= state.now + EPS) {
            switchEntityActivity(state, ent.id, "gather", `${node.produces}:${node.prototypeId}`);
        }
    }

    return { ok: true };
}
