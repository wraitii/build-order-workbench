import { applyNumericModifiers } from "./modifiers";
import { GameData, ResourceNodeDef, ResourceNodeInstance } from "./types";
import { EPS, SimState, cloneResources, findNextEventTime, switchEntityActivity } from "./sim_shared";

export interface TargetEconomy {
  target: ResourceNodeInstance;
  rate: number;
  workers: string[];
}

export interface EconomySnapshot {
  resourceRates: Record<string, number>;
  targetEconomy: TargetEconomy[];
  nextDepletionTime?: number;
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

  state.resourceNodes.push(node);
  state.resourceNodeById[node.id] = node;
  return node;
}

export function applyStockModifierToExistingNodes(state: SimState, mod: { selector: string; op: "mul" | "add" | "set"; value: number }): void {
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
  }

  let nextDepletionTime: number | undefined;
  const targetEconomy = Object.values(grouped);
  for (const item of targetEconomy) {
    resourceRates[item.target.produces] = (resourceRates[item.target.produces] ?? 0) + item.rate;
    if (item.target.remainingStock !== undefined && item.rate > 0) {
      const t = state.now + item.target.remainingStock / item.rate;
      if (nextDepletionTime === undefined || t < nextDepletionTime) nextDepletionTime = t;
    }
  }

  return nextDepletionTime === undefined
    ? { resourceRates, targetEconomy }
    : { resourceRates, targetEconomy, nextDepletionTime };
}

function handleDepletedNodes(state: SimState): void {
  for (const node of state.resourceNodes) {
    if (node.remainingStock === undefined || node.remainingStock > EPS) continue;
    for (const ent of state.entities) {
      if (ent.resourceNodeId !== node.id) continue;
      delete ent.resourceNodeId;
      if (ent.busyUntil <= state.now + EPS) switchEntityActivity(state, ent.id, "idle", "idle");
    }
  }
}

export function advanceTime(
  state: SimState,
  targetTime: number,
  onEventComplete: (state: SimState, game: GameData, actionId: string, actors: string[]) => void,
  game: GameData,
): void {
  if (targetTime <= state.now + EPS) return;

  while (state.now + EPS < targetTime) {
    const nextEventTime = findNextEventTime(state.events, state.now) ?? Infinity;
    const econ = computeEconomySnapshot(state);
    const stepTo = Math.min(targetTime, nextEventTime, econ.nextDepletionTime ?? Infinity);
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
      for (const item of econ.targetEconomy) {
        if (item.target.remainingStock === undefined) continue;
        item.target.remainingStock = Math.max(0, item.target.remainingStock - item.rate * dt);
      }

      state.now = stepTo;
      handleDepletedNodes(state);
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
