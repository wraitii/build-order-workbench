import {
    addResources,
    cloneResources,
    countEntitiesByType,
    findNextEventTime,
    normalizeCommandTimes,
    recordEntityCountPoint,
    SimState,
    switchEntityActivity,
    EPS,
    toFutureTick,
    toTick,
    TIME_STEP_SECONDS,
} from "./sim_shared";
import {
    BuildOrderInput,
    BuildOrderCommand,
    GameData,
    ResourceMap,
    ResourceTimelineInterval,
    SimOptions,
    SimulationResult,
    ScoreCriterion,
    ScoreResult,
} from "./types";
import { matchesNodeSelector } from "./node_selectors";
import {
    NodeDepletionEvent,
    applyStockModifierToExistingNodes,
    advanceTime,
    computeEconomySnapshot,
    instantiateResourceNode,
} from "./economy";
import {
    assignEntityToGatherTargets,
    assignGather,
    assignGatherByEntityIds,
    finalizeQueueRulesAtEvaluation,
    processAutoQueue,
    processQueueRules,
    registerAutoQueue,
    registerQueueAction,
    setSpawnGatherRule,
    stopAutoQueue,
} from "./scheduler";
import { EventQueue } from "./event_queue";
import { TriggerEvent, TriggerEventContext, processBoundaryPhases, processTriggers } from "./sim_phases";
import { isSimDebugEnabled, simDebug } from "./debug";
import { nextEligibleActorAvailabilityTime, pickEligibleActorIds } from "./actor_eligibility";
import { applyNumericModifiers } from "./modifiers";

function populationCapacityProvidedForEntityType(game: GameData, entityType: string, count: number): number {
    const population = game.population;
    if (!population) return 0;
    return (population.providedByEntityType[entityType] ?? 0) * count;
}

function populationConsumedByEntityType(game: GameData, entityType: string, count: number): number {
    const population = game.population;
    if (!population) return 0;
    return (population.consumedByEntityType[entityType] ?? 0) * count;
}

function availablePopulationFromEntities(game: GameData, entitiesByType: Record<string, number>): number {
    let available = 0;
    for (const [entityType, count] of Object.entries(entitiesByType)) {
        available += populationCapacityProvidedForEntityType(game, entityType, count);
        available -= populationConsumedByEntityType(game, entityType, count);
    }
    return available;
}

function nextEntityId(state: SimState, entityType: string): string {
    const next = (state.entityTypeCounters[entityType] ?? 0) + 1;
    state.entityTypeCounters[entityType] = next;
    return `${entityType}-${next}`;
}

function effectiveMarketFee(state: SimState, resource: string, baseFee: number): number {
    const fee = applyNumericModifiers(
        baseFee,
        ["market.fee", `market.fee.resource.${resource}`],
        state.activeModifiers,
    );
    return Math.min(0.99, Math.max(0, fee));
}

function exchangeRateStep(game: GameData): number {
    return Math.max(0, game.market?.rateStep ?? 2);
}

function exchangeRateMin(game: GameData): number {
    return Math.max(0, game.market?.minExchangeRate ?? 20);
}

function exchangeRateMax(game: GameData): number {
    return Math.max(exchangeRateMin(game), game.market?.maxExchangeRate ?? 9_999);
}

function getMarketRate(state: SimState, game: GameData, resource: string): number | undefined {
    const fromState = state.marketRates[resource];
    if (fromState !== undefined) return fromState;
    const fromConfig = game.market?.baseExchangeRateByResource[resource];
    if (fromConfig === undefined) return undefined;
    return Math.min(exchangeRateMax(game), Math.max(exchangeRateMin(game), fromConfig));
}

function setMarketRate(state: SimState, game: GameData, resource: string, nextRate: number): void {
    state.marketRates[resource] = Math.min(exchangeRateMax(game), Math.max(exchangeRateMin(game), nextRate));
}

function sellPricePer100Gold(state: SimState, game: GameData, resource: string): number | undefined {
    const rate = getMarketRate(state, game, resource);
    if (rate === undefined) return undefined;
    const fee = effectiveMarketFee(state, resource, game.market?.fee ?? 0.3);
    return Math.max(1, Math.round(rate * (1 - fee)));
}

function buyPricePer100Gold(state: SimState, game: GameData, resource: string): number | undefined {
    const rate = getMarketRate(state, game, resource);
    if (rate === undefined) return undefined;
    const fee = effectiveMarketFee(state, resource, game.market?.fee ?? 0.3);
    return Math.max(1, Math.round(rate * (1 + fee)));
}

