export type ResourceMap = Record<string, number>;
export type ModifierOp = "mul" | "add" | "set";

export interface NumericModifier {
    selector: string;
    op: ModifierOp;
    value: number;
}

export interface EntityDef {
    id: string;
    name: string;
    kind: "unit" | "building";
    actions?: string[];
}

export interface ResourceNodeDef {
    id: string;
    name: string;
    produces: string;
    rateByEntityType: Record<string, number>;
    maxWorkers?: number;
    stock?: number;
    decayRatePerSecond?: number;
    decayStart?: "on_spawn" | "on_first_gather";
    tags?: string[];
}

export interface ResourceNodeCreateSpec {
    prototypeId: string;
    count?: number;
}

export interface ActionDef {
    id: string;
    name: string;
    actorTypes: string[];
    actorCount?: number;
    repeatable?: boolean;
    duration: number;
    taskType?: string;
    many_workers?: "aoe2" | { model: "aoe2"; additionalWorkerRate?: number };
    costs?: ResourceMap;
    creates?: Record<string, number>;
    createsResourceNodes?: ResourceNodeCreateSpec[];
    consumesResourceNodes?: ResourceNodeCreateSpec[];
    resourceDeltaOnComplete?: ResourceMap;
    onClicked?: string[];
    onCompleted?: string[];
}

export interface TaskEfficiencyConfig {
    default?: number;
    byTaskType?: Record<string, number>;
}

export interface PopulationConfig {
    resource: string;
    providedByEntityType: Record<string, number>;
    consumedByEntityType: Record<string, number>;
    floor?: number;
}

export interface StartingEntity {
    entityType: string;
    count: number;
}

export interface StartingResourceNode {
    prototypeId: string;
    count?: number;
}

export interface CivilizationDef {
    name: string;
    dslLines: string[];
}

export interface RulesetDef {
    name: string;
    dslLines: string[];
}

export interface SettingDef {
    dslLines: string[];
}

export interface MarketConfig {
    baseExchangeRateByResource: Record<string, number>;
    rateStep?: number;
    minExchangeRate?: number;
    maxExchangeRate?: number;
    fee?: number;
}

export interface GameData {
    resources: string[];
    startingResources?: ResourceMap;
    startingEntities?: StartingEntity[];
    entities: Record<string, EntityDef>;
    resourceNodePrototypes: Record<string, ResourceNodeDef>;
    startingResourceNodes?: StartingResourceNode[];
    startingModifiers?: NumericModifier[];
    taskEfficiency?: TaskEfficiencyConfig;
    population?: PopulationConfig;
    actions: Record<string, ActionDef>;
    market?: MarketConfig;
    civilizations?: CivilizationDef[];
    ruleset?: RulesetDef;
    settings?: Record<string, SettingDef>;
}

export interface QueueActionCommand {
    type: "queueAction";
    at?: number;
    afterEntityId?: string;
    actionId: string;
    count?: number;
    actorSelectors?: string[];
    actorResourceNodeIds?: string[];
    actorResourceNodeSelectors?: string[];
}

export interface AssignGatherCommand {
    type: "assignGather";
    at?: number;
    afterEntityId?: string;
    actorType: string;
    all?: boolean;
    count?: number;
    actorSelectors?: string[];
    actorResourceNodeIds?: string[];
    actorResourceNodeSelectors?: string[];
    resourceNodeIds?: string[];
    resourceNodeSelectors?: string[];
}

export interface AssignEventGatherCommand {
    type: "assignEventGather";
    at?: number;
    afterEntityId?: string;
    resourceNodeIds?: string[];
    resourceNodeSelectors?: string[];
}

export interface AutoQueueCommand {
    type: "autoQueue";
    at?: number;
    afterEntityId?: string;
    actionId: string;
    actorType?: string;
    actorIds?: string[];
    actorResourceNodeIds?: string[];
    actorResourceNodeSelectors?: string[];
}

export interface StopAutoQueueCommand {
    type: "stopAutoQueue";
    at?: number;
    afterEntityId?: string;
    actionId: string;
    actorType?: string;
    actorResourceNodeIds?: string[];
    actorResourceNodeSelectors?: string[];
}

export interface SetSpawnGatherCommand {
    type: "setSpawnGather";
    at?: number;
    afterEntityId?: string;
    entityType: string;
    resourceNodeIds?: string[];
    resourceNodeSelectors?: string[];
}

export type TriggerCondition =
    | { kind: "clicked"; actionId: string }
    | { kind: "completed"; actionId: string }
    | { kind: "depleted"; resourceNodeSelector: string }
    | { kind: "exhausted"; resourceNodeSelector: string };
export type TriggerMode = "once" | "every";

export interface GrantResourcesCommand {
    type: "grantResources";
    at?: number;
    afterEntityId?: string;
    resources: ResourceMap;
}

export interface SpawnEntitiesCommand {
    type: "spawnEntities";
    at?: number;
    afterEntityId?: string;
    entityType: string;
    count: number;
}

export interface ConsumeResourceNodesCommand {
    type: "consumeResourceNodes";
    at?: number;
    afterEntityId?: string;
    specs: ResourceNodeCreateSpec[];
}

