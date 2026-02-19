# AoE2 fast castle into boom
# Lure deer for 25+2
evaluation 13:00
debt-floor 0
ruleset aoe2
setting arabia
setting normal_efficiency

# Scoring goals
score time clicked advance_feudal_age
score time clicked advance_castle_age

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
queue build_lumber_camp using villager 7 then assign to forest
assign villager 8 to forest
assign villager 9 to forest
# Boar at 10 (kinda personal but I find it easier to swap like this, timing wise)
queue lure_boar using villager 10
assign villager 11 to forest

# 2 houses then berries
queue build_house x2 using villager 12 then assign to berries
assign villager 13 to boar sheep deer
queue build_mill using villager 14 then assign to berries
after villager 14 queue lure_boar using villager from boar
assign villager 15 to berries
assign villager 16 to berries

at 6:00 queue lure_deer x3
after every completed lure_deer assign villager x3 from sheep to deer

queue build_farm using villager 17
queue build_farm using villager 18
queue build_lumber_camp using villager 19 then assign to forest
assign villager 20 to forest
assign villager 21 to forest
queue build_house using villager 22 then assign to forest
queue build_mining_camp using villager 23 then assign to gold
assign villager 24 to gold
after villager 24 queue advance_feudal_age

# Not entirely sure which value is too pessimistic but I'm missing some wood
after clicked advance_feudal_age queue build_farm x2 using villager from sheep straggler_trees

# Feudal
after completed advance_feudal_age queue build_market using villager x2 from straggler_trees wood
after completed advance_feudal_age queue build_blacksmith using villager from straggler_trees wood
after clicked build_blacksmith queue research_double_bit_axe
assign villager 25 to gold
assign villager 26 to gold
after villager 26 queue advance_castle_age

# In this build it looks better to wait for horse-collar to seed farm
after clicked advance_castle_age queue research_horse_collar
after completed research_horse_collar auto-queue build_farm using villager from straggler_trees idle