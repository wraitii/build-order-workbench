# Build Order Workbench

An AoE2 build-order simulator and interactive editor. Write your build order in plain text, run it through the simulator, and see resource timelines, warnings, and how your economy plays out second by second.

**[Try it in the browser →](https://wraitii.github.io/build-order-workbench/)**

No install required. For local development, see [Building locally](#building-locally).

---

## Features

_Write a build order in plain text, run the sim, and immediately see where your economy breaks down._

- **Reactive rules** — express real in-game decisions like "when boar is lured, pull sheep vils to it"; the sim handles the switch automatically.
- **Live editor** — edit your build order and re-run the sim instantly in the browser.
- **Statistics** — set goals like "Feudal click by 8:30" or "3 scouts by 10:00", see resources over time.
- **On-device AI assistant** — optional; runs entirely in your browser, can suggest tweaks and answer questions about the build.
- **Approximations** — walking time, continuous dropoff distance, gather efficiency; timings will run slightly tighter than real play.

---

## Writing a build order

Build orders are plain-text files (`.dsl` or `.bo`). Each line is a comment, a setup option, or a command. Comments start with `#`. Times are written as seconds (`900`) or `M:SS` (`15:00`).

See the included examples: [`data/aoe2-scout-build-order.dsl`](data/aoe2-scout-build-order.dsl) · [`data/aoe2-archer-rush-build-order.dsl`](data/aoe2-archer-rush-build-order.dsl)

### A minimal example

```
evaluation 15:00     # simulate 15 minutes of play
ruleset aoe2
setting arabia

auto-queue train_villager using town_center  # keep making villagers non-stop
assign villager 1 to sheep
assign villager 2 to sheep
queue build_house using villager 3 then assign to sheep
```

---

### Setup lines

These go at the top before any commands, and configure the simulation:

| Line | What it does |
| --- | --- |
| `evaluation <time>` | **Required.** How long to simulate, e.g. `evaluation 15:00`. |
| `ruleset aoe2` | Use standard AoE2 game rules. |
| `setting arabia` | Start with the standard Arabia setup — 6 sheep, 2 boar, berries, etc. |
| `debt-floor <amount>` | Allow resources to go this many below zero before triggering a warning (default: 0). |
| `score time clicked <action>` | Track when you click something, e.g. `score time clicked advance_feudal_age`. |
| `score time completed <action> [xN]` | Track when something finishes, e.g. `score time completed train_scout_cavalry x3`. |

---

### Commands

Commands tell villagers what to do and when. They can be immediate (happen right away or `at` a specific time) or triggered `after` an in-game event.

#### Assigning villagers to gather resources

```
assign villager 4 to sheep          # send villager #4 to sheep
assign villager x3 to forest        # send any 3 villagers to wood
assign villager all from gold to farm   # move everyone off gold onto farms
```

#### Queuing actions (build something, research, train units, age up)

```
queue build_house using villager 3              # villager 3 builds a house
queue build_lumber_camp using villager 7 then assign to forest  # build, then go chop
auto-queue train_villager using town_center      # keep training villagers continuously
queue advance_feudal_age                         # click Feudal Age
```

The `then` keyword chains a follow-up: `queue build_lumber_camp using villager 7 then assign to forest` means "build the lumber camp, then immediately start chopping wood."

#### Timing a command with `at`

```
at 4:30 queue lure_deer
at 11:30 queue build_house using villager from forest
```

#### Reacting to events with `after`

Instead of hard-coding a time, `after` lets you react to things that happen during the build:

| `after …` | When it triggers |
| --- | --- |
| `after villager 18` | When your 18th villager finishes training |
| `after completed build_barracks` | When a barracks finishes building |
| `after clicked advance_feudal_age` | The moment you click Feudal Age |
| `after depleted boar` | When a boar runs out of food |
| `after exhausted gold_mine` | When the last gold mine on the map is empty |
| `after every depleted sheep` | Every time a sheep runs out (repeats) |

```
after villager 18 queue advance_feudal_age                # click up at 18 pop
after completed advance_feudal_age queue build_stable     # stable as soon as feudal hits
after depleted boar assign villager x3 from boar to sheep # move vils off empty boar
```

You can chain multiple `after` conditions on one line:

```
after completed advance_feudal_age after completed build_stable queue train_scout_cavalry x3
```

#### Spawning and auto-assigning

```
spawn-assign villager to straggler_trees     # new villager starts on straggler trees
auto-queue build_farm using villager from straggler_trees idle  # keep placing farms automatically
stop-auto-queue build_farm                   # stop the auto-farm
```

---

### Specifying villagers and resources

Whenever a command needs to know *which* villager or *which* resource, you use a selector.

**Villager selectors:**

| Selector | Meaning |
| --- | --- |
| `villager` | Any one available villager |
| `villager 3` | The specific 3rd villager to be created |
| `villager x3` | Any 3 villagers |
| `villager from sheep` | A villager currently gathering sheep |
| `villager from sheep boar` | A villager on sheep or boar (checked in order) |

**Resource / node selectors** (used in `to`, `from`, `using`):

`sheep` · `boar` · `berries` · `forest` · `gold_mine` · `straggler_trees` · `farms` · `idle` · `created`

`idle` matches villagers doing nothing. `created` matches the most recently created villager.

---

### Full reference

<details>
<summary>Compact syntax reference (for experienced users)</summary>

```
# Preamble (before any commands)
evaluation <time>                                     # required: simulation length
debt-floor <value>                                    # min resource deficit allowed (default 0)
starting-resource <resource> <amount>                 # override a starting resource
ruleset <name>                                        # currently: aoe2
setting <name>                                        # currently: arabia
human-delay <actionId> <chance> <minSec> <maxSec>    # reaction-time variance bucket (repeatable)
score time <clicked|completed|depleted|exhausted> <target> [xN]  # scoring goal

# Commands — bare (time 0), timed, or deferred
[at <time>] [after [every] <condition>] <directive>
[at <time>] [after [every] <condition>] queue <actionId> ... then <directive>

# Directives
queue <actionId> [xN] [using <selector>[, ...]] [from <selectors...>]
assign <actorType> <xN|idNum|all> [from <selectors...>] to <selectors...>
auto-queue <actionId> [using <actorType>] [from <selectors...>]
stop-auto-queue <actionId> [using <actorType>]
spawn-assign <entityType> to <selector>
```

</details>

---

## Building locally

**Prerequisites:** [Bun](https://bun.sh)

```bash
git clone https://github.com/wraitii/build-order-workbench
cd build-order-workbench
bun install
bun run build
```

This generates `out/aoe2-scout-report.html` — a single self-contained HTML file. Open it in a browser to edit build orders and re-run the simulation interactively.

| Command              | Description                                                                |
| -------------------- | -------------------------------------------------------------------------- |
| `bun run build`      | Generate the workbench HTML                                                |
| `bun run build:llm`  | Include the on-device LLM assistant (WebGPU; downloads model on first use) |
| `bun run sim:watch`  | File-watch loop for CLI development                                        |
| `bun run sim:strict` | Strict mode (no resource debt allowed)                                     |

Custom game data and build orders:

```bash
bun run src/index.ts --game data/aoe2-game.json --build data/my-build.dsl --report out/report.html
```

Optional event transition log (`MM:SS [entity] switched to X`):

```bash
bun run src/index.ts --game data/aoe2-game.json --build data/my-build.dsl --event-log
bun run src/index.ts --game data/aoe2-game.json --build data/my-build.dsl --event-log out/events.log
```

Game data is a plain JSON file (`data/aoe2-game.json`) — adaptable to other RTS titles.

---

## Notes

This was almost entirely coded by Codex 5.3 & Sonnet 4.6 - I think the code is fine overall but I don't know what's going on either.

## License

GPL-3.0-or-later — see [LICENSE](LICENSE).