export interface CreateResourceNodesCommand {
    type: "createResourceNodes";
    at?: number;
    afterEntityId?: string;
    specs: ResourceNodeCreateSpec[];
}

export interface AddModifierCommand {
    type: "addModifier";
    at?: number;
    afterEntityId?: string;
    modifier: NumericModifier;
}

export interface TradeResourcesCommand {
    type: "tradeResources";
    at?: number;
    afterEntityId?: string;
    sellResource: string;
    buyResource: string;
    amount: number;
}

export type TriggerExecutableCommand =
    | QueueActionCommand
    | AssignGatherCommand
    | AssignEventGatherCommand
    | AutoQueueCommand
    | StopAutoQueueCommand
    | SetSpawnGatherCommand
    | GrantResourcesCommand
    | SpawnEntitiesCommand
    | ConsumeResourceNodesCommand
    | CreateResourceNodesCommand
    | AddModifierCommand
    | TradeResourcesCommand;

export interface OnTriggerCommand {
    type: "onTrigger";
    at?: number;
    afterEntityId?: string;
    trigger: TriggerCondition;
    triggerMode?: TriggerMode;
    command: BuildOrderCommand;
}

export type BuildOrderCommand = TriggerExecutableCommand | OnTriggerCommand;

export interface BuildOrderInput {
    evaluationTime: number;
    stopAfter?: StopAfterCondition;
    debtFloor?: number;
    startingResources?: ResourceMap;
    startingEntities?: Record<string, number>;
    startingResourceNodes?: Array<{ prototypeId: string; count: number }>;
    humanDelays?: Record<string, HumanDelayBucket[]>;
    scores?: ScoreCriterion[];
    commands: BuildOrderCommand[];
    commandSourceLines?: number[];
}

export interface HumanDelayBucket {
    chance: number;
    minSeconds: number;
    maxSeconds: number;
}

export interface ScoreCriterion {
    method: "time";
    condition: TriggerCondition;
    count?: number; // which occurrence to measure (1 = first, 3 = 3rd, etc.)
}

export interface StopAfterCondition {
    condition: TriggerCondition;
    count?: number;
}

export interface ScoreResult {
    criterion: ScoreCriterion;
    value: number | null; // seconds, null if condition never reached
}

export interface SimOptions {
    evaluationTime: number;
    debtFloor: number;
    strict: boolean;
    captureEventLog?: boolean;
}

export interface EntityInstance {
    id: string;
    entityType: string;
    busyUntil: number;
    resourceNodeId?: string;
}

export interface ResourceNodeInstance {
    id: string;
    prototypeId: string;
    name: string;
    produces: string;
    rateByEntityType: Record<string, number>;
    maxWorkers?: number;
    remainingStock?: number;
    decayRatePerSecond?: number;
    decayStart?: "on_spawn" | "on_first_gather";
    decayActive?: boolean;
    depleted?: boolean;
    tags: string[];
}

export interface ScheduledEvent {
    time: number;
    actionId: string;
    actors: string[];
}

export interface Violation {
    time: number;
    code:
        | "ACTION_NOT_FOUND"
        | "NO_ACTORS"
        | "NO_RESOURCE"
        | "RESOURCE_FULL"
        | "NO_UNIT_AVAILABLE"
        | "INVALID_ASSIGNMENT"
        | "AMBIGUOUS_TRIGGER"
        | "HOUSED"
        | "INSUFFICIENT_RESOURCES"
        | "NEGATIVE_RESOURCE"
        | "RESOURCE_STALL"
        | "DELAYED_ACTION";
    message: string;
}

export interface CommandResult {
    index: number;
    type: BuildOrderCommand["type"];
    requestedAt: number;
    startedAt?: number;
    delayedBy?: number;
    status: "scheduled" | "failed";
    message?: string;
}

export interface SimulationResult {
    initialResources: ResourceMap;
    resourcesAtEvaluation: ResourceMap;
    entitiesByType: Record<string, number>;
    tcIdleTime: number;
    totalVillagerIdleTime: number;
    totalGathered: ResourceMap;
    avgFloat: ResourceMap;
    peakDebt: ResourceMap;
    debtDuration: ResourceMap;
    maxDebt: number;
    completedActions: number;
    violations: Violation[];
    commandResults: CommandResult[];
    resourceTimeline: ResourceTimelineInterval[];
    entityCountTimeline: EntityCountPoint[];
    entityTimelines: Record<string, EntityTimeline>;
    eventLogs: EventLogEntry[];
    scores: ScoreResult[];
}

export interface EventLogEntry {
    time: number;
    entityId: string;
    to: string;
}

export interface ResourceTimelineInterval {
    start: number;
    end: number;
    startResources: ResourceMap;
    gatherRates: ResourceMap;
}

export interface EntityCountPoint {
    time: number;
    entitiesByType: Record<string, number>;
}

export interface EntityActivitySegment {
    start: number;
    end: number;
    kind: "idle" | "gather" | "action";
    detail: string;
}

export interface EntityTimeline {
    entityType: string;
    segments: EntityActivitySegment[];
}