function onEventComplete(
    state: SimState,
    game: GameData,
    actionId: string,
    actors: string[],
): { createdNodeIds: string[] } {
    const action = game.actions[actionId];
    if (!action) return { createdNodeIds: [] };
    const createdNodeIds: string[] = [];

    if (action.resourceDeltaOnComplete) {
        addResources(state.resources, action.resourceDeltaOnComplete);
    }

    if (action.creates) {
        const popResource = game.population?.resource;
        if (popResource) {
            let popDelta = 0;
            for (const [entityType, count] of Object.entries(action.creates)) {
                popDelta += populationCapacityProvidedForEntityType(game, entityType, count);
            }
            if (popDelta !== 0) {
                state.resources[popResource] = (state.resources[popResource] ?? 0) + popDelta;
            }
        }

        for (const [entityType, count] of Object.entries(action.creates)) {
            for (let i = 0; i < count; i += 1) {
                const id = nextEntityId(state, entityType);
                state.entities.push({ id, entityType, busyUntil: state.now });
                state.entityTimelines[id] = { entityType, segments: [] };
                state.currentActivities[id] = { start: state.now, kind: "idle", detail: "idle" };

                const spawnRule = state.spawnGatherRules[entityType];
                if (spawnRule) {
                    assignEntityToGatherTargets(state, id, spawnRule.resourceNodeIds, spawnRule.resourceNodeSelectors);
                }
            }
        }
        recordEntityCountPoint(state);
    }

    if (action.createsResourceNodes) {
        for (const spec of action.createsResourceNodes) {
            const proto = game.resourceNodePrototypes[spec.prototypeId];
            if (!proto) continue;
            const count = spec.count ?? 1;
            for (let i = 0; i < count; i += 1) {
                const node = instantiateResourceNode(state, proto);
                createdNodeIds.push(node.id);
            }
        }
    }

    for (const actorId of actors) {
        const ent = state.entities.find((x) => x.id === actorId);
        if (!ent) continue;
        ent.busyUntil = Math.max(ent.busyUntil, state.now);
        // Multiple completions can occur at the same timestamp. If an earlier completion
        // already re-scheduled this actor at "now", don't overwrite that action state.
        if (ent.busyUntil > state.now + EPS) continue;
        if (ent.resourceNodeId) {
            const node = state.resourceNodeById[ent.resourceNodeId];
            switchEntityActivity(
                state,
                ent.id,
                node ? "gather" : "idle",
                node ? `${node.produces}:${node.prototypeId}` : "idle",
            );
        } else {
            switchEntityActivity(state, ent.id, "idle", "idle");
        }
    }

    state.completedActions += 1;
    const completionTimes = state.actionCompletionTimes[actionId] ?? [];
    completionTimes.push(state.now);
    state.actionCompletionTimes[actionId] = completionTimes;
    return { createdNodeIds };
}

function computeHealthMetrics(
    timeline: ResourceTimelineInterval[],
    evaluationTime: number,
    resources: string[],
): { totalGathered: ResourceMap; avgFloat: ResourceMap; peakDebt: ResourceMap; debtDuration: ResourceMap } {
    const totalGathered: ResourceMap = {};
    const floatSums: ResourceMap = {};
    const peakDebt: ResourceMap = {};
    const debtDuration: ResourceMap = {};

    for (const seg of timeline) {
        const dt = seg.end - seg.start;
        if (dt <= 0) continue;
        const rates = seg.gatherRates as Record<string, number>;
        for (const [res, rate] of Object.entries(rates)) {
            if (rate > 0) totalGathered[res] = (totalGathered[res] ?? 0) + rate * dt;
        }
        for (const res of resources) {
            const v0 = seg.startResources[res] ?? 0;
            const rate = rates[res] ?? 0;
            floatSums[res] = (floatSums[res] ?? 0) + v0 * dt + 0.5 * rate * dt * dt;
            if (v0 < 0) {
                peakDebt[res] = Math.min(peakDebt[res] ?? 0, v0);
                const ttRepay = rate > 0 ? Math.min(dt, -v0 / rate) : dt;
                debtDuration[res] = (debtDuration[res] ?? 0) + ttRepay;
            }
        }
    }

    const avgFloat: ResourceMap = {};
    for (const res of resources) {
        avgFloat[res] = evaluationTime > 0 ? (floatSums[res] ?? 0) / evaluationTime : 0;
    }

    return { totalGathered, avgFloat, peakDebt, debtDuration };
}

function processAutomation(state: SimState, game: GameData, options: SimOptions): void {
    let guard = 0;
    while (true) {
        guard += 1;
        if (guard > 1_000_000) {
            throw new Error(`processAutomation loop guard tripped (now=${state.now}).`);
        }

        const clickedEvents: TriggerEvent[] = [];
        const onActionClicked = (actionId: string, actors: string[], startedAt: number): void => {
            if (Math.abs(startedAt - state.now) > EPS) return;
            clickedEvents.push({ kind: "clicked", actionId, context: { actors: [...actors] } });
        };

        processQueueRules(state, game, options, onActionClicked);
        processAutoQueue(state, game, options, undefined, onActionClicked);

        if (clickedEvents.length === 0) break;
        for (const event of clickedEvents) {
            processTriggers(state, game, options, event, executeCommand);
        }
    }
}

