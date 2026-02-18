# AoE2 scout-rush build order
evaluation 15:00 # run for 15 minutes
debt-floor -120 # disallow going below -120 res
start with town_center,villager,villager,villager,scout_cavalry

# Scoring goals
score time completed advance_feudal_age
score time completed train_scout_cavalry x3

# General AoE2 Rules (keep these high-level reactions together)
# (you probably want to keep these just to make writing the build order easier)
after completed lure_boar assign to boar_lured
after completed lure_boar assign villager all from sheep to boar_lured
after depleted boar_lured assign to boar_lured sheep
after depleted sheep assign to sheep straggler_trees
after exhausted sheep assign to straggler_trees
after depleted straggler_trees assign to straggler_trees
after completed build_farm assign to created

# Build Order (Scout)
# Open: two houses, then sheep
auto-queue train_villager using town_center
queue build_house using villager 1, villager 2
queue build_house using villager 3
after houses assign villager 1 to sheep
after houses assign villager 2 to sheep
after houses assign villager 3 to sheep

# 4-6 sheep.
assign villager 4 to sheep
assign villager 5 to sheep
assign villager 6 to sheep

# 7 lumber camp, 8-9 wood.
queue build_lumber_camp using villager 7
assign villager 7 to forest
assign villager 8 to forest
assign villager 9 to forest

# 10 lure boar, then sheep villagers rotate to boar.
queue lure_boar using villager 10
assign villager 11 to sheep

# 12 one house then berries, 13 mill then berries, 14 berries.
queue build_house using villager 12
assign villager 12 to berries
queue build_mill using villager 13
assign villager 13 to berries
assign villager 14 to berries

# 15 lure second boar, 16-17 sheep (rotate to boar).
queue lure_boar using villager 15
assign villager 16 to sheep
assign villager 17 to sheep

# 18-19 wood.
assign villager 18 to forest
assign villager 19 to forest

# Feudal timing and military path.
after villager 19 queue research_loom
after villager 19 queue advance_feudal_age

# On loom click: move 3 to wood, 2 to berries; vill 17 builds house then barracks.
after completed research_loom assign villager x3 from sheep boar_lured to forest
after completed research_loom assign villager x2 from sheep boar_lured to berries
after completed research_loom queue build_house using villager 17
after completed research_loom queue build_barracks using villager 17

# On feudal: stables, scouts, double-bit axe, pop-cap houses.
after completed advance_feudal_age queue build_stable using villager, villager
after completed build_stable queue train_scout_cavalry x3

after completed advance_feudal_age queue build_house using villager
at 10:50 queue build_house using villager from berries
at 12:10 queue build_house using villager from berries

after completed advance_feudal_age queue research_double_bit_axe
at 11:00 queue research_horse_collar

# Farm transition: new vills auto-build farms from straggler trees / idle.
after completed build_stable auto-queue build_farm using villager from straggler_trees idle
after villager 19 spawn-assign villager to straggler_trees
