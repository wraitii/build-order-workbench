# AoE2 Mongol scout rush, up 17 pop (full minute ahead of regular)
# This one is quite tight, probably depends on the map for feasibility
# and if the sim assumptions aren't too off.
evaluation 16:00
debt-floor 0
ruleset aoe2
setting arabia
setting normal_efficiency
civ mongols

# Scoring goals
score time clicked advance_feudal_age
score time clicked advance_castle_age
score time completed train_scout_cavalry x3

# Open: two houses + constant villager production
queue find_starter_sheep
queue find_sheep x3
auto-queue train_villager using town_center
queue build_house using villager x2
queue build_house
after completed build_house assign villager all to sheep

# Early food economy
assign villager 4 to sheep
assign villager 5 to sheep
assign villager 6 to sheep

# 3 on wood
queue build_lumber_camp using villager 7 then assign to forest
assign villager 8 to forest
assign villager 9 to forest
# Boar at 10
queue lure_boar using villager 10

# Mongols - put 2 on boar, then mill
queue build_house using villager 11 then assign to boar
queue lure_boar using villager 12
queue build_mill using villager 13 then assign to berries
assign villager 14 to berries

at 4:00 queue lure_deer x2

assign villager 15 to boar deer sheep
assign villager 16 to berries

# Click up at 17 pop
after villager 16 queue research_loom then queue advance_feudal_age

# Prep for feudal - house & barracks
after clicked advance_feudal_age queue build_house using villager from sheep boar deer then queue build_barracks
after completed build_barracks assign to forest
# Move a fair bunch to wood a bit after feudal so we have plenty wood once we arrive - we don't actually need the food there
at 6:10 assign villager x4 from boar sheep food to forest

after exhausted deer assign villager x1 from deer sheep to forest

# Feudal done - stable, double bit axe, shift a few bills to wood
after completed advance_feudal_age queue build_stable using villager x2 from wood
after completed build_stable queue train_scout_cavalry x3
after completed build_stable queue build_house
after completed build_stable queue build_farm
after completed advance_feudal_age queue research_double_bit_axe

after villager 21 queue build_mining_camp then assign to gold
assign villager 22 to gold
after villager 22 queue research_horse_collar

# After feudal, two on berries, start farms
assign villager 17 to berries
assign villager 18 to berries
after completed advance_feudal_age spawn-assign villager to straggler_trees
after completed advance_feudal_age auto-queue build_farm using villager from straggler_trees idle

after villager 28 queue research_wheelbarrow then queue advance_castle_age
after villager 28 queue build_blacksmith using villager from straggler_trees idle

# other houses
at 11:30 queue build_house using villager from straggler_trees wood