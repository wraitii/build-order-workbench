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
  duration: number;
  taskType?: string;
  many_workers?: "aoe2" | { model: "aoe2"; additionalWorkerRate?: number };
  costs?: ResourceMap;
  creates?: Record<string, number>;
  createsResourceNodes?: ResourceNodeCreateSpec[];
  resourceDeltaOnComplete?: ResourceMap;
  modifiersOnComplete?: NumericModifier[];
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

export interface GameData {
  resources: string[];
  startingResources: ResourceMap;
  startingEntities: StartingEntity[];
  entities: Record<string, EntityDef>;
  resourceNodePrototypes: Record<string, ResourceNodeDef>;
  startingResourceNodes: StartingResourceNode[];
  startingModifiers?: NumericModifier[];
  taskEfficiency?: TaskEfficiencyConfig;
  population?: PopulationConfig;
  actions: Record<string, ActionDef>;
}

export interface QueueActionCommand {
  type: "queueAction";
  at?: number;
  after?: string;
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
  after?: string;
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
  after?: string;
  afterEntityId?: string;
  resourceNodeIds?: string[];
  resourceNodeSelectors?: string[];
}

export interface AutoQueueCommand {
  type: "autoQueue";
  at?: number;
  after?: string;
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
  after?: string;
  afterEntityId?: string;
  actionId: string;
  actorType?: string;
  actorResourceNodeIds?: string[];
  actorResourceNodeSelectors?: string[];
}

export interface SetSpawnGatherCommand {
  type: "setSpawnGather";
  at?: number;
  after?: string;
  afterEntityId?: string;
  entityType: string;
  resourceNodeIds?: string[];
  resourceNodeSelectors?: string[];
}

export type TriggerCondition =
  | { kind: "completed"; actionId: string }
  | { kind: "depleted"; resourceNodeSelector: string }
  | { kind: "exhausted"; resourceNodeSelector: string };

export type TriggerExecutableCommand =
  | QueueActionCommand
  | AssignGatherCommand
  | AssignEventGatherCommand
  | AutoQueueCommand
  | StopAutoQueueCommand
  | SetSpawnGatherCommand;

export interface OnTriggerCommand {
  type: "onTrigger";
  at?: number;
  after?: string;
  afterEntityId?: string;
  trigger: TriggerCondition;
  command: TriggerExecutableCommand;
}

export type BuildOrderCommand =
  | TriggerExecutableCommand
  | OnTriggerCommand;

export interface BuildOrderInput {
  evaluationTime: number;
  debtFloor?: number;
  startingResources?: ResourceMap;
  startingEntities?: Record<string, number>;
  humanDelays?: Record<string, HumanDelayBucket[]>;
  commands: BuildOrderCommand[];
}

export interface HumanDelayBucket {
  chance: number;
  minSeconds: number;
  maxSeconds: number;
}

export interface SimOptions {
  evaluationTime: number;
  debtFloor: number;
  strict: boolean;
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
    | "INVALID_ASSIGNMENT"
    | "HOUSED"
    | "INSUFFICIENT_RESOURCES"
    | "NEGATIVE_RESOURCE"
    | "RESOURCE_STALL";
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
  scenarioScore: number;
  maxDebt: number;
  totalDelays: number;
  completedActions: number;
  violations: Violation[];
  commandResults: CommandResult[];
  resourceTimeline: ResourceTimelineInterval[];
  entityCountTimeline: EntityCountPoint[];
  entityTimelines: Record<string, EntityTimeline>;
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
