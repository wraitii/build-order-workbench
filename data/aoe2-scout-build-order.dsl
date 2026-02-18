# AoE2 feudal archer rush (goal: 5 archers)
# This particular build is a bit too tight for current params,
# but that's fine.
evaluation 18:00
debt-floor -120
start with town_center,villager,villager,villager,scout_cavalry

# Scoring goals
score time clicked advance_feudal_age
score time clicked advance_castle_age
score time completed train_archer x4
score time completed train_archer x8

# General AoE2 Rules (keep these high-level reactions together)
# (you probably want to keep these just to make writing the build order easier)
after every completed lure_boar assign to boar_lured
after every completed lure_boar assign villager all from sheep to boar_lured
after every depleted boar_lured assign to boar_lured deer sheep
after every depleted deer assign to boar_lured deer sheep
after every depleted sheep assign to boar_lured deer sheep straggler_trees
after every exhausted sheep assign to boar_lured deer straggler_trees
after every exhausted berries assign to straggler_trees
after every depleted straggler_trees assign to straggler_trees
after every completed build_farm assign to created

# Open: two houses + constant villager production
auto-queue train_villager using town_center
queue build_house using villager 1, villager 2
queue build_house using villager 3
after completed build_house assign villager 1 to sheep
after completed build_house assign villager 2 to sheep
after completed build_house assign villager 3 to sheep

# Early food economy
assign villager 4 to sheep
assign villager 5 to sheep
assign villager 6 to sheep

# 4 on wood
queue build_lumber_camp using villager 7
assign villager 7 to forest
assign villager 8 to forest
assign villager 9 to forest
# Boar timing interrupts, for simplicity in the build order
queue lure_boar using villager 10
assign villager 11 to forest

# Mill + berries
queue build_house using villager 12
assign villager 12 to berries
queue build_mill using villager 13
assign villager 13 to berries
# Second boar interrupts
queue lure_boar using villager 14
assign villager 15 to boar_lured deer sheep
assign villager 16 to berries
assign villager 17 to berries

# Extra wood to support range + houses
assign villager 18 to forest
assign villager 19 to forest

# Click up at 20 pop
after villager 19 queue research_loom
after villager 19 queue advance_feudal_age

# On loom: prep military path + gold
after completed research_loom queue build_mining_camp using villager from sheep boar_lured berries then assign to gold
after completed build_mining_camp queue build_house using villager from sheep boar_lured berries then queue build_barracks
after completed build_mining_camp assign villager 15 to gold_mine
after completed build_mining_camp assign villager 14 to gold_mine

# We need more on wood after feudal (empirically 5 seems best with the current setup)
after completed advance_feudal_age assign villager x5 from sheep boar_lured idle to forest

# Feudal power spike
after completed advance_feudal_age queue build_archery_range using villager, villager
after completed build_archery_range queue train_archer x8

# Keep pop smooth
at 10:00 queue build_house x2 using villager from straggler_trees idle
at 12:00 queue build_house x2 using villager from straggler_trees idle

# Farm transition: new vills auto-build farms from straggler trees / idle.
after completed build_archery_range auto-queue build_farm using villager from straggler_trees idle
after villager 21 spawn-assign villager to straggler_trees

at 14:00 queue research_wheelbarrow then queue advance_castle_age
