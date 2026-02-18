import { describe, expect, test } from "bun:test";
import { parseBuildOrderDsl } from "../src/dsl";
import { runSimulation } from "../src/sim";
import { GameData } from "../src/types";

const TEST_GAME: GameData = {
  resources: ["food", "wood", "gold", "stone", "pop"],
  startingResources: { food: 200, wood: 200, gold: 100, stone: 200 },
  startingEntities: [
    { entityType: "town_center", count: 1 },
    { entityType: "villager", count: 3 },
    { entityType: "house", count: 2 },
  ],
  entities: {
    villager: { id: "villager", name: "Villager", kind: "unit" },
    town_center: { id: "town_center", name: "Town Center", kind: "building" },
    house: { id: "house", name: "House", kind: "building" },
  },
  resourceNodePrototypes: {
    sheep: {
      id: "sheep",
      name: "Sheep",
      produces: "food",
      rateByEntityType: { villager: 1 },
      maxWorkers: 8,
      stock: 10000,
      tags: ["food"],
    },
    forest: {
      id: "forest",
      name: "Forest",
      produces: "wood",
      rateByEntityType: { villager: 1 },
      tags: ["wood", "woodcutting"],
    },
    straggler_trees: {
      id: "straggler_trees",
      name: "Straggler Trees",
      produces: "wood",
      rateByEntityType: { villager: 1 },
      tags: ["wood", "woodcutting", "straggler"],
    },
    boar_lured: {
      id: "boar_lured",
      name: "Lured Boar",
      produces: "food",
      rateByEntityType: { villager: 1 },
      maxWorkers: 8,
      stock: 3,
      tags: ["food", "boar_lured"],
    },
    farm_patch: {
      id: "farm_patch",
      name: "Farm Patch",
      produces: "food",
      rateByEntityType: { villager: 1 },
      maxWorkers: 1,
      stock: 10,
      tags: ["food", "farm"],
    },
  },
  startingResourceNodes: [{ prototypeId: "sheep", count: 1 }, { prototypeId: "forest", count: 1 }, { prototypeId: "straggler_trees", count: 1 }],
  population: {
    resource: "pop",
    providedByEntityType: {
      town_center: 5,
      house: 5,
    },
    consumedByEntityType: {
      villager: 1,
    },
    floor: 0,
  },
  actions: {
    build_house_plain: {
      id: "build_house_plain",
      name: "Build House Plain",
      actorTypes: ["villager"],
      taskType: "build",
      duration: 24,
      costs: { wood: 25 },
      creates: { house: 1 },
    },
    build_house_aoe2: {
      id: "build_house_aoe2",
      name: "Build House AOE2",
      actorTypes: ["villager"],
      taskType: "build",
      duration: 24,
      many_workers: "aoe2",
      costs: { wood: 25 },
      creates: { house: 1 },
    },
    train_villager: {
      id: "train_villager",
      name: "Train Villager",
      actorTypes: ["town_center"],
      taskType: "train",
      duration: 25,
      costs: { food: 50, pop: 1 },
      creates: { villager: 1 },
    },
    lure_boar: {
      id: "lure_boar",
      name: "Lure Boar",
      actorTypes: ["villager"],
      duration: 1,
      createsResourceNodes: [{ prototypeId: "boar_lured", count: 1 }],
    },
    build_farm: {
      id: "build_farm",
      name: "Build Farm",
      actorTypes: ["villager"],
      duration: 1,
      costs: { wood: 0 },
      createsResourceNodes: [{ prototypeId: "farm_patch", count: 1 }],
    },
    expensive_build: {
      id: "expensive_build",
      name: "Expensive Build",
      actorTypes: ["villager"],
      duration: 1,
      costs: { wood: 80 },
      creates: { house: 1 },
    },
  },
};

