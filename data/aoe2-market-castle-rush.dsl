# Very fast castle, loom 19 + 2
# Probably not actually viable but it's fun.
# Works with sicilians who can sell 300 stone, don't think you can get away with the long-range gold mining otherwise

evaluation 10:00
debt-floor 0
ruleset aoe2
setting arabia
setting normal_efficiency
civ sicilians

score time clicked advance_feudal_age
score time completed advance_feudal_age
score time clicked advance_castle_age

auto-queue train_villager
queue find_starter_sheep then queue find_sheep x3
queue build_house using villager x2
queue build_house using villager
after completed build_house assign villager x3 to sheep

assign villager 4 to sheep
assign villager 5 to sheep
assign villager 6 to sheep

queue build_lumber_camp using villager 7 then assign to wood
assign villager 8 to wood
assign villager 9 to sheep
assign villager 10 to sheep
at 2:55 queue lure_boar using villager 1
# 'fix' the auto-setup, we keep 2 on sheep
after completed lure_boar assign villager 9 to sheep
after completed lure_boar assign villager 10 to sheep

assign villager 11 to boar sheep

queue build_house using villager 12 then queue build_mill
assign villager 12 to berries
assign villager 13 to berries
assign villager 14 to berries
at 4:35 queue lure_boar using villager from boar
assign villager 15 to berries
at 5:00 queue lure_deer x3
after completed lure_deer assign villager x3 from boar to deer
assign villager 16 to berries
assign villager 17 to wood
assign villager 18 to wood

after villager 18 queue research_loom then queue advance_feudal_age
after clicked research_loom assign villager x1 from berries to wood

at 8:00 queue build_house using villager from berries

# Post feudal
after completed advance_feudal_age assign villager x2 from wood to wood
after completed advance_feudal_age queue build_market using villager x2 from wood
after completed advance_feudal_age queue build_blacksmith using villager from wood

at 8:45 queue long_distance_mining using villager from wood
at 8:45 queue long_distance_mining using villager from wood
at 8:45 queue long_distance_mining using villager from berries
at 8:45 queue long_distance_mining using villager from berries

after completed build_market sell 300 stone
after completed build_market buy 100 food

after villager 20 queue advance_castle_age
