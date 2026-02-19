# AoE2 scout rush at 19 pop.
evaluation 16:00
debt-floor 0
ruleset aoe2
setting arabia
setting normal_efficiency

# Scoring goals
score time clicked advance_feudal_age
score time clicked advance_castle_age
score time completed train_scout_cavalry x3

# Open: two houses + constant villager production
queue find_starter_sheep
queue find_sheep x3
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

# 3 on wood
queue build_lumber_camp using villager 7 then assign to forest
assign villager 8 to forest
assign villager 9 to forest
# Boar at 10
queue lure_boar using villager 10

# Mill + 4 on berries + lure deer
queue build_house using villager 11
assign villager 11 assign to berries
queue build_mill using villager 12 then assign to berries
assign villager 13 to berries
at 4:30 queue lure_deer
after completed lure_deer assign villager x3 from boar sheep to deer
at 6:00 queue lure_deer
# Second boar interrupts
queue lure_boar using villager 14
assign villager 15 to boar deer sheep
assign villager 16 to boar deer sheep
assign villager 17 to berries
assign villager 18 to boar deer sheep

# Click up at 19 pop
after villager 18 queue research_loom then queue advance_feudal_age

# Prep for feudal - house & barracks
after clicked advance_feudal_age queue build_house using villager from sheep boar deer then queue build_barracks
after clicked advance_feudal_age assign villager x5 from sheep boar deer idle to forest
after completed build_barracks assign to forest

# Feudal done - stable, double bit axe, shift a few bills to wood
after completed advance_feudal_age queue build_stable using villager x2 from wood
after completed build_stable queue train_scout_cavalry x3
after completed build_stable queue build_house
after completed advance_feudal_age queue research_double_bit_axe

after villager 23 queue build_mining_camp then assign to gold
assign villager 24 to gold
after villager 24 queue research_horse_collar

# Then auto place farm
after completed advance_feudal_age spawn-assign villager to straggler_trees
after completed advance_feudal_age auto-queue build_farm using villager from straggler_trees idle

after villager 30 queue research_wheelbarrow then queue advance_castle_age
after villager 30 queue build_blacksmith using villager from straggler_trees idle

# other houses
at 11:30 queue build_house using villager from straggler_trees wood
at 13:30 queue build_house using villager from straggler_trees wood