function wakeAutomation(state: SimState): void {
    for (const rule of state.queueRules) {
        const wokeAt = Math.min(rule.nextAttemptAt, state.now);
        rule.nextAttemptAt = rule.delayUntil !== undefined ? Math.max(wokeAt, rule.delayUntil) : wokeAt;
    }
    for (const rule of state.autoQueueRules) {
        const wokeAt = Math.min(rule.nextAttemptAt, state.now);
        rule.nextAttemptAt = rule.delayUntil !== undefined ? Math.max(wokeAt, rule.delayUntil) : wokeAt;
    }
}

function nextAutomationTime(state: SimState): number {
    let next = Number.POSITIVE_INFINITY;
    for (const rule of state.queueRules) {
        if (Number.isFinite(rule.nextAttemptAt)) {
            next = Math.min(next, rule.nextAttemptAt);
        }
    }
    for (const rule of state.autoQueueRules) {
        if (Number.isFinite(rule.nextAttemptAt)) {
            next = Math.min(next, rule.nextAttemptAt);
        }
    }
    return next;
}

function advanceWithAutomation(
    state: SimState,
    targetTime: number,
    game: GameData,
    options: SimOptions,
    pendingDeferred: PendingDeferredCommand[],
): void {
    targetTime = toTick(targetTime);
    const debug = isSimDebugEnabled();

    let guard = 0;
    while (state.now + EPS < targetTime) {
        guard += 1;
        if (guard > 1_000_000) {
            throw new Error(`advanceWithAutomation loop guard tripped (now=${state.now}, target=${targetTime}).`);
        }
        wakeAutomation(state);
        processAutomation(state, game, options);

        const nextAuto = nextAutomationTime(state);
        const nextEvent = findNextEventTime(state.events, state.now) ?? Number.POSITIVE_INFINITY;
        const econ = computeEconomySnapshot(state);
        const nextDepletion =
            econ.nextDepletionTime !== undefined ? toFutureTick(econ.nextDepletionTime) : Number.POSITIVE_INFINITY;
        const stepTarget = Math.min(targetTime, nextAuto, nextEvent, nextDepletion);
        if (debug && (guard <= 20 || guard % 200 === 0)) {
            simDebug(
                "advanceWithAutomation.step",
                `now=${state.now}`,
                `target=${targetTime}`,
                `nextAuto=${nextAuto}`,
                `nextEvent=${nextEvent}`,
                `nextDepletion=${nextDepletion}`,
                `stepTarget=${stepTarget}`,
                `guard=${guard}`,
            );
        }
        if (stepTarget <= state.now + EPS) {
            const bumped = Math.min(targetTime, state.now + TIME_STEP_SECONDS);
            if (debug && (guard <= 20 || guard % 200 === 0)) {
                simDebug("advanceWithAutomation.bump", `from=${state.now}`, `to=${bumped}`, `target=${targetTime}`);
            }
            if (bumped <= state.now + EPS) break;
            const completions: Array<{ actionId: string; actors: string[] }> = [];
            const depletions: NodeDepletionEvent[] = [];
            advanceTime(
                state,
                bumped,
                (_s, _g, actionId, actors) => completions.push({ actionId, actors: [...actors] }),
                game,
                (_s, event) => depletions.push({ ...event, actors: [...event.actors] }),
            );
            processBoundaryPhases(state, game, options, completions, depletions, {
                onComplete: onEventComplete,
                onDeferred: () => processReadyDeferredCommands(state, game, options, pendingDeferred),
                onAutomation: () => processAutomation(state, game, options),
                onAutomationWake: () => wakeAutomation(state),
                executeCommand,
            });
            continue;
        }

        const completions: Array<{ actionId: string; actors: string[] }> = [];
        const depletions: NodeDepletionEvent[] = [];
        advanceTime(
            state,
            stepTarget,
            (_s, _g, actionId, actors) => completions.push({ actionId, actors: [...actors] }),
            game,
            (_s, event) => depletions.push({ ...event, actors: [...event.actors] }),
        );
        processBoundaryPhases(state, game, options, completions, depletions, {
            onComplete: onEventComplete,
            onDeferred: () => processReadyDeferredCommands(state, game, options, pendingDeferred),
            onAutomation: () => processAutomation(state, game, options),
            onAutomationWake: () => wakeAutomation(state),
            executeCommand,
        });
    }
}

function resolveDeferredCommandTime(state: SimState, cmd: BuildOrderCommand): number | undefined {
    if (!cmd.afterEntityId) return undefined;

    const afterEntityIdTime = resolveAfterEntityIdDeferredTime(state, cmd);
    if (afterEntityIdTime === undefined) return undefined;

    if (cmd.type === "assignGather") return resolveAssignGatherDeferredTime(state, cmd);
    return state.now;
}

function resolveAfterEntityIdDeferredTime(state: SimState, cmd: BuildOrderCommand): number | undefined {
    if (!cmd.afterEntityId) return undefined;
    return state.entities.some((e) => e.id === cmd.afterEntityId) ? state.now : undefined;
}

