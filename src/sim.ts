import { addResources, cloneResources, countEntitiesByType, normalizeCommandTimes, recordEntityCountPoint, SimState, switchEntityActivity, EPS } from "./sim_shared";
import { BuildOrderInput, BuildOrderCommand, GameData, SimOptions, SimulationResult } from "./types";
import { applyStockModifierToExistingNodes, advanceTime, instantiateResourceNode } from "./economy";
import { assignEntityToGatherTargets, assignGather, processAutoQueue, registerAutoQueue, scheduleAction, setSpawnGatherRule, shiftGather } from "./scheduler";

function onEventComplete(state: SimState, game: GameData, actionId: string, actors: string[]): void {
  const action = game.actions[actionId];
  if (!action) return;

  if (action.resourceDeltaOnComplete) {
    addResources(state.resources, action.resourceDeltaOnComplete);
  }

  if (action.modifiersOnComplete) {
    for (const mod of action.modifiersOnComplete) {
      state.activeModifiers.push(mod);
      applyStockModifierToExistingNodes(state, mod);
    }
  }

  if (action.creates) {
    for (const [entityType, count] of Object.entries(action.creates)) {
      for (let i = 0; i < count; i += 1) {
        state.idCounter += 1;
        const id = `${entityType}-${state.idCounter}`;
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
        instantiateResourceNode(state, proto);
      }
    }
  }

  for (const actorId of actors) {
    const ent = state.entities.find((x) => x.id === actorId);
    if (!ent) continue;
    ent.busyUntil = Math.max(ent.busyUntil, state.now);
    if (ent.resourceNodeId) {
      const node = state.resourceNodeById[ent.resourceNodeId];
      switchEntityActivity(state, ent.id, node ? "gather" : "idle", node ? `${node.produces}:${node.prototypeId}` : "idle");
    } else {
      switchEntityActivity(state, ent.id, "idle", "idle");
    }
  }

  state.completedActions += 1;
}

function computeScenarioScore(result: Omit<SimulationResult, "scenarioScore">): number {
  const scheduled = result.commandResults.filter((c) => c.status === "scheduled");
  const avgDelay = scheduled.reduce((sum, c) => sum + (c.delayedBy ?? 0), 0) / Math.max(1, scheduled.length);

  const violationPenalty = result.violations.length * 10;
  const debtPenalty = Math.max(0, -result.maxDebt) * 0.4;
  const delayPenalty = avgDelay * 0.5;

  return Math.max(0, Math.min(100, 100 - violationPenalty - debtPenalty - delayPenalty));
}

function processAutomation(state: SimState, game: GameData, options: SimOptions): void {
  processAutoQueue(state, game, options);
}

function nextAutomationTime(state: SimState): number {
  let next = Number.POSITIVE_INFINITY;
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
): void {
  const onComplete = (innerState: SimState, innerGame: GameData, actionId: string, actors: string[]): void => {
    onEventComplete(innerState, innerGame, actionId, actors);
    processAutomation(innerState, innerGame, options);
  };

  while (state.now + EPS < targetTime) {
    processAutomation(state, game, options);

    const nextAuto = nextAutomationTime(state);
    const stepTarget = Math.min(targetTime, nextAuto);

    if (stepTarget <= state.now + EPS) {
      const bumped = Math.min(targetTime, state.now + 0.1);
      if (bumped <= state.now + EPS) break;
      advanceTime(state, bumped, onComplete, game);
      continue;
    }

    advanceTime(state, stepTarget, onComplete, game);
  }
}

export function runSimulation(game: GameData, buildOrder: BuildOrderInput, options: SimOptions): SimulationResult {
  const state: SimState = {
    now: 0,
    initialResources: cloneResources(game.startingResources),
    resources: cloneResources(game.startingResources),
    entities: [],
    resourceNodes: [],
    resourceNodeById: {},
    events: [],
    violations: [],
    commandResults: [],
    completedActions: 0,
    maxDebt: 0,
    idCounter: 0,
    resourceNodeCounter: 0,
    activeModifiers: [...(game.startingModifiers ?? [])],
    resourceTimeline: [],
    entityCountTimeline: [],
    entityTimelines: {},
    currentActivities: {},
    autoQueueRules: [],
    spawnGatherRules: {},
  };

  for (const se of game.startingEntities) {
    for (let i = 0; i < se.count; i += 1) {
      state.idCounter += 1;
      const id = `${se.entityType}-${state.idCounter}`;
      state.entities.push({ id, entityType: se.entityType, busyUntil: 0 });
      state.entityTimelines[id] = { entityType: se.entityType, segments: [] };
      state.currentActivities[id] = { start: 0, kind: "idle", detail: "idle" };
    }
  }

  for (const sg of game.startingResourceNodes) {
    const proto = game.resourceNodePrototypes[sg.prototypeId];
    if (!proto) continue;
    const count = sg.count ?? 1;
    for (let i = 0; i < count; i += 1) {
      instantiateResourceNode(state, proto);
    }
  }

  recordEntityCountPoint(state);
  const onCompleteWithAutomation = (innerState: SimState, innerGame: GameData, actionId: string, actors: string[]): void => {
    onEventComplete(innerState, innerGame, actionId, actors);
    processAutomation(innerState, innerGame, options);
  };

  const commands = normalizeCommandTimes(buildOrder.commands).sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
  for (const [i, cmd] of commands.entries()) {
    advanceWithAutomation(state, cmd.at ?? state.now, game, options);

    if (cmd.type === "queueAction") {
      scheduleAction(state, game, cmd as Extract<BuildOrderCommand, { type: "queueAction" }>, options, i, onCompleteWithAutomation);
    } else if (cmd.type === "assignGather") {
      assignGather(state, cmd as Extract<BuildOrderCommand, { type: "assignGather" }>, i);
    } else if (cmd.type === "autoQueue") {
      registerAutoQueue(state, cmd as Extract<BuildOrderCommand, { type: "autoQueue" }>, i);
    } else if (cmd.type === "setSpawnGather") {
      setSpawnGatherRule(state, cmd as Extract<BuildOrderCommand, { type: "setSpawnGather" }>, i);
    } else if (cmd.type === "shiftGather") {
      shiftGather(state, cmd as Extract<BuildOrderCommand, { type: "shiftGather" }>, i);
    }

    processAutomation(state, game, options);
  }

  advanceWithAutomation(state, options.evaluationTime, game, options);

  for (const [entityId, current] of Object.entries(state.currentActivities)) {
    if (current.start < options.evaluationTime) {
      state.entityTimelines[entityId]?.segments.push({ ...current, end: options.evaluationTime });
    }
  }

  const core = {
    initialResources: state.initialResources,
    resourcesAtEvaluation: state.resources,
    entitiesByType: countEntitiesByType(state.entities),
    maxDebt: state.maxDebt,
    totalDelays: state.commandResults.reduce((sum, c) => sum + (c.delayedBy ?? 0), 0),
    completedActions: state.completedActions,
    violations: state.violations,
    commandResults: state.commandResults,
    resourceTimeline: state.resourceTimeline,
    entityCountTimeline: state.entityCountTimeline,
    entityTimelines: state.entityTimelines,
  };

  return {
    ...core,
    scenarioScore: computeScenarioScore(core),
  };
}
