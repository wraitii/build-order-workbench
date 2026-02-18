import { BuildOrderInput, GameData } from "./types";
import { DEFAULT_DSL_SELECTOR_ALIASES } from "./node_selectors";
import { parseDslAstLine } from "./dsl_parser";
import { applyAstDslLine, createDslLoweringState, DslValidationSymbols } from "./dsl_lower";

export interface ParseBuildOrderDslOptions {
    selectorAliases?: Record<string, string>;
    symbols?: DslValidationSymbols;
    civDslByName?: Record<string, string[]>;
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

export function createCivDslByName(game: GameData): Record<string, string[]> {
    const out: Record<string, string[]> = {};
    for (const civ of game.civilizations ?? []) {
        out[civ.name] = [...(civ.dslLines ?? [])];
    }
    return out;
}

function levenshtein(a: string, b: string): number {
    const dp: number[] = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i += 1) {
        let prev = dp[0] ?? 0;
        dp[0] = i;
        for (let j = 1; j <= b.length; j += 1) {
            const cur = dp[j] ?? 0;
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            dp[j] = Math.min((dp[j] ?? 0) + 1, (dp[j - 1] ?? 0) + 1, prev + cost);
            prev = cur;
        }
    }
    return dp[b.length] ?? Number.MAX_SAFE_INTEGER;
}

function civSuggestionSuffix(raw: string, candidates: string[]): string {
    if (candidates.length === 0) return "";
    let best = candidates[0];
    let bestDist = Number.MAX_SAFE_INTEGER;
    for (const candidate of candidates) {
        const dist = levenshtein(raw.toLowerCase(), candidate.toLowerCase());
        if (dist < bestDist) {
            best = candidate;
            bestDist = dist;
        }
    }
    const threshold = Math.max(2, Math.floor(raw.length * 0.4));
    if (bestDist > threshold) return "";
    return ` Did you mean '${best}'?`;
}

export function parseBuildOrderDsl(input: string, options?: ParseBuildOrderDslOptions): BuildOrderInput {
    const selectorAliases = {
        ...DEFAULT_DSL_SELECTOR_ALIASES,
        ...(options?.selectorAliases ?? {}),
    };
    const civDslByName = options?.civDslByName ?? {};
    const civEntries = Object.entries(civDslByName);
    const civLookup = new Map<string, { name: string; dslLines: string[] }>();
    for (const [name, dslLines] of civEntries) {
        civLookup.set(name.toLowerCase(), { name, dslLines });
    }

    const state = createDslLoweringState();
    const lines = input.split(/\r?\n/);
    for (let idx = 0; idx < lines.length; idx += 1) {
        const lineNo = idx + 1;
        const raw = lines[idx] ?? "";
        const line = raw.replace(/#.*/, "").trim();
        if (!line) continue;
        const ast = parseDslAstLine(line, lineNo);
        if (ast.type === "preamble" && ast.preamble.type === "civ") {
            const key = ast.preamble.civName.toLowerCase();
            const civ = civLookup.get(key);
            if (!civ) {
                const known = civEntries.map(([name]) => name);
                throw new Error(
                    `Line ${lineNo}: unknown civilization '${ast.preamble.civName}'.${civSuggestionSuffix(ast.preamble.civName, known)}`,
                );
            }
            for (const civLineRaw of civ.dslLines) {
                const civLine = civLineRaw.replace(/#.*/, "").trim();
                if (!civLine) continue;
                const civAst = parseDslAstLine(civLine, lineNo);
                if (civAst.type === "preamble" && civAst.preamble.type === "civ") {
                    throw new Error(
                        `Line ${lineNo}: civilization '${civ.name}' contains a nested civ directive, which is not allowed.`,
                    );
                }
                applyAstDslLine(civAst, lineNo, selectorAliases, state, options?.symbols);
            }
            continue;
        }
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
