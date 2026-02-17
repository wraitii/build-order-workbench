import { applyNumericModifiers } from "./modifiers";
import { BuildOrderCommand, CommandResult, GameData, ResourceNodeInstance, SimOptions } from "./types";
import { AutoQueueRule, EPS, SimState, compareEntityIdNatural, switchEntityActivity } from "./sim_shared";
import { computeEconomySnapshot, advanceTime } from "./economy";

function canAfford(resources: Record<string, number>, costs: Record<string, number>, debtFloor: number): boolean {
  for (const [resource, cost] of Object.entries(costs)) {
    if ((resources[resource] ?? 0) - cost < debtFloor) return false;
  }
  return true;
}

function timeToAffordWithCurrentRates(
  resources: Record<string, number>,
  costs: Record<string, number>,
  rates: Record<string, number>,
  debtFloor: number,
): number {
  let required = 0;
  for (const [resource, cost] of Object.entries(costs)) {
    const deficit = cost - ((resources[resource] ?? 0) - debtFloor);
    if (deficit <= 0) continue;
    const rate = rates[resource] ?? 0;
    if (rate <= 0) return Infinity;
    required = Math.max(required, deficit / rate);
  }
  return required;
}

function chargeCosts(state: SimState, costs: Record<string, number>): void {
  for (const [resource, cost] of Object.entries(costs)) {
    state.resources[resource] = (state.resources[resource] ?? 0) - cost;
    state.maxDebt = Math.min(state.maxDebt, state.resources[resource]);
  }
}

function pickIdleActors(
  state: SimState,
  actorTypes: string[],
  actorCount: number,
  actorTypeOverride?: string,
  actorIds?: string[],
): string[] {
  if (actorIds && actorIds.length > 0) {
    return state.entities
      .filter((e) => actorIds.includes(e.id) && e.busyUntil <= state.now + EPS)
      .sort((a, b) => compareEntityIdNatural(a.id, b.id))
      .slice(0, actorCount)
      .map((e) => e.id);
  }

  const allowed = actorTypeOverride ? [actorTypeOverride] : actorTypes;
  return state.entities
    .filter((e) => allowed.includes(e.entityType) && e.busyUntil <= state.now + EPS)
    .sort((a, b) => compareEntityIdNatural(a.id, b.id))
    .slice(0, actorCount)
    .map((e) => e.id);
}

function splitSelector(selector: string): { kind: string; value: string } {
  const idx = selector.indexOf(":");
  if (idx < 0) return { kind: "id", value: selector };
  return { kind: selector.slice(0, idx), value: selector.slice(idx + 1) };
}

