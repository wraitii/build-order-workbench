# AoE2 fast castle into boom
# Classic, slow, 27+2
evaluation 13:00
debt-floor 0
start with town_center,villager,villager,villager,scout_cavalry

# Scoring goals
score time clicked advance_feudal_age
score time clicked advance_castle_age

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
after villager 14 queue lure_boar using villager from boar_lured
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