describe("DSL parsing", () => {
  test("parses mixed queue selectors with IDs and types", () => {
    const build = parseBuildOrderDsl(`
evaluation 30
at 0 queue build_house_aoe2 using villager 1, villager
`);
    const queue = build.commands.find((c) => c.type === "queueAction");
    expect(queue?.type).toBe("queueAction");
    if (!queue || queue.type !== "queueAction") return;
    expect(queue.actorSelectors).toEqual(["villager-1", "villager"]);
  });

  test("parses assign x-count and numeric-id modes", () => {
    const countMode = parseBuildOrderDsl(`
evaluation 30
at 0 assign villager x3 to food
`);
    const idMode = parseBuildOrderDsl(`
evaluation 30
at 0 assign villager 3 to food
`);

    const assignCount = countMode.commands.find((c) => c.type === "assignGather");
    const assignId = idMode.commands.find((c) => c.type === "assignGather");
    expect(assignCount?.type).toBe("assignGather");
    expect(assignId?.type).toBe("assignGather");
    if (!assignCount || assignCount.type !== "assignGather" || !assignId || assignId.type !== "assignGather") return;

    expect(assignCount.count).toBe(3);
    expect(assignCount.actorSelectors).toBeUndefined();
    expect(assignId.count).toBeUndefined();
    expect(assignId.actorSelectors).toEqual(["villager-3"]);
  });

  test("parses after entity spawn condition", () => {
    const build = parseBuildOrderDsl(`
evaluation 120
at 0 after villager 7 spawn-assign villager to food
`);
    const cmd = build.commands[0];
    expect(cmd?.type).toBe("setSpawnGather");
    if (!cmd || cmd.type !== "setSpawnGather") return;
    expect(cmd.afterEntityId).toBe("villager-7");
  });

  test("parses after shorthand without at-time", () => {
    const build = parseBuildOrderDsl(`
evaluation 120
after villager 7 assign villager 7 to food
`);
    const cmd = build.commands[0];
    expect(cmd?.type).toBe("assignGather");
    if (!cmd || cmd.type !== "assignGather") return;
    expect(cmd.at).toBe(0);
    expect(cmd.afterEntityId).toBe("villager-7");
    expect(cmd.actorSelectors).toEqual(["villager-7"]);
  });

  test("parses bare directive shorthand", () => {
    const build = parseBuildOrderDsl(`
evaluation 120
assign villager 4 to food
`);
    const cmd = build.commands[0];
    expect(cmd?.type).toBe("assignGather");
    if (!cmd || cmd.type !== "assignGather") return;
    expect(cmd.at).toBe(0);
    expect(cmd.actorSelectors).toEqual(["villager-4"]);
  });

  test("parses auto-queue from resource node selectors", () => {
    const build = parseBuildOrderDsl(`
evaluation 120
at 0 auto-queue build_farm using villager from straggler_trees
`);
    const cmd = build.commands[0];
    expect(cmd?.type).toBe("autoQueue");
    if (!cmd || cmd.type !== "autoQueue") return;
    expect(cmd.actorType).toBe("villager");
    expect(cmd.actorResourceNodeSelectors).toEqual(["proto:straggler_trees"]);
  });

  test("parses auto-queue from mixed selectors including idle", () => {
    const build = parseBuildOrderDsl(`
evaluation 120
at 0 auto-queue build_farm using villager from straggler_trees idle
`);
    const cmd = build.commands[0];
    expect(cmd?.type).toBe("autoQueue");
    if (!cmd || cmd.type !== "autoQueue") return;
    expect(cmd.actorType).toBe("villager");
    expect(cmd.actorResourceNodeSelectors).toEqual(["proto:straggler_trees", "actor:idle"]);
  });

  test("parses after completed trigger with assign event context", () => {
    const build = parseBuildOrderDsl(`
evaluation 120
after completed build_farm assign to created
`);
    const cmd = build.commands[0];
    expect(cmd?.type).toBe("onTrigger");
    if (!cmd || cmd.type !== "onTrigger") return;
    expect(cmd.trigger.kind).toBe("completed");
    if (cmd.trigger.kind !== "completed") return;
    expect(cmd.trigger.actionId).toBe("build_farm");
    expect(cmd.command.type).toBe("assignEventGather");
    if (cmd.command.type !== "assignEventGather") return;
    expect(cmd.command.resourceNodeSelectors).toEqual(["id:created"]);
  });

  test("parses after clicked trigger", () => {
    const build = parseBuildOrderDsl(`
evaluation 120
after clicked build_farm assign villager 1 to sheep
`);
    const cmd = build.commands[0];
    expect(cmd?.type).toBe("onTrigger");
    if (!cmd || cmd.type !== "onTrigger") return;
    expect(cmd.trigger.kind).toBe("clicked");
    if (cmd.trigger.kind !== "clicked") return;
    expect(cmd.trigger.actionId).toBe("build_farm");
  });

  test("parses after exhausted trigger", () => {
    const build = parseBuildOrderDsl(`
evaluation 120
after exhausted sheep assign villager all from sheep to straggler_trees
`);
    const cmd = build.commands[0];
    expect(cmd?.type).toBe("onTrigger");
    if (!cmd || cmd.type !== "onTrigger") return;
    expect(cmd.trigger.kind).toBe("exhausted");
    if (cmd.trigger.kind !== "exhausted") return;
    expect(cmd.trigger.resourceNodeSelector).toBe("proto:sheep");
    expect(cmd.command.type).toBe("assignGather");
  });

  test("parses human-delay buckets", () => {
    const build = parseBuildOrderDsl(`
evaluation 60
human-delay train_villager 0.85 0 1.5
human-delay train_villager 0.1 2 5
`);

    expect(build.humanDelays).toEqual({
      train_villager: [
        { chance: 0.85, minSeconds: 0, maxSeconds: 1.5 },
        { chance: 0.1, minSeconds: 2, maxSeconds: 5 },
      ],
    });
  });

  test("rejects human-delay chance totals above one per action", () => {
    expect(() => parseBuildOrderDsl(`
evaluation 60
human-delay train_villager 0.8 0 1
human-delay train_villager 0.3 2 3
`)).toThrow("cannot exceed 1");
  });
});

