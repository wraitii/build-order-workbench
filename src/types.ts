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
  costs?: ResourceMap;
  creates?: Record<string, number>;
  createsResourceNodes?: ResourceNodeCreateSpec[];
  resourceDeltaOnComplete?: ResourceMap;
  modifiersOnComplete?: NumericModifier[];
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
  actions: Record<string, ActionDef>;
}

export interface QueueActionCommand {
  type: "queueAction";
  at?: number;
  actionId: string;
  count?: number;
  actorType?: string;
  actorIds?: string[];
}

export interface AssignGatherCommand {
  type: "assignGather";
  at?: number;
  count: number;
  actorType: string;
  resourceNodeIds?: string[];
  resourceNodeSelectors?: string[];
}

export interface AutoQueueCommand {
  type: "autoQueue";
  at?: number;
  actionId: string;
  actorType?: string;
  actorIds?: string[];
  retryEvery?: number;
  until?: number;
  maxRuns?: number;
}

export interface SetSpawnGatherCommand {
  type: "setSpawnGather";
  at?: number;
  entityType: string;
  resourceNodeIds?: string[];
  resourceNodeSelectors?: string[];
}

export interface ShiftGatherCommand {
  type: "shiftGather";
  at?: number;
  count: number;
  actorType: string;
  fromResourceNodeIds?: string[];
  fromResourceNodeSelectors?: string[];
  resourceNodeIds?: string[];
  resourceNodeSelectors?: string[];
}

export type BuildOrderCommand =
  | QueueActionCommand
  | AssignGatherCommand
  | AutoQueueCommand
  | SetSpawnGatherCommand
  | ShiftGatherCommand;

export interface BuildOrderInput {
  evaluationTime: number;
  debtFloor?: number;
  commands: BuildOrderCommand[];
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
    | "INSUFFICIENT_RESOURCES"
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