function resolveAssignRequestedCount(
    state: SimState,
    cmd: Extract<BuildOrderCommand, { type: "assignGather" }>,
): number {
    if (cmd.all) {
        const allRequest: Parameters<typeof pickEligibleActorIds>[1] = {
            actorTypes: [cmd.actorType],
            actorCount: state.entities.length,
            idleOnly: false,
        };
        if (cmd.actorResourceNodeIds !== undefined) allRequest.actorResourceNodeIds = cmd.actorResourceNodeIds;
        if (cmd.actorResourceNodeSelectors !== undefined)
            allRequest.actorResourceNodeSelectors = cmd.actorResourceNodeSelectors;
        return pickEligibleActorIds(state, allRequest).length;
    }
    return cmd.actorSelectors?.length ?? cmd.count ?? 0;
}

function resolveAssignGatherDeferredTime(
    state: SimState,
    cmd: Extract<BuildOrderCommand, { type: "assignGather" }>,
): number | undefined {
    const requestedCount = resolveAssignRequestedCount(state, cmd);
    if (requestedCount <= 0) return state.now;

    const availability: Parameters<typeof nextEligibleActorAvailabilityTime>[1] = {
        actorTypes: [cmd.actorType],
        actorCount: requestedCount,
    };
    if (cmd.actorSelectors !== undefined) availability.actorSelectors = cmd.actorSelectors;
    if (cmd.actorResourceNodeIds !== undefined) availability.actorResourceNodeIds = cmd.actorResourceNodeIds;
    if (cmd.actorResourceNodeSelectors !== undefined)
        availability.actorResourceNodeSelectors = cmd.actorResourceNodeSelectors;

    const availableAt = nextEligibleActorAvailabilityTime(state, availability);
    if (!Number.isFinite(availableAt)) return undefined;
    return toTick(availableAt);
}

interface PendingDeferredCommand {
    cmd: BuildOrderCommand;
    commandIndex: number;
    queuedAt: number;
}

function withImplicitAssignSpawnDefer(state: SimState, cmd: BuildOrderCommand): BuildOrderCommand {
    if (cmd.type !== "assignGather" && cmd.type !== "queueAction") return cmd;
    if (cmd.afterEntityId) return cmd;
    if (!cmd.actorSelectors || cmd.actorSelectors.length !== 1) return cmd;

    const actorId = cmd.actorSelectors[0];
    if (!actorId || !actorId.match(/^(.*)-(\d+)$/)) return cmd;
    if (state.entities.some((e) => e.id === actorId)) return cmd;

    return { ...cmd, afterEntityId: actorId };
}

