# AoE2 19 pop generic scout-rush build order
evaluation 16:00 # run for 15 minutes
debt-floor -20 # disallow going below -120 res
start with town_center,villager,villager,villager,scout_cavalry

# Scoring goals
score time completed advance_feudal_age
score time completed train_scout_cavalry x3

# General AoE2 Rules (keep these high-level reactions together)
# (you probably want to keep these just to make writing the build order easier)
after every completed lure_boar assign to boar_lured
after every completed lure_boar assign villager all from sheep to boar_lured
after every completed lure_deer assign villager x3 from sheep boar_lured to deer
after every depleted boar_lured assign to boar_lured deer sheep
after every depleted deer assign to boar_lured deer sheep
after every depleted sheep assign to boar_lured deer sheep straggler_trees
after every exhausted sheep assign to boar_lured deer straggler_trees
after every exhausted berries assign to straggler_trees
after every depleted straggler_trees assign to straggler_trees
after every completed build_farm assign to created

# Open: two houses, then sheep
auto-queue train_villager using town_center
queue build_house using villager 1, villager 2
queue build_house using villager 3
after completed build_house assign villager 1 to sheep
after completed build_house assign villager 2 to sheep
after completed build_house assign villager 3 to sheep

# 4-6 sheep.
assign villager 4 to sheep
assign villager 5 to sheep
assign villager 6 to sheep

# 7 lumber camp, 8-9 wood.
queue build_lumber_camp using villager 7
assign villager 7 to forest
assign villager 8 to forest
assign villager 9 to forest

at 4:40 queue lure_deer

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
at 4:40 queue lure_boar using villager 1
assign villager 15 to boar_lured deer sheep
assign villager 16 to boar_lured deer sheep
assign villager 17 to boar_lured deer sheep

# 18-19 wood.
assign villager 18 to forest

# Feudal timing and military path.
after villager 18 queue research_loom
after villager 18 queue advance_feudal_age

# On loom click: move 3 to wood, 2 to berries; vill 17 builds house then barracks.
after completed research_loom assign villager x4 from sheep boar_lured to forest
after completed research_loom assign villager x2 from sheep boar_lured to berries
after completed research_loom queue build_house using villager 17
after completed research_loom queue build_barracks using villager 17

# On feudal: stables, scouts, double-bit axe, pop-cap houses.
after completed advance_feudal_age queue build_stable using villager x2 from forest
after completed build_stable queue train_scout_cavalry x3

after completed advance_feudal_age queue build_house using villager then assign to forest
at 10:50 queue build_house using villager from berries
at 12:10 queue build_house using villager from berries
at 14:00 queue build_house using villager from berries forest

after completed advance_feudal_age queue research_double_bit_axe
at 11:00 queue research_horse_collar

# Farm transition: new vills auto-build farms from straggler trees / idle.
after completed build_stable auto-queue build_farm using villager from straggler_trees idle
after villager 19 spawn-assign villager to straggler_trees

after villager 27 queue build_mining_camp then assign to gold
assign villager 28 to gold
assign villager 29 to gold
after villager 29 assign villager x1 from forest to gold
after villager 30 queue research_wheelbarrow then queue advance_castle_age
