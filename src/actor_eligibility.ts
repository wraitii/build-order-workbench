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

function resolveAllowedActorNodeIds(
    state: SimState,
    actorResourceNodeIds?: string[],
    actorResourceNodeSelectors?: string[],
): { hasFilter: boolean; allowedNodeIds: Set<string> | undefined; allowIdle: boolean } {
    let allowIdle = false;
    const hasFilter =
        (actorResourceNodeIds && actorResourceNodeIds.length > 0) ||
        (actorResourceNodeSelectors && actorResourceNodeSelectors.length > 0);
    if (
        !(actorResourceNodeIds && actorResourceNodeIds.length > 0) &&
        !(actorResourceNodeSelectors && actorResourceNodeSelectors.length > 0)
    ) {
        return { hasFilter: false, allowedNodeIds: undefined, allowIdle };
    }

    const allowedNodeIds = new Set<string>();
    for (const id of actorResourceNodeIds ?? []) {
        if (state.resourceNodeById[id]) allowedNodeIds.add(id);
    }

    if (actorResourceNodeSelectors && actorResourceNodeSelectors.length > 0) {
        const nodeSelectors = actorResourceNodeSelectors.filter((selector) => {
            if (selector === "actor:idle") {
                allowIdle = true;
                return false;
            }
            return true;
        });
        for (const node of state.resourceNodes) {
            if (nodeSelectors.some((selector) => matchesNodeSelector(node, selector))) {
                allowedNodeIds.add(node.id);
            }
        }
    }

    return {
        hasFilter: Boolean(hasFilter),
        allowedNodeIds: allowedNodeIds.size > 0 ? allowedNodeIds : undefined,
        allowIdle,
    };
}

function isEligibleEntity(
    state: SimState,
    ent: EntityInstance,
    request: ActorEligibilityRequest,
    nodeFilter: { hasFilter: boolean; allowedNodeIds: Set<string> | undefined; allowIdle: boolean },
): boolean {
    if (!request.actorTypes.includes(ent.entityType)) return false;
    if (request.idleOnly && ent.busyUntil > state.now + EPS) return false;
    const { hasFilter, allowedNodeIds, allowIdle } = nodeFilter;
    if (!hasFilter) return true;
    if (!allowedNodeIds) return allowIdle ? !ent.resourceNodeId : false;
    if (!ent.resourceNodeId) return allowIdle;
    return allowedNodeIds.has(ent.resourceNodeId);
}

function selectBySelectors(
    state: SimState,
    request: ActorEligibilityRequest,
    nodeFilter: { hasFilter: boolean; allowedNodeIds: Set<string> | undefined; allowIdle: boolean },
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
            .sort((a, b) => {
                if (!request.idleOnly && a.busyUntil !== b.busyUntil) return a.busyUntil - b.busyUntil;
                return compareEntityIdNatural(a.id, b.id);
            });
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
        .sort((a, b) => {
            if (!request.idleOnly && a.busyUntil !== b.busyUntil) return a.busyUntil - b.busyUntil;
            return compareEntityIdNatural(a.id, b.id);
        })
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
