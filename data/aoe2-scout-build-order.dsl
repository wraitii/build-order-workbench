# AoE2 scout-rush style script (strict, hand-editable)
evaluation 900
debt-floor -120

# Open on food, then wood.
at 0 assign villager 3 to sheep
at 0 spawn-assign villager to sheep boar berries forest farm
at 0 auto-queue train_villager using town_center every 1 until 900 max 20

# Dark Age structure flow.
at 80 queue build_house using villager
at 100 queue build_lumber_camp using villager
at 120 assign villager 4 to forest
at 190 queue build_mill using villager
at 220 assign villager 1 to berries

# Feudal timing + military buildings.
at 320 queue research_loom
at 360 queue advance_feudal_age
at 520 queue build_barracks using villager
at 600 queue build_stable using villager

# Eco upgrades and farm transition.
at 610 queue research_double_bit_axe
at 660 queue research_horse_collar
at 680 queue build_farm x4 using villager
at 760 shift villager 2 from forest to farm

# Early scouts.
at 770 queue train_scout_cavalry
at 800 queue train_scout_cavalry
