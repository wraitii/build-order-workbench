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

#### Market trading

Use AoE2-style market commands. Amounts are in resource units and must be multiples of 100.

```
sell 100 wood      # sell 100 wood for gold at current market rate
buy 100 food       # buy exactly 100 food, paying gold at current market rate
sell 500 stone     # lowered into five 100-stone market actions
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

`idle` matches villagers doing nothing.
`created` is only meaningful in trigger-context assign lines like `after completed build_farm assign to created` and matches resource nodes created by the triggering action (for farms, the new farm patch).

---

### Full reference

```
# Preamble (before any commands)
evaluation <time>                                     # required: simulation length
stop after <clicked|completed|depleted|exhausted> <target> [xN]  # optional early stop condition (+5s)
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
consume-res <prototypeId> [count]
create-res <prototypeId> [count]
sell <amount> <resource>    # amount must be a positive multiple of 100 (non-gold)
buy <amount> <resource>     # amount must be a positive multiple of 100 (non-gold)
```