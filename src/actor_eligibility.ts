import { matchesNodeSelector } from "./node_selectors";
import { EPS, SimState, compareEntityIdNatural } from "./sim_shared";
import { EntityInstance } from "./types";

const ENTITY_ID_PATTERN = /^(.*)-(\d+)$/;

export interface ActorEligibilityRequest {
    actorTypes: string[];
    actorCount: number;
    actorSelectors?: string[];
    actorResourceNodeIds?: string[];
    actorResourceNodeSelectors?: string[];
    idleOnly: boolean;
}

interface ActorNodeFilter {
    hasFilter: boolean;
    allowedNodeIds: Set<string> | undefined;
    allowIdle: boolean;
    nodePriorityById: Map<string, number> | undefined;
    idlePriority: number | undefined;
}

function resolveAllowedActorNodeIds(
    state: SimState,
    actorResourceNodeIds?: string[],
    actorResourceNodeSelectors?: string[],
): ActorNodeFilter {
    let allowIdle = false;
    const hasFilter =
        (actorResourceNodeIds && actorResourceNodeIds.length > 0) ||
        (actorResourceNodeSelectors && actorResourceNodeSelectors.length > 0);
    if (
        !(actorResourceNodeIds && actorResourceNodeIds.length > 0) &&
        !(actorResourceNodeSelectors && actorResourceNodeSelectors.length > 0)
    ) {
        return {
            hasFilter: false,
            allowedNodeIds: undefined,
            allowIdle,
            nodePriorityById: undefined,
            idlePriority: undefined,
        };
    }

    const allowedNodeIds = new Set<string>();
    const nodePriorityById = new Map<string, number>();
    let idlePriority: number | undefined;
    let nextPriority = 0;
    for (const id of actorResourceNodeIds ?? []) {
        if (state.resourceNodeById[id]) {
            allowedNodeIds.add(id);
            if (!nodePriorityById.has(id)) nodePriorityById.set(id, nextPriority);
            nextPriority += 1;
        }
    }

    if (actorResourceNodeSelectors && actorResourceNodeSelectors.length > 0) {
        for (const selector of actorResourceNodeSelectors) {
            if (selector === "actor:idle") {
                allowIdle = true;
                if (idlePriority === undefined) idlePriority = nextPriority;
                nextPriority += 1;
                continue;
            }
            const matchedNodeIds: string[] = [];
            for (const node of state.resourceNodes) {
                if (matchesNodeSelector(node, selector)) matchedNodeIds.push(node.id);
            }
            for (const id of matchedNodeIds) {
                allowedNodeIds.add(id);
                if (!nodePriorityById.has(id)) nodePriorityById.set(id, nextPriority);
            }
            nextPriority += 1;
        }
    }

    return {
        hasFilter: Boolean(hasFilter),
        allowedNodeIds: allowedNodeIds.size > 0 ? allowedNodeIds : undefined,
        allowIdle,
        nodePriorityById,
        idlePriority,
    };
}

function isEligibleEntity(
    state: SimState,
    ent: EntityInstance,
    request: ActorEligibilityRequest,
    nodeFilter: ActorNodeFilter,
): boolean {
    if (!request.actorTypes.includes(ent.entityType)) return false;
    if (request.idleOnly && ent.busyUntil > state.now + EPS) return false;
    const { hasFilter, allowedNodeIds, allowIdle } = nodeFilter;
    if (!hasFilter) return true;
    if (!allowedNodeIds) return allowIdle ? !ent.resourceNodeId : false;
    if (!ent.resourceNodeId) return allowIdle;
    return allowedNodeIds.has(ent.resourceNodeId);
}

function entityNodePriority(
    ent: EntityInstance,
    nodeFilter: ActorNodeFilter,
): number {
    if (!nodeFilter.hasFilter) return Number.POSITIVE_INFINITY;
    if (!ent.resourceNodeId) return nodeFilter.idlePriority ?? Number.POSITIVE_INFINITY;
    return nodeFilter.nodePriorityById?.get(ent.resourceNodeId) ?? Number.POSITIVE_INFINITY;
}

function compareEligibleEntities(
    a: EntityInstance,
    b: EntityInstance,
    request: ActorEligibilityRequest,
    nodeFilter: ActorNodeFilter,
): number {
    // Respect explicit selector/filter order first for both queue (idleOnly=true)
    // and assign (idleOnly=false) flows.
    if (nodeFilter.hasFilter) {
        const pa = entityNodePriority(a, nodeFilter);
        const pb = entityNodePriority(b, nodeFilter);
        if (pa !== pb) return pa - pb;
    }
    if (!request.idleOnly && a.busyUntil !== b.busyUntil) return a.busyUntil - b.busyUntil;
    return compareEntityIdNatural(a.id, b.id);
}

function selectBySelectors(
    state: SimState,
    request: ActorEligibilityRequest,
    nodeFilter: ActorNodeFilter,
): EntityInstance[] {
    const picked: EntityInstance[] = [];
    const used = new Set<string>();

    for (const selector of request.actorSelectors ?? []) {
        if (ENTITY_ID_PATTERN.test(selector)) {
            const ent = state.entities.find((e) => e.id === selector);
            if (!ent || used.has(ent.id) || !isEligibleEntity(state, ent, request, nodeFilter)) break;
            used.add(ent.id);
            picked.push(ent);
            continue;
        }

        const candidates = state.entities
            .filter(
                (e) => !used.has(e.id) && e.entityType === selector && isEligibleEntity(state, e, request, nodeFilter),
            )
            .sort((a, b) => compareEligibleEntities(a, b, request, nodeFilter));
        const candidate = candidates[0];
        if (!candidate) break;
        used.add(candidate.id);
        picked.push(candidate);
    }

    return picked;
}

export function pickEligibleActorIds(state: SimState, request: ActorEligibilityRequest): string[] {
    const nodeFilter = resolveAllowedActorNodeIds(
        state,
        request.actorResourceNodeIds,
        request.actorResourceNodeSelectors,
    );

    if (request.actorSelectors && request.actorSelectors.length > 0) {
        return selectBySelectors(state, request, nodeFilter).map((ent) => ent.id);
    }

    return state.entities
        .filter((e) => isEligibleEntity(state, e, request, nodeFilter))
        .sort((a, b) => compareEligibleEntities(a, b, request, nodeFilter))
        .slice(0, request.actorCount)
        .map((ent) => ent.id);
}

export function nextEligibleActorAvailabilityTime(
    state: SimState,
    request: Omit<ActorEligibilityRequest, "idleOnly">,
): number {
    const actorSelectors = request.actorSelectors;
    const actorCount = actorSelectors && actorSelectors.length > 0 ? actorSelectors.length : request.actorCount;

    const ids = pickEligibleActorIds(state, {
        ...request,
        actorCount,
        idleOnly: false,
    });

    if (ids.length < actorCount) return Number.POSITIVE_INFINITY;

    let maxBusyUntil = 0;
    for (const id of ids) {
        const ent = state.entities.find((e) => e.id === id);
        if (!ent) return Number.POSITIVE_INFINITY;
        if (ent.busyUntil > maxBusyUntil) maxBusyUntil = ent.busyUntil;
    }
    return maxBusyUntil;
}
