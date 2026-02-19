import {
    EntityActivitySegment,
    EntityInstance,
    EntityTimeline,
    GameData,
    ResourceMap,
    ScheduledEvent,
    SimulationResult,
    Violation,
    CommandResult,
    ResourceNodeInstance,
    NumericModifier,
    TriggerCondition,
    TriggerMode,
    BuildOrderCommand,
    HumanDelayBucket,
} from "./types";

export function normalizeGame(game: GameData): void {
    for (const [id, entity] of Object.entries(game.entities)) {
        (entity as { id: string }).id = id;
    }
    for (const [id, proto] of Object.entries(game.resourceNodePrototypes)) {
        (proto as { id: string }).id = id;
    }
    const actorTypesMap: Record<string, string[]> = {};
    for (const [entityId, entity] of Object.entries(game.entities)) {
        for (const actionId of entity.actions ?? []) {
            (actorTypesMap[actionId] ??= []).push(entityId);
        }
    }
    for (const [id, action] of Object.entries(game.actions)) {
        (action as { id: string }).id = id;
        action.actorTypes = actorTypesMap[id] ?? [];
    }
}

export const EPS = 1e-9;
export const TIME_STEP_SECONDS = 1;

export function toTick(time: number): number {
    if (!Number.isFinite(time)) return time;
    return Math.max(0, Math.round(time / TIME_STEP_SECONDS) * TIME_STEP_SECONDS);
}

export function toFutureTick(time: number): number {
    if (!Number.isFinite(time)) return time;
    return Math.max(0, Math.ceil(time / TIME_STEP_SECONDS) * TIME_STEP_SECONDS);
}

export function quantizeDuration(seconds: number): number {
    if (seconds <= 0) return 0;
    return Math.max(TIME_STEP_SECONDS, Math.round(seconds / TIME_STEP_SECONDS) * TIME_STEP_SECONDS);
}

export interface AutoQueueRule {
    actionId: string;
    actorSelectors?: string[];
    actorResourceNodeIds?: string[];
    actorResourceNodeSelectors?: string[];
    nextAttemptAt: number;
    delayUntil?: number;
}

export interface QueueRule {
    commandIndex: number;
    requestedAt: number;
    actionId: string;
    totalIterations: number;
    completedIterations: number;
    actorSelectors?: string[];
    actorResourceNodeIds?: string[];
    actorResourceNodeSelectors?: string[];
    nextAttemptAt: number;
    delayUntil?: number;
    lastBlockedReason?: "NO_ACTORS" | "INSUFFICIENT_RESOURCES" | "POP_CAP";
}

export interface TriggerRule {
    trigger: TriggerCondition;
    mode: TriggerMode;
    command: BuildOrderCommand;
    sourceCommandIndex: number;
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
    entityTypeCounters: Record<string, number>;
    resourceNodeCounter: number;
    activeModifiers: NumericModifier[];
    resourceTimeline: SimulationResult["resourceTimeline"];
    entityCountTimeline: SimulationResult["entityCountTimeline"];
    entityTimelines: Record<string, EntityTimeline>;
    eventLogs: SimulationResult["eventLogs"];
    currentActivities: Record<string, Omit<EntityActivitySegment, "end">>;
    queueRules: QueueRule[];
    autoQueueRules: AutoQueueRule[];
    spawnGatherRules: Record<string, { resourceNodeIds?: string[]; resourceNodeSelectors?: string[] }>;
    triggerRules: TriggerRule[];
    humanDelays: Record<string, HumanDelayBucket[]>;
    actionClickTimes: Record<string, number[]>;
    actionCompletionTimes: Record<string, number[]>;
    nodeDepletionTimes: Record<string, number>;
}

function formatActivityTarget(kind: EntityActivitySegment["kind"], detail: string): string {
    if (kind === "idle") return "idle";
    return `${kind}:${detail}`;
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
        const at = toTick(c.at ?? last);
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
    forceSplit = false,
): void {
    const current = state.currentActivities[entityId];
    if (current && current.kind === kind && current.detail === detail) {
        if (!forceSplit) return;
        const timeline = state.entityTimelines[entityId];
        if (timeline && current.start <= state.now + EPS) {
            timeline.segments.push({ ...current, end: state.now });
        }
        state.currentActivities[entityId] = { start: state.now, kind, detail };
        return;
    }

    if (current) {
        const timeline = state.entityTimelines[entityId];
        if (timeline && current.start < state.now - EPS) {
            timeline.segments.push({ ...current, end: state.now });
        }
    }

    state.currentActivities[entityId] = { start: state.now, kind, detail };
    state.eventLogs.push({ time: state.now, entityId, to: formatActivityTarget(kind, detail) });
}

export function findNextEventTime(events: ScheduledEvent[], now: number): number | undefined {
    let next: number | undefined;
    for (const e of events) {
        if (e.time <= now + EPS) continue;
        if (next === undefined || e.time < next) next = e.time;
    }
    return next;
}
