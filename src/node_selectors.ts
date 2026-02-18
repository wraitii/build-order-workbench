import { ResourceNodeInstance } from "./types";

export const DEFAULT_DSL_SELECTOR_ALIASES: Record<string, string> = {
    food: "res:food",
    wood: "res:wood",
    gold: "res:gold",
    stone: "res:stone",
    farm: "tag:farm",
    idle: "actor:idle",
};

export function createDslSelectorAliases(resources: string[]): Record<string, string> {
    const aliases: Record<string, string> = { ...DEFAULT_DSL_SELECTOR_ALIASES };
    for (const resource of resources) {
        aliases[resource] = `res:${resource}`;
    }
    return aliases;
}

function splitSelector(selector: string): { kind: string; value: string } {
    const idx = selector.indexOf(":");
    if (idx < 0) return { kind: "id", value: selector };
    return { kind: selector.slice(0, idx), value: selector.slice(idx + 1) };
}

export function canonicalizeDslSelectorToken(raw: string, selectorAliases: Record<string, string>): string {
    if (raw.includes(":")) return raw;
    const aliased = selectorAliases[raw];
    if (aliased) return aliased;
    return `proto:${raw}`;
}

export function parseDslSelectors(tokens: string[], selectorAliases: Record<string, string>): string[] {
    return tokens.map((raw) => canonicalizeDslSelectorToken(raw, selectorAliases));
}

export function matchesNodeSelector(
    node: Pick<ResourceNodeInstance, "id" | "prototypeId" | "tags" | "produces">,
    selector: string,
): boolean {
    const { kind, value } = splitSelector(selector);
    if (kind === "id") return node.id === value;
    if (kind === "proto") return node.prototypeId === value;
    if (kind === "tag") return node.tags.includes(value);
    if (kind === "res") return node.produces === value;
    return false;
}