describe("start with", () => {
  test("replaces default starting entities", () => {
    const build = parseBuildOrderDsl(`
evaluation 0
start with town_center,villager
`);
    const result = runSimulation(TEST_GAME, build, {
      strict: false,
      evaluationTime: build.evaluationTime,
      debtFloor: -30,
    });

    expect(result.entitiesByType).toEqual({
      town_center: 1,
      villager: 1,
    });
  });
});

describe("many_workers", () => {
  test("aoe2 worker scaling speeds up with two workers", () => {
    const plain = parseBuildOrderDsl(`
evaluation 30
start with villager,villager
at 0 queue build_house_plain using villager,villager
`);
    const aoe2 = parseBuildOrderDsl(`
evaluation 30
start with villager,villager
at 0 queue build_house_aoe2 using villager,villager
`);

    const plainResult = runSimulation(TEST_GAME, plain, {
      strict: false,
      evaluationTime: plain.evaluationTime,
      debtFloor: -30,
    });
    const aoe2Result = runSimulation(TEST_GAME, aoe2, {
      strict: false,
      evaluationTime: aoe2.evaluationTime,
      debtFloor: -30,
    });

    expect(plainResult.completedActions).toBe(0);
    expect(aoe2Result.completedActions).toBe(1);
  });

  test("task efficiency override by task type is applied", () => {
    const build = parseBuildOrderDsl(`
evaluation 25
start with villager
at 0 queue build_house_plain
`);

    const overriddenGame: GameData = {
      ...TEST_GAME,
      taskEfficiency: {
        default: 1.4,
        byTaskType: {
          build: 1.0,
        },
      },
    };

    const result = runSimulation(overriddenGame, build, {
      strict: false,
      evaluationTime: build.evaluationTime,
      debtFloor: -30,
    });

    expect(result.completedActions).toBe(1);
  });
});

