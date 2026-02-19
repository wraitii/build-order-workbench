# AoE2 MAA into archer (old style all in archer, tweaked from https://aoecompanion.com/build-guides/men-at-arms-archers)
# This one is very all in and quite late to castle
# but you do get a lof of archer

evaluation 19:00
debt-floor 0
ruleset aoe2
setting arabia
setting normal_efficiency

# Scoring goals
score time clicked advance_feudal_age
score time clicked advance_castle_age
score time completed train_archer x4
score time completed train_archer x20

# Open: two houses + constant villager production
auto-queue train_villager using town_center
queue find_sheep x3
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
# Boar timing
queue lure_boar using villager 10
assign villager 11 to forest

# Mill + berries
queue build_house using villager 12
queue build_house using villager 12
assign villager 12 to berries
queue build_mill using villager 13
assign villager 13 to berries
assign villager 14 to berries
assign villager 15 to berries
assign villager 16 to berries

# Second boar and food stabilization
after villager 14 queue lure_boar using villager 3
after villager 17 queue lure_deer
assign villager 17 to boar sheep
assign villager 18 to boar sheep

# Barracks, 3 militia
queue build_barracks using villager 19 then assign to straggler_trees
after completed build_barracks queue train_militia x3

# mining camp
queue build_mining_camp using villager 20
assign villager 20 to gold
assign villager 21 to gold

# Click up at 22 pop
after villager 21 queue research_loom
after villager 21 queue advance_feudal_age

after clicked advance_feudal_age assign villager x3 from sheep boar idle to forest
after clicked advance_feudal_age assign villager x1 from sheep boar idle to gold
after clicked advance_feudal_age queue build_house using villager from wood

# Feudal start
after completed advance_feudal_age queue research_double_bit_axe
after completed advance_feudal_age queue research_man_at_arms
after completed advance_feudal_age assign villager x3 from sheep boar idle to forest
after completed advance_feudal_age assign villager x1 from sheep boar idle to straggler_trees

# Archery range, blacksmith
after completed advance_feudal_age queue build_archery_range using villager x2 from wood
after villager 22 queue build_archery_range using villager from wood
after villager 24 queue build_blacksmith using villager from wood
after completed build_archery_range queue train_archer x16
after completed build_archery_range queue train_archer x16
after villager 26 queue research_fletching

# Switch to farms after
after completed build_blacksmith auto-queue build_farm using villager from straggler_trees idle

assign villager 22 to gold
assign villager 23 to gold
assign villager 24 to gold
assign villager 25 to gold
assign villager 26 to gold
after villager 26 spawn-assign villager to straggler_trees

# houses
after completed advance_feudal_age queue build_house using villager from wood
after villager 24 queue build_house using villager from wood
after villager 25 queue build_house using villager from idle straggler_trees wood
after villager 28 queue build_house using villager from idle straggler_trees wood
after villager 29 queue build_house
after villager 32 queue build_house
after villager 34 queue build_house
after villager 36 queue build_house
after villager 38 queue build_house

at 17:20 queue research_wheelbarrow then queue advance_castle_age
