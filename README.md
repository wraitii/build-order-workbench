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
- `actions`

Action effects support:
- `costs`
- `duration`
- `creates` (entities)
- `createsResourceNodes` (e.g. farms)
- `resourceDeltaOnComplete`
- `modifiersOnComplete`

### Build-order file (DSL only)

Main fields:
- `evaluation <seconds>`
- `debt-floor <value>` (optional)
- `at <time> ...` directives

## DSL (strict text format)

You can pass a `.dsl` / `.bo` file directly:

```bash
bun run src/index.ts --game data/aoe2-game.json --build data/aoe2-scout-build-order.dsl
```

Main directives:
- `evaluation <seconds>`
- `debt-floor <value>`
- `at <t> queue <actionId> [xN] [using <actorType>]`
- `at <t> assign <actorType> <count> to <selectors...>`
- `at <t> auto-queue <actionId> [using <actorType>] [every <sec>] [until <sec>] [max <n>]`
- `at <t> spawn-assign <entityType> to <selectors...>`
- `at <t> shift <actorType> <count> from <selectors...> to <selectors...>`

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
