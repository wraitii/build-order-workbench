import { EntityActivitySegment, EntityInstance, EntityTimeline, ResourceMap, ScheduledEvent, SimulationResult, Violation, CommandResult, ResourceNodeInstance, NumericModifier } from "./types";

export const EPS = 1e-9;

export interface AutoQueueRule {
  actionId: string;
  actorType?: string;
  actorIds?: string[];
  retryEvery: number;
  until?: number;
  maxRuns?: number;
  runs: number;
  nextAttemptAt: number;
}

export interface SimState {
  now: number;
  initialResources: ResourceMap;
  resources: ResourceMap;
  entities: EntityInstance[];
  resourceNodes: ResourceNodeInstance[];
  resourceNodeById: Record<string, ResourceNodeInstance>;
  events: ScheduledEvent[];
  violations: Violation[];
  commandResults: CommandResult[];
  completedActions: number;
  maxDebt: number;
  idCounter: number;
  resourceNodeCounter: number;
  activeModifiers: NumericModifier[];
  resourceTimeline: SimulationResult["resourceTimeline"];
  entityCountTimeline: SimulationResult["entityCountTimeline"];
  entityTimelines: Record<string, EntityTimeline>;
  currentActivities: Record<string, Omit<EntityActivitySegment, "end">>;
  autoQueueRules: AutoQueueRule[];
  spawnGatherRules: Record<string, { resourceNodeIds?: string[]; resourceNodeSelectors?: string[] }>;
}

export function cloneResources(input: ResourceMap): ResourceMap {
  return Object.fromEntries(Object.entries(input).map(([k, v]) => [k, v]));
}

export function addResources(base: ResourceMap, delta: ResourceMap): void {
  for (const [resource, value] of Object.entries(delta)) {
    base[resource] = (base[resource] ?? 0) + value;
  }
}

function splitEntityId(entityId: string): { prefix: string; num: number } {
  const m = entityId.match(/^(.*?)-(\d+)$/);
  if (!m) return { prefix: entityId, num: Number.POSITIVE_INFINITY };
  return { prefix: m[1] ?? entityId, num: Number(m[2] ?? Number.POSITIVE_INFINITY) };
}

export function compareEntityIdNatural(a: string, b: string): number {
  const pa = splitEntityId(a);
  const pb = splitEntityId(b);
  if (pa.prefix !== pb.prefix) return pa.prefix.localeCompare(pb.prefix);
  if (pa.num !== pb.num) return pa.num - pb.num;
  return a.localeCompare(b);
}

export function normalizeCommandTimes<T extends { at?: number }>(commands: T[]): T[] {
  let last = 0;
  return commands.map((c) => {
    const at = c.at ?? last;
    last = at;
    return { ...c, at };
  });
}

export function countEntitiesByType(entities: EntityInstance[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const ent of entities) {
    out[ent.entityType] = (out[ent.entityType] ?? 0) + 1;
  }
  return out;
}

export function recordEntityCountPoint(state: SimState): void {
  const last = state.entityCountTimeline[state.entityCountTimeline.length - 1];
  const point = {
    time: state.now,
    entitiesByType: countEntitiesByType(state.entities),
  };
  if (last && Math.abs(last.time - point.time) < EPS) {
    state.entityCountTimeline[state.entityCountTimeline.length - 1] = point;
  } else {
    state.entityCountTimeline.push(point);
  }
}

export function switchEntityActivity(
  state: SimState,
  entityId: string,
  kind: EntityActivitySegment["kind"],
  detail: string,
): void {
  const current = state.currentActivities[entityId];
  if (current && current.kind === kind && current.detail === detail) return;

  if (current) {
    const timeline = state.entityTimelines[entityId];
    if (timeline && current.start < state.now - EPS) {
      timeline.segments.push({ ...current, end: state.now });
    }
  }

  state.currentActivities[entityId] = { start: state.now, kind, detail };
}

export function findNextEventTime(events: ScheduledEvent[], now: number): number | undefined {
  let next: number | undefined;
  for (const e of events) {
    if (e.time <= now + EPS) continue;
    if (next === undefined || e.time < next) next = e.time;
  }
  return next;
}