function executeCommand(
    state: SimState,
    game: GameData,
    options: SimOptions,
    cmd: BuildOrderCommand,
    commandIndex: number,
    triggerContext?: TriggerEventContext,
): void {
    const pushScheduled = (type: BuildOrderCommand["type"], requestedAt: number): void => {
        state.commandResults.push({
            index: commandIndex,
            type,
            requestedAt,
            startedAt: state.now,
            delayedBy: state.now - requestedAt,
            status: "scheduled",
        });
    };

    const pushInvalidAssignment = (type: BuildOrderCommand["type"], requestedAt: number, message: string): void => {
        state.violations.push({ time: state.now, code: "INVALID_ASSIGNMENT", message });
        state.commandResults.push({ index: commandIndex, type, requestedAt, status: "failed", message });
    };

    const handlers: Record<BuildOrderCommand["type"], () => void> = {
        queueAction: () => {
            let queueCmd: Extract<BuildOrderCommand, { type: "queueAction" }> = cmd as Extract<
                BuildOrderCommand,
                { type: "queueAction" }
            >;
            if (!queueCmd.actorSelectors && queueCmd.afterEntityId) {
                const action = game.actions[queueCmd.actionId];
                const afterEntity = state.entities.find((e) => e.id === queueCmd.afterEntityId);
                const requiredActors = action?.actorCount ?? 1;
                if (
                    action &&
                    afterEntity &&
                    requiredActors === 1 &&
                    action.actorTypes.includes(afterEntity.entityType)
                ) {
                    queueCmd = { ...queueCmd, actorSelectors: [afterEntity.id] };
                }
            }
            if (!queueCmd.actorSelectors && triggerContext?.actors && triggerContext.actors.length > 0) {
                const action = game.actions[queueCmd.actionId];
                if (action) {
                    const requiredActors = action.actorCount ?? 1;
                    const preferredActorIds = triggerContext.actors
                        .filter((id) => {
                            const ent = state.entities.find((e) => e.id === id);
                            return Boolean(ent && action.actorTypes.includes(ent.entityType));
                        })
                        .slice(0, requiredActors);
                    if (preferredActorIds.length === requiredActors) {
                        queueCmd = { ...queueCmd, actorSelectors: preferredActorIds };
                    }
                }
            }
            registerQueueAction(state, queueCmd, commandIndex);
        },
        assignGather: () => {
            assignGather(state, cmd as Extract<BuildOrderCommand, { type: "assignGather" }>, commandIndex);
        },
        assignEventGather: () => {
            const assignEventCmd = cmd as Extract<BuildOrderCommand, { type: "assignEventGather" }>;
            const requestedAt = state.now;
            const actorIds = triggerContext?.actors ?? [];
            if (actorIds.length === 0) {
                if (triggerContext?.triggerMode === "every") {
                    // Repeating trigger with no actor context is a valid no-op.
                    pushScheduled(assignEventCmd.type, requestedAt);
                    return;
                }
                pushInvalidAssignment(
                    assignEventCmd.type,
                    requestedAt,
                    "Event-based assign had no actors in trigger context. " +
                        "This can happen when the trigger fires from passive depletion (for example decay). " +
                        "Use 'after every ...' for no-op-safe behavior or use explicit actor selection " +
                        "(for example 'assign villager all from <node> to ...').",
                );
                return;
            }
            const targetIds = new Set(assignEventCmd.resourceNodeIds ?? []);
            for (const selector of assignEventCmd.resourceNodeSelectors ?? []) {
                if (selector === "id:created") {
                    for (const id of triggerContext?.createdNodeIds ?? []) targetIds.add(id);
                }
            }
            const selectorTargets = (assignEventCmd.resourceNodeSelectors ?? []).filter(
                (selector) => selector !== "id:created",
            );
            const result = assignGatherByEntityIds(
                state,
                actorIds,
                targetIds.size > 0 ? [...targetIds] : undefined,
                selectorTargets.length > 0 ? selectorTargets : undefined,
            );
            if (!result.ok) {
                pushInvalidAssignment(assignEventCmd.type, requestedAt, result.message);
                return;
            }
            state.commandResults.push({
                index: commandIndex,
                type: assignEventCmd.type,
                requestedAt,
                startedAt: state.now,
                delayedBy: 0,
                status: "scheduled",
            });
        },
        autoQueue: () => {
            registerAutoQueue(state, cmd as Extract<BuildOrderCommand, { type: "autoQueue" }>, commandIndex);
        },
        stopAutoQueue: () => {
            stopAutoQueue(state, cmd as Extract<BuildOrderCommand, { type: "stopAutoQueue" }>, commandIndex);
        },
        setSpawnGather: () => {
            setSpawnGatherRule(state, cmd as Extract<BuildOrderCommand, { type: "setSpawnGather" }>, commandIndex);
        },
        grantResources: () => {
            const grantCmd = cmd as Extract<BuildOrderCommand, { type: "grantResources" }>;
            addResources(state.resources, grantCmd.resources);
            pushScheduled(grantCmd.type, state.now);
        },
        spawnEntities: () => {
            const spawnCmd = cmd as Extract<BuildOrderCommand, { type: "spawnEntities" }>;
            const entityDef = game.entities[spawnCmd.entityType];
            if (!entityDef) {
                pushInvalidAssignment(spawnCmd.type, state.now, `Unknown entity type '${spawnCmd.entityType}'.`);
                return;
            }
            const popResource = game.population?.resource;
            const popDelta = populationCapacityProvidedForEntityType(game, spawnCmd.entityType, spawnCmd.count);
            if (popResource && popDelta !== 0) {
                state.resources[popResource] = (state.resources[popResource] ?? 0) + popDelta;
            }
            for (let i = 0; i < spawnCmd.count; i += 1) {
                const id = nextEntityId(state, spawnCmd.entityType);
                state.entities.push({ id, entityType: spawnCmd.entityType, busyUntil: state.now });
                state.entityTimelines[id] = { entityType: spawnCmd.entityType, segments: [] };
                state.currentActivities[id] = { start: state.now, kind: "idle", detail: "idle" };
                const spawnRule = state.spawnGatherRules[spawnCmd.entityType];
                if (spawnRule) {
                    assignEntityToGatherTargets(state, id, spawnRule.resourceNodeIds, spawnRule.resourceNodeSelectors);
                }
            }
            recordEntityCountPoint(state);
            pushScheduled(spawnCmd.type, state.now);
        },
        addModifier: () => {
            const modCmd = cmd as Extract<BuildOrderCommand, { type: "addModifier" }>;
            state.activeModifiers.push(modCmd.modifier);
            applyStockModifierToExistingNodes(state, modCmd.modifier);
            pushScheduled(modCmd.type, state.now);
        },
        tradeResources: () => {
            const tradeCmd = cmd as Extract<BuildOrderCommand, { type: "tradeResources" }>;
            const requestedAt = state.now;
            const { sellResource, buyResource, amount } = tradeCmd;
            if (!state.entities.some((e) => e.entityType === "market")) {
                const message = "Trade requires at least one market.";
                state.violations.push({ time: state.now, code: "INVALID_ASSIGNMENT", message });
                state.commandResults.push({
                    index: commandIndex,
                    type: tradeCmd.type,
                    requestedAt,
                    status: "failed",
                    message,
                });
                return;
            }

            if (sellResource !== "gold" && buyResource !== "gold") {
                const sellPrice = sellPricePer100Gold(state, game, sellResource);
                const buyPrice = buyPricePer100Gold(state, game, buyResource);
                if (sellPrice === undefined || buyPrice === undefined) {
                    const message =
                        `Market does not support trade ${sellResource} -> ${buyResource}. ` +
                        `Only configured commodities can be exchanged.`;
                    state.violations.push({ time: state.now, code: "INVALID_ASSIGNMENT", message });
                    state.commandResults.push({
                        index: commandIndex,
                        type: tradeCmd.type,
                        requestedAt,
                        status: "failed",
                        message,
                    });
                    return;
                }

                const sellBalance = state.resources[sellResource] ?? 0;
                if (sellBalance - amount < options.debtFloor) {
                    const message =
                        `Insufficient ${sellResource} for trade: need ${amount.toFixed(2)}, have ${sellBalance.toFixed(2)} ` +
                        `(debt-floor=${options.debtFloor}).`;
                    state.violations.push({ time: state.now, code: "INSUFFICIENT_RESOURCES", message });
                    state.commandResults.push({
                        index: commandIndex,
                        type: tradeCmd.type,
                        requestedAt,
                        status: "failed",
                        message,
                    });
                    return;
                }
                const earnedGold = (amount * sellPrice) / 100;
                const boughtAmount = (earnedGold * 100) / buyPrice;
                state.resources[sellResource] = sellBalance - amount;
                state.resources[buyResource] = (state.resources[buyResource] ?? 0) + boughtAmount;
                const step = exchangeRateStep(game);
                setMarketRate(state, game, sellResource, (getMarketRate(state, game, sellResource) ?? 0) - step);
                setMarketRate(state, game, buyResource, (getMarketRate(state, game, buyResource) ?? 0) + step);
                pushScheduled(tradeCmd.type, requestedAt);
                return;
            }

            if (sellResource === "gold" && buyResource === "gold") {
                pushScheduled(tradeCmd.type, requestedAt);
                return;
            }

            if (buyResource === "gold") {
                const sellPrice = sellPricePer100Gold(state, game, sellResource);
                if (sellPrice === undefined) {
                    const message = `Market does not support selling '${sellResource}'.`;
                    state.violations.push({ time: state.now, code: "INVALID_ASSIGNMENT", message });
                    state.commandResults.push({
                        index: commandIndex,
                        type: tradeCmd.type,
                        requestedAt,
                        status: "failed",
                        message,
                    });
                    return;
                }
                const sellBalance = state.resources[sellResource] ?? 0;
                if (sellBalance - amount < options.debtFloor) {
                    const message =
                        `Insufficient ${sellResource} for trade: need ${amount.toFixed(2)}, have ${sellBalance.toFixed(2)} ` +
                        `(debt-floor=${options.debtFloor}).`;
                    state.violations.push({ time: state.now, code: "INSUFFICIENT_RESOURCES", message });
                    state.commandResults.push({
                        index: commandIndex,
                        type: tradeCmd.type,
                        requestedAt,
                        status: "failed",
                        message,
                    });
                    return;
                }
                const earnedGold = (amount * sellPrice) / 100;
                state.resources[sellResource] = sellBalance - amount;
                state.resources.gold = (state.resources.gold ?? 0) + earnedGold;
                setMarketRate(state, game, sellResource, (getMarketRate(state, game, sellResource) ?? 0) - exchangeRateStep(game));
                pushScheduled(tradeCmd.type, requestedAt);
                return;
            }

            const buyPrice = buyPricePer100Gold(state, game, buyResource);
            if (buyPrice === undefined) {
                const message = `Market does not support buying '${buyResource}'.`;
                state.violations.push({ time: state.now, code: "INVALID_ASSIGNMENT", message });
                state.commandResults.push({
                    index: commandIndex,
                    type: tradeCmd.type,
                    requestedAt,
                    status: "failed",
                    message,
                });
                return;
            }
            const goldCost = (amount * buyPrice) / 100;
            const goldBalance = state.resources.gold ?? 0;
            if (goldBalance - goldCost < options.debtFloor) {
                const message =
                    `Insufficient gold for trade: need ${goldCost.toFixed(2)}, have ${goldBalance.toFixed(2)} ` +
                    `(debt-floor=${options.debtFloor}).`;
                state.violations.push({ time: state.now, code: "INSUFFICIENT_RESOURCES", message });
                state.commandResults.push({
                    index: commandIndex,
                    type: tradeCmd.type,
                    requestedAt,
                    status: "failed",
                    message,
                });
                return;
            }
            state.resources.gold = goldBalance - goldCost;
            state.resources[buyResource] = (state.resources[buyResource] ?? 0) + amount;
            setMarketRate(state, game, buyResource, (getMarketRate(state, game, buyResource) ?? 0) + exchangeRateStep(game));
            pushScheduled(tradeCmd.type, requestedAt);
        },
        onTrigger: () => {
            const onTriggerCmd = cmd as Extract<BuildOrderCommand, { type: "onTrigger" }>;
            const triggerMode = onTriggerCmd.triggerMode ?? "once";
            if (
                !triggerContext &&
                triggerMode === "once" &&
                (onTriggerCmd.trigger.kind === "clicked" || onTriggerCmd.trigger.kind === "completed")
            ) {
                const times =
                    onTriggerCmd.trigger.kind === "clicked"
                        ? (state.actionClickTimes[onTriggerCmd.trigger.actionId] ?? [])
                        : (state.actionCompletionTimes[onTriggerCmd.trigger.actionId] ?? []);
                const priorMatches = times.filter((time) => time < state.now - EPS).length;
                if (priorMatches > 0) {
                    state.violations.push({
                        time: state.now,
                        code: "AMBIGUOUS_TRIGGER",
                        message:
                            `One-shot trigger '${onTriggerCmd.trigger.kind} ${onTriggerCmd.trigger.actionId}' was registered ` +
                            `after ${priorMatches} prior match(es). It will fire on the next match only. ` +
                            `Use 'at <time>' or chain conditions like ` +
                            `'after completed advance_feudal_age after completed ${onTriggerCmd.trigger.actionId} ...'.`,
                    });
                }
            }
            state.triggerRules.push({
                trigger: onTriggerCmd.trigger,
                mode: triggerMode,
                command: onTriggerCmd.command,
                sourceCommandIndex: commandIndex,
            });
            pushScheduled(onTriggerCmd.type, state.now);
        },
    };

    handlers[cmd.type]();
}

