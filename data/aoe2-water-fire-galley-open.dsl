# AoE2 water opening -> Feudal fire galleys
# Based on a 21-pop feudal water build outline.
# Not super optimised.
evaluation 17:30
debt-floor 0
ruleset aoe2
setting arabia
setting normal_efficiency

# Scoring goals
score time clicked advance_feudal_age
score time clicked advance_castle_age
score time completed train_fire_galley x2
score time completed train_galley x5

queue find_starter_sheep
queue find_sheep x3
# Keep TC running
auto-queue train_villager using town_center

# 2 houses, then builders back to sheep
queue build_house using villager 1, villager 2
queue build_house using villager 3
after completed build_house assign villager 1 to sheep
after completed build_house assign villager 2 to sheep
after completed build_house assign villager 3 to sheep

# 4-6 on sheep
assign villager 4 to sheep
assign villager 5 to sheep
assign villager 6 to sheep

# 7-10 on wood
queue build_lumber_camp using villager 7 then assign to forest
assign villager 8 to forest
assign villager 9 to forest
assign villager 10 to forest

# 11 lure boar
queue lure_boar using villager 11

# 12: house -> dock -> house, then gather shore fish
after villager 12 queue build_house using villager 12
after villager 12 queue build_dock using villager 12
after completed build_dock queue build_house using villager 12
after villager 13 assign villager 12 to shore_fish

# Ships auto-assign to deep fish
spawn-assign fishing_ship to deep_fish
# First dock: 4 fishing ships
after completed build_dock queue train_fishing_ship x4 using dock

# 13-14 wood
assign villager 13 to forest
assign villager 14 to forest

# 15 lure second boar
queue lure_boar using villager 15

# 16-21 to food
assign villager 16 to boar deer sheep
assign villager 17 to boar deer sheep
assign villager 18 to boar deer sheep
assign villager 19 to boar deer sheep

# Need one more house before villager 21 because fishing ships also consume pop
after villager 18 queue build_house using villager from forest shore_fish sheep boar deer idle

# Up to feudal
after villager 19 queue research_loom then queue advance_feudal_age

# While going up: eco reshuffle for water pressure (staggered, less aggressive)
# First wave: only a small pull from food
after clicked advance_feudal_age assign villager x2 from sheep boar deer shore_fish to forest
after clicked advance_feudal_age queue build_lumber_camp using villager x2 from sheep boar deer shore_fish then assign to forest
after clicked advance_feudal_age queue build_mining_camp using villager x2 from sheep boar deer shore_fish then assign to gold
# Second wave: complete the shift once Feudal is in
after completed advance_feudal_age assign villager x3 from food idle straggler_trees to forest
after completed advance_feudal_age assign villager x2 to gold

# Second dock + house from food villager
after clicked advance_feudal_age queue build_dock using villager from sheep boar deer shore_fish
at 10:00 queue build_house using villager from straggler_trees wood shore_fish

# Feudal hits: eco tech + fire galleys
after completed advance_feudal_age queue research_double_bit_axe
after completed advance_feudal_age queue train_fire_galley using dock
after completed advance_feudal_age queue train_fire_galley using dock

# Add third dock
at 11:00 queue build_dock using villager from straggler_trees wood
at 11:30 queue build_house x3 using villager from straggler_trees wood shore_fish

at 10:00 queue build_farm x2 using villager from wood then assign to farm
at 12:00 queue build_farm x2 using villager from wood then assign to farm
at 12:00 auto-queue train_galley

# 22 wood-23 gold
assign villager 22 to forest
assign villager 23 to gold

# 24 mill then berries
queue build_mill using villager 24 then assign to berries

# Move 2 from stragglers to berries/remaining food
after villager 24 assign villager x2 from straggler_trees to berries

at 14:00 queue build_house x2 using villager from straggler_trees wood shore_fish

# 25 berries
assign villager 25 to berries
assign villager 26 to forest
assign villager 27 to forest

after villager 27 spawn-assign villager to forest

at 15:00 queue build_blacksmith
at 15:00 queue build_market using villager x2
at 16:00 queue advance_castle_age