describe("after directives", () => {
  test("after clicked trigger runs on action start", () => {
    const build = parseBuildOrderDsl(`
evaluation 2
start with villager,villager
after clicked lure_boar assign villager 2 to forest
at 0 queue lure_boar using villager 1
`);

    const result = runSimulation(TEST_GAME, build, {
      strict: false,
      evaluationTime: build.evaluationTime,
      debtFloor: -30,
    });

    const villager2 = result.entityTimelines["villager-2"];
    const gathersForestAtStart = villager2?.segments.some((s) => s.kind === "gather" && s.detail === "wood:forest" && s.start === 0);
    expect(gathersForestAtStart).toBe(true);
  });

  test("score time clicked tracks action start time", () => {
    const build = parseBuildOrderDsl(`
evaluation 5
start with villager
score time clicked lure_boar
score time clicked lure_boar x2
at 0 queue lure_boar x2 using villager 1
`);

    const result = runSimulation(TEST_GAME, build, {
      strict: false,
      evaluationTime: build.evaluationTime,
      debtFloor: -30,
    });

    expect(result.scores[0]?.value).toBe(0);
    expect(result.scores[1]?.value).toBe(1);
  });

  test("deferred commands do not shift same-timestamp command registration", () => {
    const build = parseBuildOrderDsl(`
evaluation 50
start with town_center,villager,villager,villager
at 0 queue build_house_plain using villager,villager
at 0 after houses assign villager 1 to food
at 0 auto-queue train_villager using town_center
`);

    const result = runSimulation(TEST_GAME, build, {
      strict: false,
      evaluationTime: build.evaluationTime,
      debtFloor: -30,
    });

    const autoQueueResult = result.commandResults.find((c) => c.type === "autoQueue");
    expect(autoQueueResult).toBeDefined();
    expect(autoQueueResult?.startedAt).toBe(0);
    expect(autoQueueResult?.delayedBy).toBe(0);
  });

  test("after villager N sets spawn-assign rule without retroactive immediate assign", () => {
    const build = parseBuildOrderDsl(`
evaluation 90
start with town_center,villager,villager,villager
at 0 auto-queue train_villager using town_center
at 0 after villager 5 spawn-assign villager to food
`);

    const result = runSimulation(TEST_GAME, build, {
      strict: false,
      evaluationTime: build.evaluationTime,
      debtFloor: -30,
    });

    const spawnAssignResult = result.commandResults.find((c) => c.type === "setSpawnGather");
    expect(spawnAssignResult).toBeDefined();
    expect(spawnAssignResult?.startedAt).toBe(70);

    const villager5 = result.entityTimelines["villager-5"];
    expect(villager5).toBeDefined();
    const gatheredAt70 = villager5?.segments.some((s) => s.kind === "gather" && s.start === 70);
    expect(gatheredAt70).toBe(false);
  });

  test("assign villager N implicitly waits for spawn when unit is not present yet", () => {
    const build = parseBuildOrderDsl(`
evaluation 90
start with town_center,villager,villager,villager
at 0 auto-queue train_villager using town_center
at 0 assign villager 5 to food
`);

    const result = runSimulation(TEST_GAME, build, {
      strict: false,
      evaluationTime: build.evaluationTime,
      debtFloor: -30,
    });

    const assignResult = result.commandResults.find((c) => c.type === "assignGather");
    expect(assignResult).toBeDefined();
    expect(assignResult?.status).toBe("scheduled");
    expect(assignResult?.startedAt).toBe(70);
  });

  test("lure boar pulls sheep villagers, then returns them to sheep on depletion", () => {
    const build = parseBuildOrderDsl(`
evaluation 10
start with villager,villager,villager
after completed lure_boar assign villager all from sheep to boar_lured
after completed lure_boar assign to boar_lured
after depleted boar_lured assign to sheep
assign villager 1 to sheep
assign villager 2 to sheep
assign villager 3 to sheep
at 0 queue lure_boar using villager 1
`);

    const result = runSimulation(TEST_GAME, build, {
      strict: false,
      evaluationTime: build.evaluationTime,
      debtFloor: -30,
    });

    const v2 = result.entityTimelines["villager-2"];
    const v1 = result.entityTimelines["villager-1"];
    expect(v2).toBeDefined();
    expect(v1).toBeDefined();
    const lurerOnBoar = v1?.segments.some((s) => s.kind === "gather" && s.detail === "food:boar_lured");
    const hadBoarPhase = v2?.segments.some((s) => s.kind === "gather" && s.detail === "food:boar_lured");
    const returnedToSheep = v2?.segments.some((s) => s.kind === "gather" && s.detail === "food:sheep" && s.start >= 2);
    expect(lurerOnBoar).toBe(true);
    expect(hadBoarPhase).toBe(true);
    expect(returnedToSheep).toBe(true);
  });

  test("auto-queue from straggler only uses straggler villagers and moves builder to farm", () => {
    const build = parseBuildOrderDsl(`
evaluation 6
start with villager,villager
after completed build_farm assign to created
assign villager 1 to straggler_trees
assign villager 2 to forest
at 0 auto-queue build_farm using villager from straggler_trees
`);

    const result = runSimulation(TEST_GAME, build, {
      strict: false,
      evaluationTime: build.evaluationTime,
      debtFloor: -30,
    });

    const villager1 = result.entityTimelines["villager-1"];
    const villager2 = result.entityTimelines["villager-2"];
    const v1Farm = villager1?.segments.some((s) => s.kind === "gather" && s.detail === "food:farm_patch");
    const v2Farm = villager2?.segments.some((s) => s.kind === "gather" && s.detail === "food:farm_patch");
    expect(v1Farm).toBe(true);
    expect(v2Farm).toBe(false);
  });

  test("auto-queue from straggler plus idle can pick idle villagers", () => {
    const build = parseBuildOrderDsl(`
evaluation 4
start with villager,villager
after completed build_farm assign to created
at 0 auto-queue build_farm using villager from straggler_trees idle
`);

    const result = runSimulation(TEST_GAME, build, {
      strict: false,
      evaluationTime: build.evaluationTime,
      debtFloor: -30,
    });

    const villager1 = result.entityTimelines["villager-1"];
    const villager2 = result.entityTimelines["villager-2"];
    const v1Farm = villager1?.segments.some((s) => s.kind === "gather" && s.detail === "food:farm_patch");
    const v2Farm = villager2?.segments.some((s) => s.kind === "gather" && s.detail === "food:farm_patch");
    expect(v1Farm).toBe(true);
    expect(v2Farm).toBe(true);
  });

  test("after completed queue reuses completion actor when compatible", () => {
    const build = parseBuildOrderDsl(`
evaluation 5
start with villager,villager
at 0 queue lure_boar using villager 2
after completed lure_boar queue lure_boar
`);

    const result = runSimulation(TEST_GAME, build, {
      strict: false,
      evaluationTime: build.evaluationTime,
      debtFloor: -30,
    });

    const villager1 = result.entityTimelines["villager-1"];
    const villager2 = result.entityTimelines["villager-2"];
    const v1LureActions = villager1?.segments.filter((s) => s.kind === "action" && s.detail === "lure_boar").length ?? 0;
    const v2LureActions = villager2?.segments.filter((s) => s.kind === "action" && s.detail === "lure_boar").length ?? 0;
    expect(v1LureActions).toBe(0);
    expect(v2LureActions).toBeGreaterThanOrEqual(2);
  });

  test("deferred setup runs before same-timestamp automation", () => {
    const build = parseBuildOrderDsl(`
evaluation 50
start with town_center,villager,villager,villager,villager
at 0 assign villager 1 to forest
at 0 auto-queue train_villager using town_center
at 0 after villager 5 assign villager 1 to straggler_trees
at 0 after villager 5 auto-queue build_farm using villager from straggler_trees
`);

    const result = runSimulation(TEST_GAME, build, {
      strict: false,
      evaluationTime: build.evaluationTime,
      debtFloor: -30,
    });

    const villager1 = result.entityTimelines["villager-1"];
    const firstFarmAction = villager1?.segments.find((s) => s.kind === "action" && s.detail === "build_farm");
    expect(firstFarmAction?.start).toBe(35);
  });

  test("same-timestamp multi-completion applies farm assignment trigger for each builder", () => {
    const build = parseBuildOrderDsl(`
evaluation 4
start with villager,villager
after completed build_farm assign to created
assign villager 1 to straggler_trees
assign villager 2 to straggler_trees
at 0 auto-queue build_farm using villager from straggler_trees
`);

    const result = runSimulation(TEST_GAME, build, {
      strict: false,
      evaluationTime: build.evaluationTime,
      debtFloor: -30,
    });

    const villager1 = result.entityTimelines["villager-1"];
    const villager2 = result.entityTimelines["villager-2"];
    const v1FarmGather = villager1?.segments.some((s) => s.kind === "gather" && s.detail === "food:farm_patch");
    const v2FarmGather = villager2?.segments.some((s) => s.kind === "gather" && s.detail === "food:farm_patch");
    expect(v1FarmGather).toBe(true);
    expect(v2FarmGather).toBe(true);
  });

  test("depleted and exhausted triggers both apply at final sheep depletion in declaration order", () => {
    const lowSheepGame: GameData = {
      ...TEST_GAME,
      resourceNodePrototypes: {
        ...TEST_GAME.resourceNodePrototypes,
        sheep: {
          ...TEST_GAME.resourceNodePrototypes.sheep,
          stock: 1,
          maxWorkers: 1,
        },
      },
      startingResourceNodes: [{ prototypeId: "sheep", count: 1 }, { prototypeId: "forest", count: 1 }, { prototypeId: "straggler_trees", count: 1 }],
    };
    const build = parseBuildOrderDsl(`
evaluation 5
start with villager
assign villager 1 to sheep
after depleted sheep assign to straggler_trees
after exhausted sheep assign to forest
`);

    const result = runSimulation(lowSheepGame, build, {
      strict: false,
      evaluationTime: build.evaluationTime,
      debtFloor: -30,
    });

    const villager1 = result.entityTimelines["villager-1"];
    const endsOnForest = villager1?.segments.some((s) => s.kind === "gather" && s.detail === "wood:forest");
    expect(endsOnForest).toBe(true);
  });

  test("resource-waiting queue command does not pause unrelated auto-queue", () => {
    const build = parseBuildOrderDsl(`
evaluation 120
start with town_center,villager
starting-resource wood 0
assign villager 1 to forest
at 0 auto-queue train_villager using town_center
at 1 queue expensive_build using villager 1
`);

    const result = runSimulation(TEST_GAME, build, {
      strict: false,
      evaluationTime: build.evaluationTime,
      debtFloor: -30,
    });

    const tc = result.entityTimelines["town_center-1"];
    expect(tc).toBeDefined();
    const trainStarts = tc?.segments
      .filter((s) => s.kind === "action" && s.detail === "train_villager")
      .map((s) => s.start) ?? [];

    expect(trainStarts).toContain(0);
    expect(trainStarts).toContain(35);
    expect(trainStarts).toContain(70);
    expect(trainStarts).toContain(105);
  });

  test("actor-waiting queue command does not pause unrelated auto-queue at same tick", () => {
    const build = parseBuildOrderDsl(`
evaluation 160
start with town_center,villager,villager,villager,house,house
assign villager 1 to sheep
assign villager 2 to sheep
assign villager 3 to sheep
at 0 auto-queue train_villager using town_center
at 0 after villager 5 queue build_house_plain x2 using villager 1
`);

    const result = runSimulation(TEST_GAME, build, {
      strict: false,
      evaluationTime: build.evaluationTime,
      debtFloor: -30,
    });

    const tc = result.entityTimelines["town_center-1"];
    expect(tc).toBeDefined();
    const trainStarts = tc?.segments
      .filter((s) => s.kind === "action" && s.detail === "train_villager")
      .map((s) => s.start) ?? [];

    expect(trainStarts).toContain(0);
    expect(trainStarts).toContain(35);
    expect(trainStarts).toContain(70);
  });

  test("warns when a command spend crosses a resource below zero", () => {
    const build = parseBuildOrderDsl(`
evaluation 5
start with villager
starting-resource wood 10
at 0 queue build_house_plain using villager 1
`);

    const result = runSimulation(TEST_GAME, build, {
      strict: false,
      evaluationTime: build.evaluationTime,
      debtFloor: -30,
    });

    const debtWarning = result.violations.find((v) => v.code === "NEGATIVE_RESOURCE");
    expect(debtWarning).toBeDefined();
    expect(debtWarning?.message.includes("build_house_plain")).toBe(true);
    expect(debtWarning?.message.includes("wood")).toBe(true);
  });

  test("population cap blocks extra training without allowing debt", () => {
    const build = parseBuildOrderDsl(`
evaluation 80
start with town_center,villager,villager,villager,villager
at 0 queue train_villager x2 using town_center
`);

    const result = runSimulation(TEST_GAME, build, {
      strict: false,
      evaluationTime: build.evaluationTime,
      debtFloor: -30,
    });

    expect(result.entitiesByType.villager).toBe(5);
    const popStall = result.violations.find((v) => v.code === "HOUSED" && v.message.includes("population capacity"));
    expect(popStall).toBeDefined();
  });

  test("auto-queue retries after house completion unlocks population", () => {
    const build = parseBuildOrderDsl(`
evaluation 70
start with town_center,villager,villager,villager,villager,villager
at 0 auto-queue train_villager using town_center
at 0 queue build_house_plain using villager 1
`);

    const result = runSimulation(TEST_GAME, build, {
      strict: false,
      evaluationTime: build.evaluationTime,
      debtFloor: -30,
    });

    const tc = result.entityTimelines["town_center-1"];
    expect(tc).toBeDefined();
    const trainStarts = tc?.segments
      .filter((s) => s.kind === "action" && s.detail === "train_villager")
      .map((s) => s.start) ?? [];
    expect(trainStarts).toContain(34);
  });

  test("human-delay in DSL adds idle gap between auto-queued villager trains", () => {
    const build = parseBuildOrderDsl(`
evaluation 120
human-delay train_villager 1 10 10
at 0 auto-queue train_villager using town_center
`);

    const result = runSimulation(TEST_GAME, build, {
      strict: false,
      evaluationTime: build.evaluationTime,
      debtFloor: -30,
    });

    const tc = result.entityTimelines["town_center-1"];
    const trainStarts = tc?.segments
      .filter((s) => s.kind === "action" && s.detail === "train_villager")
      .map((s) => s.start) ?? [];
    expect(trainStarts).toEqual([0, 45, 90]);
  });
});