function processReadyDeferredCommands(
    state: SimState,
    game: GameData,
    options: SimOptions,
    pending: PendingDeferredCommand[],
): void {
    let changed = false;
    let guard = 0;

    do {
        guard += 1;
        if (guard > 1_000_000) {
            throw new Error(`processReadyDeferredCommands loop guard tripped (now=${state.now}).`);
        }
        changed = false;
        const readyIndices: number[] = [];
        for (let i = 0; i < pending.length; i += 1) {
            const entry = pending[i];
            if (!entry) continue;
            if (state.now + EPS < entry.queuedAt) continue;
            const deferredAt = resolveDeferredCommandTime(state, entry.cmd);
            if (deferredAt === undefined || deferredAt > state.now + EPS) continue;
            readyIndices.push(i);
        }
        if (readyIndices.length === 0) continue;

        const selectedIndex = readyIndices[0] ?? -1;
        if (selectedIndex < 0) continue;
        const selectedEntry = pending[selectedIndex];
        if (!selectedEntry) continue;

        executeCommand(state, game, options, selectedEntry.cmd, selectedEntry.commandIndex);
        pending.splice(selectedIndex, 1);
        changed = true;
    } while (changed);
}

function computeScores(state: SimState, criteria: ScoreCriterion[]): ScoreResult[] {
    return criteria.map((criterion) => {
        const count = criterion.count ?? 1;
        const cond = criterion.condition;
        let value: number | null = null;

        if (cond.kind === "clicked" || cond.kind === "completed") {
            const times =
                cond.kind === "clicked"
                    ? (state.actionClickTimes[cond.actionId] ?? [])
                    : (state.actionCompletionTimes[cond.actionId] ?? []);
            value = times[count - 1] ?? null;
        } else {
            const selector = cond.resourceNodeSelector;
            const matchingNodes = state.resourceNodes.filter((n) => matchesNodeSelector(n, selector));
            const depletionTimes = matchingNodes
                .map((n) => state.nodeDepletionTimes[n.id])
                .filter((t): t is number => t !== undefined)
                .sort((a, b) => a - b);

            if (cond.kind === "exhausted") {
                const allDepleted =
                    matchingNodes.length > 0 &&
                    matchingNodes.every((n) => state.nodeDepletionTimes[n.id] !== undefined);
                if (allDepleted && depletionTimes.length > 0) {
                    value = depletionTimes[depletionTimes.length - 1] ?? null;
                }
            } else {
                value = depletionTimes[count - 1] ?? null;
            }
        }

        return { criterion, value };
    });
}

