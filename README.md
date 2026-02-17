# Build Order Simulator

A TypeScript + Bun simulator for RTS build orders (AoE2-style).

It simulates:

- resource income from resource nodes (sheep, boar, berries, forests, farms, etc.)
- action scheduling (train/build/research)
- constraints (producer busy time, resource availability, node depletion, worker caps)

Output includes:

- `scenarioScore` (0-100)
- resource state at time `T`
- violations, delays, and per-entity timeline

## Run

```bash
bun install
bun run sim:aoe2
bun run sim:watch
```

Strict mode:

```bash
bun run sim:strict
```

Custom files:

```bash
bun run src/index.ts --game data/aoe2-game.json --build data/aoe2-scout-build-order.dsl --report out/aoe2-scout-report.html
```

## Data Overview

### Game file

Main fields:

- `resources`
- `startingResources`
- `startingEntities`
- `entities`
- `resourceNodePrototypes`
- `startingResourceNodes`
- `startingModifiers` (optional)
- `taskEfficiency` (optional: default duration multiplier config)
- `population` (optional: population-cap model)
- `actions`

Population model (optional):

- `population.resource` (example: `"pop"`)
- `population.providedByEntityType` (example: `{ "town_center": 5, "house": 5 }`)
- `population.consumedByEntityType` (example: `{ "villager": 1, "scout_cavalry": 1 }`)
- `population.floor` (default `0`; unlike debt-floor, pop is usually hard-capped at 0)

Action effects support:

- `costs`
- `costs.pop` can be used for train actions when `population` is configured
- `duration`
- `taskType` (optional, defaults to `"default"`)
- `many_workers` (optional: `"aoe2"` or `{ "model": "aoe2", "additionalWorkerRate": <number> }`)
- task efficiency multiplier: all actions are multiplied by `1.4` by default; override with `taskEfficiency.default` or `taskEfficiency.byTaskType.<taskType>`
- `many_workers` formula: `t / (1 + (n - 1) * r)` where `t` is 1-worker duration, `n` is worker count, and `r=1/3` for `"aoe2"` (equivalent to `3t/(n+2)`).
- `creates` (entities)
- `createsResourceNodes` (e.g. farms)
- `resourceDeltaOnComplete`
- `modifiersOnComplete`

### Build-order file (DSL only)

Main fields:

- `evaluation <seconds>`
- `debt-floor <value>` (optional)
- `starting-resource <resource> <amount>` (optional, replaces that resource's default start value)
- `start with <entityType>[, <entityType>...]` (optional, replaces default starting entities)
- `human-delay <actionId> <chance> <minSec> <maxSec>` (optional, repeatable weighted buckets; remaining probability is no delay)
- `at <time> ...` directives
- bare directives (no `at`) default to `at 0`

Preamble scope:
- `evaluation`, `debt-floor`, `starting-resource`, and `start with` are global directives for the whole build-order file.
- `start with` replaces all `startingEntities` from game data.

## DSL (strict text format)

You can pass a `.dsl` / `.bo` file directly:

```bash
bun run src/index.ts --game data/aoe2-game.json --build data/aoe2-scout-build-order.dsl
```

Main directives:

- `evaluation <seconds>`
- `debt-floor <value>`
- `starting-resource <resource> <amount>`
- `start with <entityType>[, <entityType>...]` (if present, replaces all default starting entities)
- `human-delay <actionId> <chance> <minSec> <maxSec>` (repeatable; combined chance per action must be <= 1)
- bare directives (no `at`) default to `at 0`
- Optional deferred prefix after `at <t>`:
  `after <label>` (defers execution; for assign it waits for selected workers, otherwise waits for the next task completion event)
  or `after <entityType> <idNum>` / `after <entityType>-<idNum>` (fires as soon as that entity exists)
- Optional trigger prefix:
  `after completed <actionId>`, `after depleted <selector>`, or `after exhausted <selector>`
  (registers a reactive rule that runs the directive whenever the trigger fires)
- `at <t> queue <actionId> [xN] [using <selector>[, <selector>...]]` where selector is `<actorType>`, `<actorType> <n>`, or `<actorType>-<n>`
- Optional actor gather filter on queue/assign/auto-queue/stop-auto-queue: `from <selectors...>` (only actors currently assigned to matching gather nodes are eligible)
- Queue selector examples: `using villager`, `using villager 1`, `using villager 1, villager`, `using villager, villager 2`
- Queue filter example: `at 670 auto-queue build_farm using villager from straggler_trees`
- Assign examples: `assign villager x3 to sheep`, `assign villager 3 to sheep`
- Trigger-context assign: `after completed build_farm assign to created`
- `at <t> assign <actorType> <xN|idNum|all> [from <selectors...>] to <selectors...>`
- `at <t> auto-queue <actionId> [using <actorType>]` (always ASAP, no cap, until stopped)
- `at <t> stop-auto-queue <actionId> [using <actorType>]`
- `at <t> spawn-assign <entityType> to <selector>`

Example: `data/aoe2-scout-build-order.dsl`

`sim:watch` gives a file-watch loop (edit + save).  
`sim:aoe2` writes `out/aoe2-scout-report.html` as a self-contained offline workbench where you can edit DSL and re-run directly in the page.

## Project Files

- `src/sim.ts` - simulation orchestration
- `src/economy.ts` - resource-node economy/depletion
- `src/scheduler.ts` - scheduling + assign logic
- `src/modifiers.ts` - generic numeric modifier system
- `src/report.ts` - text + HTML report output
- `data/aoe2-game.json` - AoE2-focused dataset
- `data/aoe2-scout-build-order.dsl` - AoE2 scout BO example

## Notes

Current model is intentionally simple and fast.
It does not yet model pathing, walking/dropoff distance, or micro-level lure behavior.
