# AoE2 feudal archer rush (goal: 5 archers)
# No deer lure, straight archer on a single range. Not horrible.
evaluation 17:00
debt-floor 0
ruleset aoe2
setting arabia
setting normal_efficiency

# Scoring goals
score time clicked advance_feudal_age
score time clicked advance_castle_age
score time completed train_archer x4
score time completed train_archer x8

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
# Boar timing
queue lure_boar using villager 10
assign villager 11 to forest

# Mill + berries
queue build_house using villager 12
assign villager 12 to berries
queue build_mill using villager 13
assign villager 13 to berries
# Second boar and food stabilization
queue lure_boar using villager 14
assign villager 15 to sheep
assign villager 16 to berries
assign villager 17 to berries

# Extra wood to support range + houses
queue build_house using villager 18
assign villager 18 to forest
assign villager 19 to forest

# Click up at 20 pop
after villager 19 queue research_loom
after villager 19 queue advance_feudal_age

# On loom: gold
after completed research_loom queue build_mining_camp using villager from sheep boar then assign to gold
after completed research_loom assign villager 15 to gold_mine
after completed research_loom assign villager 14 to gold_mine

after completed build_mining_camp queue build_barracks using villager from sheep boar

# We need more on wood after feudal (empirically 5 seems best with the current setup)
after completed advance_feudal_age assign villager x4 from sheep boar idle to forest

# Feudal power spike
after completed advance_feudal_age queue build_archery_range using villager x2 from wood
after completed build_archery_range queue train_archer x8
# Double bit-axe, horse collar
after completed advance_feudal_age queue research_double_bit_axe
after completed advance_feudal_age queue research_horse_collar

# Blacksmith + fletching
at 11:00 queue build_blacksmith using villager from wood
after completed build_blacksmith queue research_fletching

# Farm transition: new vills auto-build farms from straggler trees / idle.
after completed build_archery_range auto-queue build_farm using villager from straggler_trees idle
after villager 21 spawn-assign villager to straggler_trees


# Keep pop smooth
at 10:00 queue build_house x2 using villager from straggler_trees idle
at 12:00 queue build_house x2 using villager from straggler_trees idle

at 14:30 queue research_wheelbarrow then queue advance_castle_age