export function runSimulation(game: GameData, buildOrder: BuildOrderInput, options: SimOptions): SimulationResult {
    const evaluationTime = toTick(options.evaluationTime);
    const initialResources = cloneResources(game.startingResources ?? {});
    for (const [resource, amount] of Object.entries(buildOrder.startingResources ?? {})) {
        initialResources[resource] = amount;
    }
    const allStartingEntities = buildOrder.startingEntities
        ? Object.entries(buildOrder.startingEntities).map(([entityType, count]) => {
              if (!game.entities[entityType]) {
                  throw new Error(`start with '${entityType}' must reference a known entity type.`);
              }
              return { entityType, count };
          })
        : [...(game.startingEntities ?? [])];
    const state: SimState = {
        now: 0,
        initialResources,
        resources: cloneResources(initialResources),
        entities: [],
        resourceNodes: [],
        resourceNodeById: {},
        events: [],
        violations: [],
        commandResults: [],
        completedActions: 0,
        maxDebt: 0,
        entityTypeCounters: {},
        resourceNodeCounter: 0,
        activeModifiers: [...(game.startingModifiers ?? [])],
        resourceTimeline: [],
        entityCountTimeline: [],
        entityTimelines: {},
        eventLogs: [],
        currentActivities: {},
        queueRules: [],
        autoQueueRules: [],
        spawnGatherRules: {},
        triggerRules: [],
        actionClickTimes: {},
        actionCompletionTimes: {},
        nodeDepletionTimes: {},
        marketRates: { ...(game.market?.baseExchangeRateByResource ?? {}) },
        humanDelays: Object.fromEntries(
            Object.entries(buildOrder.humanDelays ?? {}).map(([actionId, buckets]) => [
                actionId,
                buckets.map((bucket) => ({ ...bucket })),
            ]),
        ),
    };

    for (const se of allStartingEntities) {
        for (let i = 0; i < se.count; i += 1) {
            const id = nextEntityId(state, se.entityType);
            state.entities.push({ id, entityType: se.entityType, busyUntil: 0 });
            state.entityTimelines[id] = { entityType: se.entityType, segments: [] };
            state.currentActivities[id] = { start: 0, kind: "idle", detail: "idle" };
        }
    }

    const popResource = game.population?.resource;
    if (
        popResource &&
        !(
            buildOrder.startingResources &&
            Object.prototype.hasOwnProperty.call(buildOrder.startingResources, popResource)
        )
    ) {
        const availablePop = availablePopulationFromEntities(game, countEntitiesByType(state.entities));
        state.initialResources[popResource] = availablePop;
        state.resources[popResource] = availablePop;
    }

    const startingResourceNodes = buildOrder.startingResourceNodes ?? game.startingResourceNodes ?? [];
    for (const sg of startingResourceNodes) {
        const proto = game.resourceNodePrototypes[sg.prototypeId];
        if (!proto) continue;
        const count = sg.count ?? 1;
        for (let i = 0; i < count; i += 1) {
            instantiateResourceNode(state, proto);
        }
    }

    recordEntityCountPoint(state);
    const scheduledCommands = normalizeCommandTimes(buildOrder.commands)
        .map((cmd, originalIndex) => ({ cmd, originalIndex }))
        .sort((a, b) => {
            const dt = (a.cmd.at ?? 0) - (b.cmd.at ?? 0);
            if (Math.abs(dt) > EPS) return dt;
            return a.originalIndex - b.originalIndex;
        });
    const pendingDeferred: PendingDeferredCommand[] = [];
    type MainPhase = "command" | "evaluation";
    const mainPriority: Record<MainPhase, number> = { command: 10, evaluation: 100 };
    const queue = new EventQueue<MainPhase, { index: number; cmd: BuildOrderCommand } | {}>(mainPriority);
    for (const [index, item] of scheduledCommands.entries()) {
        const commandTime = toTick(item.cmd.at ?? 0);
        queue.push(commandTime, "command", { index, cmd: item.cmd });
    }
    queue.push(evaluationTime, "evaluation", {});

    while (!queue.isEmpty()) {
        const event = queue.pop();
        if (!event) break;
        const targetTime = toTick(event.time);

        if (state.now + EPS < targetTime) {
            advanceWithAutomation(state, targetTime, game, options, pendingDeferred);
        }

        processReadyDeferredCommands(state, game, options, pendingDeferred);

        if (event.phase === "evaluation") {
            break;
        }

        const payload = event.payload as { index: number; cmd: BuildOrderCommand };
        const cmd = withImplicitAssignSpawnDefer(state, payload.cmd);
        if (cmd.afterEntityId) {
            pendingDeferred.push({ cmd, commandIndex: payload.index, queuedAt: targetTime });
        } else {
            executeCommand(state, game, options, cmd, payload.index);
        }

        wakeAutomation(state);
        processAutomation(state, game, options);
        processReadyDeferredCommands(state, game, options, pendingDeferred);
    }

    if (state.now + EPS < evaluationTime) {
        advanceWithAutomation(state, evaluationTime, game, options, pendingDeferred);
    }
    processReadyDeferredCommands(state, game, options, pendingDeferred);
    finalizeQueueRulesAtEvaluation(state, game, options, evaluationTime);

    for (const [entityId, current] of Object.entries(state.currentActivities)) {
        if (current.start < evaluationTime) {
            state.entityTimelines[entityId]?.segments.push({ ...current, end: evaluationTime });
        }
    }

    const health = computeHealthMetrics(state.resourceTimeline, options.evaluationTime, game.resources);

    return {
        initialResources: state.initialResources,
        resourcesAtEvaluation: state.resources,
        entitiesByType: countEntitiesByType(state.entities),
        ...health,
        maxDebt: state.maxDebt,
        completedActions: state.completedActions,
        violations: state.violations,
        commandResults: state.commandResults,
        resourceTimeline: state.resourceTimeline,
        entityCountTimeline: state.entityCountTimeline,
        entityTimelines: state.entityTimelines,
        eventLogs: options.captureEventLog ? state.eventLogs : [],
        scores: computeScores(state, buildOrder.scores ?? []),
    };
}
