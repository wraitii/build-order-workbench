# Build Order Workbench

An AoE2 build-order simulator and interactive editor. Write build orders in a plain-text DSL, simulate them, and inspect resource timelines, action scheduling, warnings, and scoring metrics.

**[Try it in the browser →](https://wraitii.github.io/build-order-workbench/)**

No install required. For local development, see [Building locally](#building-locally).

---

## Features

_Write a build order in plain text, run the sim, and immediately see where your economy breaks down._

- **Reactive rules** — express real in-game decisions like "when boar is lured, pull sheep vils to it"; the sim handles the switch automatically.
- **Live editor** — no install needed; edit your build order and re-run the sim instantly in the browser.
- **Statistics** — set goals like "Feudal click by 8:30" or "3 scouts by 10:00", see resources over time.
- **On-device AI assistant** — optional; runs entirely in your browser, can suggest tweaks and answer questions about the build.
- **Not modeled** — walking time, continuous dropoff distance, deer lure, gather efficiency; timings will run slightly tighter than real play.

---

## DSL

Build orders are plain-text files (`.dsl` or `.bo`). Comments start with `#`. Times are seconds (`900`) or `M:SS` (`15:00`).

### Grammar

```
# Preamble (before any commands)
evaluation <time>                                    # required: simulation length
debt-floor <value>                                   # min resource deficit allowed (default 0)
starting-resource <resource> <amount>                # override a starting resource
start with <entityType>[, <entityType> <count>, ...]  # replace default starting entities
human-delay <actionId> <chance> <minSec> <maxSec>   # reaction-time variance bucket (repeatable)
score time <clicked|completed|depleted|exhausted> <target> [x<N>]  # scoring goal

# Commands — bare (time 0), timed, or deferred
[at <time>] [after [every] <condition>] <directive>

# Directives
queue <actionId> [x<N>] [using <selector>[, ...]] [from <selectors...>]
assign <actorType> <x<N>|idNum|all> [from <selectors...>] to <selectors...>
auto-queue <actionId> [using <actorType>] [from <selectors...>]
stop-auto-queue <actionId> [using <actorType>]
spawn-assign <entityType> to <selector>

# Actor selectors: villager  |  villager 3  |  villager-3  (comma-separated for multiple)
# Node selectors:  sheep  boar_lured  berries  forest  gold_mine  straggler_trees  farms  idle  created
```

### `after` conditions

`after` defers a command or registers a trigger rule:

| Condition                    | Behaviour                                                                                        |
| ---------------------------- | ------------------------------------------------------------------------------------------------ |
| `after <entityType> <N>`     | One-shot: fires when entity N exists.                                                            |
| `after clicked <actionId>`   | One-shot: fires on the next matching action click.                                               |
| `after completed <actionId>` | One-shot: fires on the next matching action completion.                                          |
| `after depleted <selector>`  | One-shot: fires on the next matching depletion event.                                            |
| `after exhausted <selector>` | One-shot: fires on the next matching exhaustion event.                                           |
| `after every <trigger...>`   | Repeating: same trigger forms as above, but fires on every matching event.                       |

Examples: [`data/aoe2-scout-build-order.dsl`](data/aoe2-scout-build-order.dsl) · [`data/aoe2-archer-rush-build-order.dsl`](data/aoe2-archer-rush-build-order.dsl)

You can also chain conditions to avoid hard-coded timing, e.g. `after completed advance_feudal_age after completed build_house assign to forest`.

---

## Building locally

**Prerequisites:** [Bun](https://bun.sh)

```bash
git clone https://github.com/wraitii/build-order-workbench
cd build-order-workbench
bun install
bun run build
```

This generates `out/aoe2-scout-report.html` — a single self-contained HTML file. Open it in a browser to edit DSL and re-run the simulation interactively.

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

Game data is a plain JSON file (`data/aoe2-game.json`) — adaptable to other RTS titles.

---

## Notes

This was almost entirely coded by Codex 5.3 & Sonnet 4.6 - I think the code is fine overall but I don't know what's going on either.

## License

GPL-3.0-or-later — see [LICENSE](LICENSE).
