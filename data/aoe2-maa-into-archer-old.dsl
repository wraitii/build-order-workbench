# AoE2 MAA into archer (old style all in archer, tweaked from https://aoecompanion.com/build-guides/men-at-arms-archers)

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
assign villager 10 to forest

# Boar timing
queue lure_boar using villager 11

# Mill + berries
queue build_house using villager 12
queue build_house using villager 12
assign villager 12 to berries
queue build_mill using villager 13
assign villager 13 to berries
assign villager 14 to berries
assign villager 15 to berries

# Second boar and food stabilization
queue lure_boar using villager 3
assign villager 16 to berries
assign villager 17 to boar_lured sheep
assign villager 18 to boar_lured sheep

# Barracks
queue build_barracks using villager 19
assign villager 19 to forest
after completed build_barracks queue train_militia x3

queue build_mining_camp using villager 20
assign villager 20 to gold
assign villager 21 to gold

# Click up at 22 pop
after villager 21 queue research_loom
after villager 21 queue advance_feudal_age

after clicked advance_feudal_age assign villager x4 from sheep boar_lured idle to forest
after clicked advance_feudal_age queue build_farm using villager from sheep boar_lured idle

# Feudal start
after completed advance_feudal_age queue build_house using villager from wood
after completed advance_feudal_age queue research_double_bit_axe
after completed advance_feudal_age queue research_man_at_arms
after completed advance_feudal_age assign villager x2 from sheep boar_lured idle to forest
after completed advance_feudal_age assign villager x2 from sheep boar_lured idle to straggler_trees

queue build_farm using villager 22
queue build_farm using villager 23
assign villager 24 to gold

after villager 24 queue build_house using villager from wood
after villager 24 queue build_archery_range using villager, villager
after villager 24 queue build_blacksmith
after villager 25 queue build_archery_range using villager, villager
after completed build_archery_range queue train_archer x8

assign villager 25 to gold
assign villager 26 to gold
after villager 26 queue build_house using villager from idle straggler_trees wood
assign villager 27 to gold
after villager 28 queue research_fletching
assign villager 28 to gold

after villager 28 queue build_house using villager from idle straggler_trees wood
after villager 29 queue build_house

after villager 28 auto-queue build_farm using villager from straggler_trees idle
after villager 28 spawn-assign villager to straggler_trees

after villager 32 queue build_house
after villager 35 queue build_house

at 17:30 queue advance_castle_age
