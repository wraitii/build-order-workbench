# AoE2 fast castle into boom
# Classic, slow, 27+2
evaluation 13:00
debt-floor 0
ruleset aoe2
setting arabia
setting normal_efficiency

# Scoring goals
score time clicked advance_feudal_age
score time clicked advance_castle_age

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

# 4 on wood
queue build_lumber_camp using villager 7 then assign to forest
assign villager 8 to forest
assign villager 9 to forest
# Boar at 10 (kinda personal but I find it easier to swap like this, timing wise)
queue lure_boar using villager 10
assign villager 11 to forest

# 2 houses then berries
queue build_house x2 using villager 12 then assign to berries
queue build_mill using villager 13 then assign to berries
assign villager 14 to berries
after villager 14 queue lure_boar using villager from boar
assign villager 15 to berries
assign villager 16 to berries

queue build_farm using villager 17
queue build_farm using villager 18
queue build_lumber_camp using villager 19 then assign to forest
assign villager 20 to forest
assign villager 21 to forest
queue build_house using villager 22 then assign to forest
assign villager 23 to forest
queue build_mining_camp using villager 24 then assign to gold
assign villager 25 to gold
assign villager 26 to gold
after villager 26 queue advance_feudal_age
# Not entirely sure which value is too pessimistic but I'm missing some wood
at 10:00 queue build_farm x4 using villager from straggler_trees
at 10:00 queue build_farm using villager from straggler_trees
at 10:40 queue build_farm using villager from straggler_trees
at 10:30 queue build_farm using villager from straggler_trees

# Feudal
after completed advance_feudal_age queue build_market using villager x2 from straggler_trees wood
after completed advance_feudal_age queue build_blacksmith using villager from straggler_trees wood
after clicked build_blacksmith queue research_double_bit_axe
queue build_house using villager 27 then assign to forest
assign villager 28 to wood
after villager 28 queue advance_castle_age
after clicked advance_castle_age queue research_horse_collar
after clicked advance_castle_age assign villager x2 from berries to forest