function matchesSelector(node: ResourceNodeInstance, selector: string): boolean {
  const { kind, value } = splitSelector(selector);
  if (kind === "id") return node.id === value;
  if (kind === "proto") return node.prototypeId === value;
  if (kind === "tag") return node.tags.includes(value);
  if (kind === "res") return node.produces === value;
  return false;
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
      if (resourceNodeSelectors.some((selector) => matchesSelector(node, selector))) {
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
  cmd: Pick<Extract<BuildOrderCommand, { type: "queueAction" }>, "actionId" | "actorType" | "actorIds">,
): { status: "scheduled" } | { status: "blocked"; reason: "NO_ACTORS" | "INSUFFICIENT_RESOURCES" } | { status: "invalid"; message: string } {
  const action = game.actions[cmd.actionId];
  if (!action) {
    return { status: "invalid", message: `Action '${cmd.actionId}' not found.` };
  }

  const actorCount = action.actorCount ?? 1;
  const actorIds = pickIdleActors(state, action.actorTypes, actorCount, cmd.actorType, cmd.actorIds);
  if (actorIds.length < actorCount) {
    return { status: "blocked", reason: "NO_ACTORS" };
  }

  const costs = action.costs ?? {};
  if (!canAfford(state.resources, costs, options.debtFloor)) {
    return { status: "blocked", reason: "INSUFFICIENT_RESOURCES" };
  }

  chargeCosts(state, costs);

  const duration = applyNumericModifiers(action.duration, [`action.duration.${action.id}`], state.activeModifiers);
  for (const id of actorIds) {
    const ent = state.entities.find((e) => e.id === id);
    if (!ent) continue;
    ent.busyUntil = state.now + duration;
    switchEntityActivity(state, id, "action", action.id);
  }

  state.events.push({
    time: state.now + duration,
    actionId: action.id,
    actors: actorIds,
  });

  return { status: "scheduled" };
}

export function scheduleAction(
  state: SimState,
  game: GameData,
  cmd: Extract<BuildOrderCommand, { type: "queueAction" }>,
  options: SimOptions,
  commandIndex: number,
  onEventComplete: (state: SimState, game: GameData, actionId: string, actors: string[]) => void,
): void {
  const requestedAt = cmd.at ?? state.now;
  const action = game.actions[cmd.actionId];
  if (!action) {
    state.commandResults.push({
      index: commandIndex,
      type: cmd.type,
      requestedAt,
      status: "failed",
      message: `Action '${cmd.actionId}' not found.`,
    });
    state.violations.push({ time: state.now, code: "ACTION_NOT_FOUND", message: `Action '${cmd.actionId}' not found.` });
    return;
  }

  const iterations = cmd.count ?? 1;
  for (let i = 0; i < iterations; i += 1) {
    let startedAt: number | undefined;
    let blocked = false;

    while (true) {
      const result = tryScheduleActionNow(state, game, options, cmd);
      if (result.status === "scheduled") {
        startedAt = state.now;
        break;
      }

      if (result.status === "invalid") {
        state.commandResults.push({
          index: commandIndex,
          type: cmd.type,
          requestedAt,
          status: "failed",
          message: result.message,
        });
        state.violations.push({ time: state.now, code: "ACTION_NOT_FOUND", message: result.message });
        return;
      }

      if (options.strict && result.reason === "INSUFFICIENT_RESOURCES") {
        state.violations.push({
          time: state.now,
          code: "INSUFFICIENT_RESOURCES",
          message: `Insufficient resources for '${action.id}' at ${state.now.toFixed(2)}s.`,
        });
        blocked = true;
        break;
      }

      const econ = computeEconomySnapshot(state);
      const nextEventTime = state.events
        .filter((e) => e.time > state.now + EPS)
        .sort((a, b) => a.time - b.time)[0]?.time ?? Infinity;
      const dtToAfford =
        result.reason === "INSUFFICIENT_RESOURCES"
          ? timeToAffordWithCurrentRates(state.resources, action.costs ?? {}, econ.resourceRates, options.debtFloor)
          : Infinity;
      const next = Math.min(nextEventTime, state.now + dtToAfford, econ.nextDepletionTime ?? Infinity);

      if (!Number.isFinite(next) || next <= state.now + EPS) {
        const code = result.reason === "NO_ACTORS" ? "NO_ACTORS" : "RESOURCE_STALL";
        state.violations.push({
          time: state.now,
          code,
          message:
            code === "NO_ACTORS"
              ? `No available actors to perform '${action.id}'.`
              : `Stalled waiting for resources for '${action.id}'.`,
        });
        blocked = true;
        break;
      }

      advanceTime(state, next, onEventComplete, game);
    }

    const result: CommandResult =
      startedAt !== undefined
        ? {
            index: commandIndex,
            type: cmd.type,
            requestedAt,
            startedAt,
            delayedBy: startedAt - requestedAt,
            status: "scheduled",
          }
        : {
            index: commandIndex,
            type: cmd.type,
            requestedAt,
            status: "failed",
            message: `Could not schedule iteration ${i + 1}/${iterations}.`,
          };
    state.commandResults.push(result);
    if (blocked && startedAt === undefined) break;
  }
}

export function registerAutoQueue(
  state: SimState,
  cmd: Extract<BuildOrderCommand, { type: "autoQueue" }>,
  commandIndex: number,
): void {
  const requestedAt = cmd.at ?? state.now;
  const rule: AutoQueueRule = {
    actionId: cmd.actionId,
    retryEvery: Math.max(0.1, cmd.retryEvery ?? 1),
    runs: 0,
    nextAttemptAt: state.now,
  };
  if (cmd.actorType !== undefined) rule.actorType = cmd.actorType;
  if (cmd.actorIds !== undefined) rule.actorIds = cmd.actorIds;
  if (cmd.until !== undefined) rule.until = cmd.until;
  if (cmd.maxRuns !== undefined) rule.maxRuns = cmd.maxRuns;

  state.autoQueueRules.push(rule);
  state.commandResults.push({
    index: commandIndex,
    type: cmd.type,
    requestedAt,
    startedAt: state.now,
    delayedBy: state.now - requestedAt,
    status: "scheduled",
  });
}

export function processAutoQueue(
  state: SimState,
  game: GameData,
  options: SimOptions,
): void {
  let changed = false;

  do {
    changed = false;
    for (const rule of state.autoQueueRules) {
      if (rule.until !== undefined && state.now > rule.until + EPS) continue;
      if (rule.maxRuns !== undefined && rule.runs >= rule.maxRuns) continue;
      if (state.now + EPS < rule.nextAttemptAt) continue;

      const queueCmd: Pick<Extract<BuildOrderCommand, { type: "queueAction" }>, "actionId" | "actorType" | "actorIds"> = {
        actionId: rule.actionId,
      };
      if (rule.actorType !== undefined) queueCmd.actorType = rule.actorType;
      if (rule.actorIds !== undefined) queueCmd.actorIds = rule.actorIds;
      const result = tryScheduleActionNow(state, game, options, queueCmd);

      if (result.status === "scheduled") {
        rule.runs += 1;
        rule.nextAttemptAt = state.now;
        changed = true;
        continue;
      }

      if (result.status === "invalid") {
        state.violations.push({ time: state.now, code: "ACTION_NOT_FOUND", message: result.message });
        rule.nextAttemptAt = Number.POSITIVE_INFINITY;
        continue;
      }

      rule.nextAttemptAt = state.now + rule.retryEvery;
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
  state.commandResults.push({
    index: commandIndex,
    type: cmd.type,
    requestedAt,
    startedAt: state.now,
    delayedBy: state.now - requestedAt,
    status: "scheduled",
  });
}

export function assignGather(
  state: SimState,
  cmd: Extract<BuildOrderCommand, { type: "assignGather" }>,
  commandIndex: number,
): void {
  const requestedAt = cmd.at ?? state.now;
  const targets = resolveNodeTargets(state, cmd.resourceNodeIds, cmd.resourceNodeSelectors);

  if (targets.length === 0) {
    const msg = "No valid resource nodes for assignGather.";
    state.violations.push({ time: state.now, code: "INVALID_ASSIGNMENT", message: msg });
    state.commandResults.push({ index: commandIndex, type: cmd.type, requestedAt, status: "failed", message: msg });
    return;
  }

  const candidates = state.entities
    .filter((e) => e.entityType === cmd.actorType)
    .sort((a, b) => (a.busyUntil !== b.busyUntil ? a.busyUntil - b.busyUntil : compareEntityIdNatural(a.id, b.id)));

  const picked = candidates.slice(0, cmd.count);
  if (picked.length < cmd.count) {
    const msg = `assignGather requested ${cmd.count} '${cmd.actorType}', found ${picked.length}.`;
    state.violations.push({ time: state.now, code: "INVALID_ASSIGNMENT", message: msg });
    state.commandResults.push({ index: commandIndex, type: cmd.type, requestedAt, status: "failed", message: msg });
    return;
  }

  const assignedCount: Record<string, number> = {};
  for (const e of state.entities) {
    if (e.resourceNodeId) assignedCount[e.resourceNodeId] = (assignedCount[e.resourceNodeId] ?? 0) + 1;
  }

  for (const ent of picked) {
    const node = pickGatherNode(ent.entityType, targets, assignedCount);
    if (!node) {
      const msg = `No gather slot available for '${ent.id}' on requested resource nodes.`;
      state.violations.push({ time: state.now, code: "INVALID_ASSIGNMENT", message: msg });
      state.commandResults.push({ index: commandIndex, type: cmd.type, requestedAt, status: "failed", message: msg });
      return;
    }

    ent.resourceNodeId = node.id;
    assignedCount[node.id] = (assignedCount[node.id] ?? 0) + 1;
    if (ent.busyUntil <= state.now + EPS) {
      switchEntityActivity(state, ent.id, "gather", `${node.produces}:${node.prototypeId}`);
    }
  }

  state.commandResults.push({
    index: commandIndex,
    type: cmd.type,
    requestedAt,
    startedAt: state.now,
    delayedBy: state.now - requestedAt,
    status: "scheduled",
  });
}

export function shiftGather(
  state: SimState,
  cmd: Extract<BuildOrderCommand, { type: "shiftGather" }>,
  commandIndex: number,
): void {
  const requestedAt = cmd.at ?? state.now;
  const toTargets = resolveNodeTargets(state, cmd.resourceNodeIds, cmd.resourceNodeSelectors);
  if (toTargets.length === 0) {
    const msg = "No valid destination nodes for shiftGather.";
    state.violations.push({ time: state.now, code: "INVALID_ASSIGNMENT", message: msg });
    state.commandResults.push({ index: commandIndex, type: cmd.type, requestedAt, status: "failed", message: msg });
    return;
  }

  const fromSet = new Set(
    resolveNodeTargets(state, cmd.fromResourceNodeIds, cmd.fromResourceNodeSelectors).map((n) => n.id),
  );

  const candidates = state.entities
    .filter((e) => e.entityType === cmd.actorType)
    .filter((e) => (fromSet.size === 0 ? Boolean(e.resourceNodeId) : (e.resourceNodeId ? fromSet.has(e.resourceNodeId) : false)))
    .sort((a, b) => compareEntityIdNatural(a.id, b.id));

  const picked = candidates.slice(0, cmd.count);
  if (picked.length < cmd.count) {
    const msg = `shiftGather requested ${cmd.count} '${cmd.actorType}', found ${picked.length}.`;
    state.violations.push({ time: state.now, code: "INVALID_ASSIGNMENT", message: msg });
    state.commandResults.push({ index: commandIndex, type: cmd.type, requestedAt, status: "failed", message: msg });
    return;
  }

  const assignedCount: Record<string, number> = {};
  for (const e of state.entities) {
    if (e.resourceNodeId) assignedCount[e.resourceNodeId] = (assignedCount[e.resourceNodeId] ?? 0) + 1;
  }

  for (const ent of picked) {
    if (ent.resourceNodeId) assignedCount[ent.resourceNodeId] = Math.max(0, (assignedCount[ent.resourceNodeId] ?? 1) - 1);

    const node = pickGatherNode(ent.entityType, toTargets, assignedCount);
    if (!node) {
      const msg = `No destination gather slot available for '${ent.id}'.`;
      state.violations.push({ time: state.now, code: "INVALID_ASSIGNMENT", message: msg });
      state.commandResults.push({ index: commandIndex, type: cmd.type, requestedAt, status: "failed", message: msg });
      return;
    }

    ent.resourceNodeId = node.id;
    assignedCount[node.id] = (assignedCount[node.id] ?? 0) + 1;
    if (ent.busyUntil <= state.now + EPS) {
      switchEntityActivity(state, ent.id, "gather", `${node.produces}:${node.prototypeId}`);
    }
  }

  state.commandResults.push({
    index: commandIndex,
    type: cmd.type,
    requestedAt,
    startedAt: state.now,
    delayedBy: state.now - requestedAt,
    status: "scheduled",
  });
}
