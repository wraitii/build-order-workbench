import { BuildOrderInput, GameData } from "./types";
import { DEFAULT_DSL_SELECTOR_ALIASES } from "./node_selectors";
import { parseDslAstLine } from "./dsl_parser";
import { applyAstDslLine, createDslLoweringState, DslValidationSymbols } from "./dsl_lower";

export interface ParseBuildOrderDslOptions {
    selectorAliases?: Record<string, string>;
    symbols?: DslValidationSymbols;
}

export function createDslValidationSymbols(game: GameData): DslValidationSymbols {
    const nodeTags = new Set<string>();
    for (const proto of Object.values(game.resourceNodePrototypes)) {
        for (const tag of proto.tags ?? []) nodeTags.add(tag);
    }
    return {
        actions: new Set(Object.keys(game.actions)),
        entityTypes: new Set(Object.keys(game.entities)),
        resources: new Set(game.resources),
        nodePrototypes: new Set(Object.keys(game.resourceNodePrototypes)),
        nodeTags,
    };
}

export function parseBuildOrderDsl(input: string, options?: ParseBuildOrderDslOptions): BuildOrderInput {
    const selectorAliases = {
        ...DEFAULT_DSL_SELECTOR_ALIASES,
        ...(options?.selectorAliases ?? {}),
    };

    const state = createDslLoweringState();
    const lines = input.split(/\r?\n/);
    for (let idx = 0; idx < lines.length; idx += 1) {
        const lineNo = idx + 1;
        const raw = lines[idx] ?? "";
        const line = raw.replace(/#.*/, "").trim();
        if (!line) continue;
        const ast = parseDslAstLine(line, lineNo);
        applyAstDslLine(ast, lineNo, selectorAliases, state, options?.symbols);
    }

    if (state.evaluationTime === undefined) {
        throw new Error("DSL requires 'evaluation <seconds>'.");
    }

    const out: BuildOrderInput = {
        evaluationTime: state.evaluationTime,
        commands: state.commands,
    };
    if (state.debtFloor !== undefined) out.debtFloor = state.debtFloor;
    if (state.startingResources !== undefined) out.startingResources = state.startingResources;
    if (state.startingEntities !== undefined) out.startingEntities = state.startingEntities;
    if (state.humanDelays !== undefined) out.humanDelays = state.humanDelays;
    if (state.scores !== undefined) out.scores = state.scores;
    return out;
}
