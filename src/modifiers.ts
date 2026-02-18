import { NumericModifier } from "./types";

export function selectorMatches(selector: string, key: string): boolean {
    return selector === key;
}

export function applyNumericModifiers(base: number, keys: string[], modifiers: NumericModifier[]): number {
    let out = base;
    for (const mod of modifiers) {
        const applies = keys.some((k) => selectorMatches(mod.selector, k));
        if (!applies) continue;

        if (mod.op === "mul") {
            out *= mod.value;
        } else if (mod.op === "add") {
            out += mod.value;
        } else if (mod.op === "set") {
            out = mod.value;
        }
    }
    return out;
}
