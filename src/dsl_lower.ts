import { parseDslSelectors } from "./node_selectors";
import { AstCommandCondition, AstCommandLine, AstDslLine, AstPreambleLine } from "./dsl_ast";
import {
    BuildOrderCommand,
    HumanDelayBucket,
    ResourceMap,
    ScoreCriterion,
    StopAfterCondition,
    TriggerCondition,
    TriggerMode,
} from "./types";

export interface DslLoweringState {
    commands: BuildOrderCommand[];
    evaluationTime?: number;
    stopAfter?: StopAfterCondition;
    debtFloor?: number;
    startingResources?: Record<string, number>;
    startingEntities?: Record<string, number>;
    startingResourceNodes?: Array<{ prototypeId: string; count: number }>;
    humanDelays?: Record<string, HumanDelayBucket[]>;
    scores?: ScoreCriterion[];
}

export interface DslValidationSymbols {
    actions?: Set<string>;
    entityTypes?: Set<string>;
    resources?: Set<string>;
    nodePrototypes?: Set<string>;
    nodeTags?: Set<string>;
}

export function createDslLoweringState(): DslLoweringState {
    return { commands: [] };
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

function suggestionSuffix(raw: string, candidates?: Set<string>): string {
    if (!candidates || candidates.size === 0) return "";
    let best: string | undefined;
    let bestDist = Number.MAX_SAFE_INTEGER;
    for (const candidate of candidates) {
        const dist = levenshtein(raw, candidate);
        if (dist < bestDist) {
            best = candidate;
            bestDist = dist;
        }
    }
    if (!best) return "";
    const threshold = Math.max(2, Math.floor(raw.length * 0.4));
    if (bestDist > threshold) return "";
    return ` Did you mean '${best}'?`;
}

function parseNumber(token: string, lineNo: number): number {
    const n = Number(token);
    if (!Number.isFinite(n)) throw new Error(`Line ${lineNo}: invalid number '${token}'.`);
    return n;
}

function parseTimeValue(token: string, lineNo: number): number {
    const mss = token.match(/^(\d+):(\d{1,2})$/);
    if (mss) {
        const minutes = parseInt(mss[1]!, 10);
        const seconds = parseInt(mss[2]!, 10);
        if (seconds >= 60) throw new Error(`Line ${lineNo}: invalid time '${token}' — seconds must be < 60.`);
        return minutes * 60 + seconds;
    }
    return parseNumber(token, lineNo);
}

function parseCommaEntriesFromTokens(
    tokens: string[],
    lineNo: number,
    emptyError: string,
): { entries: string[]; consumed: number } {
    const entries: string[] = [];
    let currentParts: string[] = [];
    let consumed = 0;
    for (let i = 0; i < tokens.length; i += 1) {
        const token = tokens[i];
        if (!token) continue;
        consumed += 1;
        const chunks = token.split(",");
        for (let j = 0; j < chunks.length; j += 1) {
            const chunk = chunks[j]?.trim() ?? "";
            if (chunk) currentParts.push(chunk);
            const endedByComma = j < chunks.length - 1;
            if (endedByComma) {
                const entry = currentParts.join(" ").trim();
                if (!entry) throw new Error(`Line ${lineNo}: ${emptyError}`);
                entries.push(entry);
                currentParts = [];
            }
        }
    }
    const trailing = currentParts.join(" ").trim();
    if (trailing) entries.push(trailing);
    return { entries, consumed };
}

function normalizeActorSelector(entry: string, lineNo: number): string {
    const dashedId = entry.match(/^([^\s,]+)-(\d+)$/);
    if (dashedId) return entry;
    const splitId = entry.match(/^([^\s,]+)\s+(\d+)$/);
    if (splitId) return `${splitId[1]}-${splitId[2]}`;
    if (/\s/.test(entry)) {
        throw new Error(`Line ${lineNo}: invalid actor selector '${entry}'. Use '<type>', '<type> <n>', or '<type>-<n>'.`);
    }
    return entry;
}

function parseQueueUsingSelectors(tokens: string[], lineNo: number): { selectors: string[]; consumed: number } {
    const fromIdx = tokens.findIndex((t) => t === "from");
    const scope = fromIdx >= 0 ? tokens.slice(0, fromIdx) : tokens;
    const parsed = parseCommaEntriesFromTokens(scope, lineNo, "invalid empty selector in 'using' list.");
    if (parsed.entries.length === 0) throw new Error(`Line ${lineNo}: missing actor selector after 'using'.`);
    const selectors: string[] = [];
    for (const rawEntry of parsed.entries) {
        const multiplierMatch = rawEntry.match(/^(.*?)\s+x\s*(\d+)$/);
        const selectorEntry = multiplierMatch ? multiplierMatch[1]?.trim() ?? "" : rawEntry.trim();
        const count = multiplierMatch ? parseNumber(multiplierMatch[2] ?? "", lineNo) : 1;
        if (!selectorEntry) throw new Error(`Line ${lineNo}: missing actor selector before multiplier in 'using' list.`);
        if (count < 1) throw new Error(`Line ${lineNo}: selector multiplier must be >= 1.`);
        const normalized = normalizeActorSelector(selectorEntry, lineNo);
        for (let i = 0; i < count; i += 1) selectors.push(normalized);
    }
    return { selectors, consumed: parsed.consumed };
}

function parseTriggerCondition(
    kind: string,
    target: string,
    lineNo: number,
    selectorAliases: Record<string, string>,
    symbols?: DslValidationSymbols,
): TriggerCondition {
    if (kind === "clicked" || kind === "completed") {
        if (symbols?.actions && !symbols.actions.has(target)) {
            throw new Error(
                `Line ${lineNo}: unknown action '${target}' in '${kind}' trigger.${suggestionSuffix(target, symbols.actions)}`,
            );
        }
        return { kind, actionId: target };
    }
    if (kind === "depleted" || kind === "exhausted") {
        const selector = parseDslSelectors([target], selectorAliases)[0];
        if (!selector) throw new Error(`Line ${lineNo}: invalid trigger target '${target}'.`);
        validateSelector(selector, lineNo, symbols);
        return { kind, resourceNodeSelector: selector };
    }
    throw new Error(`Line ${lineNo}: unknown trigger '${kind}'. Use 'clicked', 'completed', 'depleted', or 'exhausted'.`);
}

interface CommandCondition {
    afterEntityId?: string;
    trigger?: TriggerCondition;
    triggerMode?: TriggerMode;
}

function astConditionsToCommandConditions(
    conditions: AstCommandCondition[],
    lineNo: number,
    selectorAliases: Record<string, string>,
    symbols?: DslValidationSymbols,
): CommandCondition[] {
    const out: CommandCondition[] = [];
    for (const condition of conditions) {
        if (condition.type === "afterTrigger") {
            out.push({
                trigger: parseTriggerCondition(condition.triggerKind, condition.target, lineNo, selectorAliases, symbols),
                triggerMode: condition.mode,
            });
            continue;
        }
        if (condition.type === "onTrigger") {
            out.push({
                trigger: parseTriggerCondition(condition.triggerKind, condition.target, lineNo, selectorAliases, symbols),
                triggerMode: "every",
            });
            continue;
        }
        const dashedEntity = condition.entityToken.match(/^([^\s,]+)-(\d+)$/);
        if (dashedEntity) {
            out.push({ afterEntityId: condition.entityToken });
            continue;
        }
        if (condition.countToken && /^\d+$/.test(condition.countToken)) {
            out.push({ afterEntityId: `${condition.entityToken}-${condition.countToken}` });
            continue;
        }
        throw new Error(
            `Line ${lineNo}: unknown 'after' condition '${condition.entityToken}'. Use '<entityType> <N>' or [every] clicked/completed/depleted/exhausted.`,
        );
    }
    return out;
}

function validateSelector(selector: string, lineNo: number, symbols?: DslValidationSymbols): void {
    if (!symbols) return;
    const idx = selector.indexOf(":");
    const kind = idx >= 0 ? selector.slice(0, idx) : "id";
    const value = idx >= 0 ? selector.slice(idx + 1) : selector;
    if (kind === "res") {
        if (symbols.resources && !symbols.resources.has(value)) {
            throw new Error(`Line ${lineNo}: unknown resource '${value}'.${suggestionSuffix(value, symbols.resources)}`);
        }
        return;
    }
    if (kind === "proto") {
        if (symbols.nodePrototypes && !symbols.nodePrototypes.has(value)) {
            throw new Error(`Line ${lineNo}: unknown resource '${value}'.${suggestionSuffix(value, symbols.nodePrototypes)}`);
        }
        return;
    }
    if (kind === "tag") {
        if (symbols.nodeTags && !symbols.nodeTags.has(value)) {
            throw new Error(`Line ${lineNo}: unknown resource '${value}'.${suggestionSuffix(value, symbols.nodeTags)}`);
        }
        return;
    }
    if (kind === "actor") {
        if (value !== "idle") {
            throw new Error(`Line ${lineNo}: unknown actor selector '${value}'.`);
        }
    }
}

function parseAndValidateSelectors(
    rawSelectors: string[],
    selectorAliases: Record<string, string>,
    lineNo: number,
    symbols?: DslValidationSymbols,
): string[] {
    const selectors = parseDslSelectors(rawSelectors, selectorAliases);
    for (const selector of selectors) validateSelector(selector, lineNo, symbols);
    return selectors;
}

function wrapCommandWithConditions(at: number, conditions: CommandCondition[], cmd: BuildOrderCommand): BuildOrderCommand {
    let wrapped: BuildOrderCommand = cmd;
    for (let i = conditions.length - 1; i >= 0; i -= 1) {
        const condition = conditions[i];
        if (!condition) continue;
        if (condition.trigger) {
            const nested = { ...wrapped };
            delete nested.at;
            delete nested.afterEntityId;
            wrapped = {
                type: "onTrigger",
                ...(i === 0 ? { at } : {}),
                ...(condition.afterEntityId !== undefined ? { afterEntityId: condition.afterEntityId } : {}),
                trigger: condition.trigger,
                ...(condition.triggerMode !== undefined ? { triggerMode: condition.triggerMode } : {}),
                command: nested,
            };
            continue;
        }
        if (condition.afterEntityId !== undefined) {
            wrapped = { ...wrapped, ...(i === 0 ? { at } : {}), afterEntityId: condition.afterEntityId };
        }
    }
    return wrapped;
}

function buildCommandFromDirectiveTokens(
    at: number,
    rest: string[],
    lineNo: number,
    selectorAliases: Record<string, string>,
    conditions: CommandCondition[],
    symbols?: DslValidationSymbols,
): BuildOrderCommand[] {
    const hasTriggerCondition = conditions.some((condition) => condition.trigger !== undefined);
    const wrap = (cmd: BuildOrderCommand): BuildOrderCommand => wrapCommandWithConditions(at, conditions, cmd);
    const op = rest[0];
    if (!op) throw new Error(`Line ${lineNo}: expected directive after condition prefix.`);

    if (op === "queue") {
        if (!rest[1]) throw new Error(`Line ${lineNo}: missing action id.`);
        const actionId = rest[1];
        if (symbols?.actions && !symbols.actions.has(actionId)) {
            throw new Error(`Line ${lineNo}: unknown action '${actionId}'.${suggestionSuffix(actionId, symbols.actions)}`);
        }
        let count: number | undefined;
        let actorSelectors: string[] | undefined;
        let actorResourceNodeSelectors: string[] | undefined;
        for (let i = 2; i < rest.length; i += 1) {
            const t = rest[i];
            if (!t) continue;
            if (t === "x") {
                const n = rest[i + 1];
                if (!n) throw new Error(`Line ${lineNo}: missing count after 'x'.`);
                count = parseNumber(n, lineNo);
                i += 1;
                continue;
            }
            if (t.startsWith("x")) {
                count = parseNumber(t.slice(1), lineNo);
                continue;
            }
            if (t === "using") {
                const parsed = parseQueueUsingSelectors(rest.slice(i + 1), lineNo);
                actorSelectors = parsed.selectors;
                i += parsed.consumed;
                continue;
            }
            if (t === "from") {
                const selectors = parseAndValidateSelectors(rest.slice(i + 1), selectorAliases, lineNo, symbols);
                if (selectors.length === 0) throw new Error(`Line ${lineNo}: queue 'from' requires at least one selector.`);
                actorResourceNodeSelectors = selectors;
                i = rest.length;
                continue;
            }
            throw new Error(`Line ${lineNo}: unknown queue token '${t}'.`);
        }
        const cmd: Extract<BuildOrderCommand, { type: "queueAction" }> = { type: "queueAction", at, actionId };
        if (count !== undefined) cmd.count = count;
        if (actorSelectors !== undefined) cmd.actorSelectors = actorSelectors;
        if (actorResourceNodeSelectors !== undefined) cmd.actorResourceNodeSelectors = actorResourceNodeSelectors;
        return [wrap(cmd)];
    }

    if (op === "assign") {
        const toIdx = rest.indexOf("to");
        if (toIdx < 0 || toIdx + 1 >= rest.length) throw new Error(`Line ${lineNo}: assign requires 'to <selectors...>'.`);
        if (rest[1] === "event" || (hasTriggerCondition && rest[1] === "to")) {
            const selectors = rest.slice(toIdx + 1).map((raw) => {
                if (raw === "created") return "id:created";
                const parsed = parseAndValidateSelectors([raw], selectorAliases, lineNo, symbols)[0];
                return parsed ?? "";
            });
            if (selectors.some((x) => !x)) throw new Error(`Line ${lineNo}: invalid selector in 'assign event ...'.`);
            return [wrap({ type: "assignEventGather", at, resourceNodeSelectors: selectors })];
        }
        const fromIdx = rest.indexOf("from");
        if (fromIdx >= 0 && fromIdx >= toIdx) throw new Error(`Line ${lineNo}: 'from' must appear before 'to' in assign.`);
        const selectors = parseAndValidateSelectors(rest.slice(toIdx + 1), selectorAliases, lineNo, symbols);
        const fromSelectors =
            fromIdx >= 0 ? parseAndValidateSelectors(rest.slice(fromIdx + 1, toIdx), selectorAliases, lineNo, symbols) : undefined;
        if (fromIdx >= 0 && (!fromSelectors || fromSelectors.length === 0)) {
            throw new Error(`Line ${lineNo}: assign 'from' requires at least one selector.`);
        }
        const actorType = rest[1];
        const amountToken = rest[2];
        if (!actorType || !amountToken) {
            throw new Error(`Line ${lineNo}: expected 'assign <actorType> <xN|idNum|all> [from ...] to ...'.`);
        }
        if (symbols?.entityTypes && !symbols.entityTypes.has(actorType)) {
            throw new Error(`Line ${lineNo}: unknown actor type '${actorType}'.${suggestionSuffix(actorType, symbols.entityTypes)}`);
        }
        const cmd: Extract<BuildOrderCommand, { type: "assignGather" }> = {
            type: "assignGather",
            at,
            actorType,
            ...(fromSelectors !== undefined ? { actorResourceNodeSelectors: fromSelectors } : {}),
            resourceNodeSelectors: selectors,
        };
        if (amountToken.startsWith("x")) {
            const n = amountToken.slice(1);
            if (!n) throw new Error(`Line ${lineNo}: missing count after 'x'.`);
            cmd.count = parseNumber(n, lineNo);
        } else if (amountToken === "all") {
            cmd.all = true;
        } else if (/^\d+$/.test(amountToken)) {
            cmd.actorSelectors = [`${actorType}-${amountToken}`];
        } else {
            throw new Error(`Line ${lineNo}: assign amount must be 'x<count>', 'all', or '<idNum>'.`);
        }
        return [wrap(cmd)];
    }

    if (op === "auto-queue") {
        const actionId = rest[1];
        if (!actionId) throw new Error(`Line ${lineNo}: missing action id for auto-queue.`);
        if (symbols?.actions && !symbols.actions.has(actionId)) {
            throw new Error(`Line ${lineNo}: unknown action '${actionId}'.${suggestionSuffix(actionId, symbols.actions)}`);
        }
        let actorType: string | undefined;
        let actorResourceNodeSelectors: string[] | undefined;
        for (let i = 2; i < rest.length; i += 1) {
            const t = rest[i];
            if (!t) continue;
            if (t === "using") {
                const parsed = parseQueueUsingSelectors(rest.slice(i + 1), lineNo);
                if (parsed.selectors.length !== 1) throw new Error(`Line ${lineNo}: auto-queue supports exactly one selector in 'using'.`);
                const selector = parsed.selectors[0];
                if (!selector) throw new Error(`Line ${lineNo}: missing selector after 'using'.`);
                if (selector.match(/^(.*)-(\d+)$/)) throw new Error(`Line ${lineNo}: auto-queue 'using' must be an actor type, not a specific ID.`);
                actorType = selector;
                i += parsed.consumed;
                continue;
            }
            if (t === "from") {
                const selectors = parseAndValidateSelectors(rest.slice(i + 1), selectorAliases, lineNo, symbols);
                if (selectors.length === 0) throw new Error(`Line ${lineNo}: auto-queue 'from' requires at least one selector.`);
                actorResourceNodeSelectors = selectors;
                i = rest.length;
                continue;
            }
            throw new Error(`Line ${lineNo}: unknown auto-queue token '${t}'.`);
        }
        const cmd: Extract<BuildOrderCommand, { type: "autoQueue" }> = { type: "autoQueue", at, actionId };
        if (actorType !== undefined) cmd.actorType = actorType;
        if (actorResourceNodeSelectors !== undefined) cmd.actorResourceNodeSelectors = actorResourceNodeSelectors;
        return [wrap(cmd)];
    }

    if (op === "stop-auto-queue") {
        const actionId = rest[1];
        if (!actionId) throw new Error(`Line ${lineNo}: missing action id for stop-auto-queue.`);
        if (symbols?.actions && !symbols.actions.has(actionId)) {
            throw new Error(`Line ${lineNo}: unknown action '${actionId}'.${suggestionSuffix(actionId, symbols.actions)}`);
        }
        let actorType: string | undefined;
        let actorResourceNodeSelectors: string[] | undefined;
        for (let i = 2; i < rest.length; i += 1) {
            const t = rest[i];
            if (!t) continue;
            if (t === "using") {
                const parsed = parseQueueUsingSelectors(rest.slice(i + 1), lineNo);
                if (parsed.selectors.length !== 1) throw new Error(`Line ${lineNo}: stop-auto-queue supports exactly one selector in 'using'.`);
                const selector = parsed.selectors[0];
                if (!selector) throw new Error(`Line ${lineNo}: missing selector after 'using'.`);
                if (selector.match(/^(.*)-(\d+)$/)) throw new Error(`Line ${lineNo}: stop-auto-queue 'using' must be an actor type, not a specific ID.`);
                actorType = selector;
                i += parsed.consumed;
                continue;
            }
            if (t === "from") {
                const selectors = parseAndValidateSelectors(rest.slice(i + 1), selectorAliases, lineNo, symbols);
                if (selectors.length === 0) throw new Error(`Line ${lineNo}: stop-auto-queue 'from' requires at least one selector.`);
                actorResourceNodeSelectors = selectors;
                i = rest.length;
                continue;
            }
            throw new Error(`Line ${lineNo}: unknown stop-auto-queue token '${t}'.`);
        }
        const cmd: Extract<BuildOrderCommand, { type: "stopAutoQueue" }> = { type: "stopAutoQueue", at, actionId };
        if (actorType !== undefined) cmd.actorType = actorType;
        if (actorResourceNodeSelectors !== undefined) cmd.actorResourceNodeSelectors = actorResourceNodeSelectors;
        return [wrap(cmd)];
    }

    if (op === "spawn-assign") {
        const entityType = rest[1];
        if (entityType && symbols?.entityTypes && !symbols.entityTypes.has(entityType)) {
            throw new Error(`Line ${lineNo}: unknown entity type '${entityType}'.${suggestionSuffix(entityType, symbols.entityTypes)}`);
        }
        const toIdx = rest.indexOf("to");
        const selector = toIdx >= 0 ? rest[toIdx + 1] : undefined;
        if (!entityType || toIdx < 0 || !selector || toIdx + 2 !== rest.length) {
            throw new Error(`Line ${lineNo}: expected 'spawn-assign <entityType> to <selector>'.`);
        }
        return [wrap({
            type: "setSpawnGather",
            at,
            entityType,
            resourceNodeSelectors: parseAndValidateSelectors([selector], selectorAliases, lineNo, symbols),
        })];
    }

    if (op === "grant") {
        const resources: ResourceMap = {};
        for (let i = 1; i + 1 < rest.length; i += 2) {
            const resource = rest[i]!;
            const amount = rest[i + 1]!;
            if (symbols?.resources && !symbols.resources.has(resource)) {
                throw new Error(`Line ${lineNo}: unknown resource '${resource}'.${suggestionSuffix(resource, symbols.resources)}`);
            }
            resources[resource] = parseNumber(amount, lineNo);
        }
        if (Object.keys(resources).length === 0) {
            throw new Error(`Line ${lineNo}: 'grant' requires at least one <resource> <amount> pair.`);
        }
        return [wrap({ type: "grantResources", at, resources })];
    }

    if (op === "spawn") {
        const entityType = rest[1];
        if (!entityType) throw new Error(`Line ${lineNo}: 'spawn' requires an entity type.`);
        if (symbols?.entityTypes && !symbols.entityTypes.has(entityType)) {
            throw new Error(`Line ${lineNo}: unknown entity type '${entityType}'.${suggestionSuffix(entityType, symbols.entityTypes)}`);
        }
        const countToken = rest[2];
        const count = countToken !== undefined ? parseNumber(countToken, lineNo) : 1;
        if (!Number.isInteger(count) || count < 1) throw new Error(`Line ${lineNo}: spawn count must be a positive integer.`);
        return [wrap({ type: "spawnEntities", at, entityType, count })];
    }

    if (op === "buy" || op === "sell") {
        const amountToken = rest[1];
        const resource = rest[2];
        if (!amountToken || !resource || rest.length !== 3) {
            throw new Error(`Line ${lineNo}: expected '${op} <amount> <resource>'.`);
        }
        if (symbols?.resources && !symbols.resources.has(resource)) {
            throw new Error(
                `Line ${lineNo}: unknown resource '${resource}'.${suggestionSuffix(resource, symbols.resources)}`,
            );
        }
        const amount = parseNumber(amountToken, lineNo);
        if (!Number.isInteger(amount) || amount <= 0) {
            throw new Error(`Line ${lineNo}: ${op} amount must be a positive integer.`);
        }
        if (amount % 100 !== 0) {
            throw new Error(`Line ${lineNo}: ${op} amount must be a multiple of 100.`);
        }
        if (resource === "gold") {
            throw new Error(`Line ${lineNo}: ${op} resource cannot be gold.`);
        }
        const lots = amount / 100;
        const out: BuildOrderCommand[] = [];
        for (let i = 0; i < lots; i += 1) {
            out.push(
                wrap({
                    type: "tradeResources",
                    at,
                    amount: 100,
                    sellResource: op === "sell" ? resource : "gold",
                    buyResource: op === "sell" ? "gold" : resource,
                }),
            );
        }
        return out;
    }

    if (op === "modifier") {
        const selector = rest[1];
        const opToken = rest[2];
        const valueToken = rest[3];
        if (!selector || !opToken || !valueToken) {
            throw new Error(`Line ${lineNo}: 'modifier' requires '<selector> <op> <value>'.`);
        }
        if (opToken !== "mul" && opToken !== "add" && opToken !== "set") {
            throw new Error(`Line ${lineNo}: modifier op must be 'mul', 'add', or 'set'.`);
        }
        return [wrap({ type: "addModifier", at, modifier: { selector, op: opToken, value: parseNumber(valueToken, lineNo) } })];
    }

    throw new Error(`Line ${lineNo}: unknown directive '${op}'.`);
}

function lowerAstCommandLine(
    ast: AstCommandLine,
    lineNo: number,
    selectorAliases: Record<string, string>,
    symbols?: DslValidationSymbols,
): BuildOrderCommand[] {
    const at = ast.atToken !== undefined ? parseTimeValue(ast.atToken, lineNo) : 0;
    const conditions = astConditionsToCommandConditions(ast.conditions, lineNo, selectorAliases, symbols);
    const out = [...buildCommandFromDirectiveTokens(at, ast.directiveTokens, lineNo, selectorAliases, conditions, symbols)];
    if (!ast.thenDirectiveTokens) return out;
    if (ast.directiveTokens[0] !== "queue") {
        throw new Error(`Line ${lineNo}: 'then' is currently only supported after a queue directive.`);
    }
    const queuedActionId = ast.directiveTokens[1];
    if (!queuedActionId) throw new Error(`Line ${lineNo}: missing action id before 'then'.`);
    let normalizedThenDirectiveTokens = [...ast.thenDirectiveTokens];
    const inheritedQueueUsingSelectors = inferInheritedQueueUsingSelectors(ast.directiveTokens, lineNo);
    const inheritedSpecificActorId =
        inheritedQueueUsingSelectors.length === 1 && inheritedQueueUsingSelectors[0]?.match(/^(.*)-(\d+)$/)
            ? inheritedQueueUsingSelectors[0]
            : undefined;
    if (
        normalizedThenDirectiveTokens[0] === "queue" &&
        !normalizedThenDirectiveTokens.includes("using") &&
        inheritedQueueUsingSelectors.length > 0 &&
        inheritedQueueUsingSelectors.every((selector) => selector.match(/^(.*)-(\d+)$/))
    ) {
        normalizedThenDirectiveTokens = [
            ...normalizedThenDirectiveTokens,
            "using",
            ...inheritedQueueUsingSelectors,
        ];
    }
    if (
        normalizedThenDirectiveTokens[0] === "assign" &&
        normalizedThenDirectiveTokens[1] === "to" &&
        inheritedSpecificActorId !== undefined
    ) {
        const match = inheritedSpecificActorId.match(/^(.*)-(\d+)$/);
        normalizedThenDirectiveTokens = [
            "assign",
            match?.[1] ?? "",
            match?.[2] ?? "",
            ...normalizedThenDirectiveTokens.slice(1),
        ];
    }
    const thenConditions: CommandCondition[] = [
        ...conditions,
        ...(inheritedSpecificActorId !== undefined ? [{ afterEntityId: inheritedSpecificActorId }] : []),
        {
            trigger: parseTriggerCondition("completed", queuedActionId, lineNo, selectorAliases, symbols),
            triggerMode: "once",
        },
    ];
    out.push(
        ...buildCommandFromDirectiveTokens(at, normalizedThenDirectiveTokens, lineNo, selectorAliases, thenConditions, symbols),
    );
    return out;
}

function inferInheritedQueueUsingSelectors(directiveTokens: string[], lineNo: number): string[] {
    if (directiveTokens[0] !== "queue") return [];
    const selectors: string[] = [];
    for (let i = 2; i < directiveTokens.length; i += 1) {
        const token = directiveTokens[i];
        if (!token) continue;
        if (token === "using") {
            const parsed = parseQueueUsingSelectors(directiveTokens.slice(i + 1), lineNo);
            selectors.push(...parsed.selectors);
            break;
        }
    }
    return selectors;
}

function applyPreambleLine(
    preamble: AstPreambleLine,
    lineNo: number,
    selectorAliases: Record<string, string>,
    state: DslLoweringState,
    symbols?: DslValidationSymbols,
): void {
    if (preamble.type === "evaluation") {
        state.evaluationTime = parseTimeValue(preamble.timeToken, lineNo);
        return;
    }
    if (preamble.type === "debtFloor") {
        state.debtFloor = parseNumber(preamble.valueToken, lineNo);
        return;
    }
    if (preamble.type === "stopAfter") {
        const condition = parseTriggerCondition(preamble.condKind, preamble.condTarget, lineNo, selectorAliases, symbols);
        const count = preamble.countToken !== undefined ? parseNumber(preamble.countToken, lineNo) : undefined;
        state.stopAfter = { condition, ...(count !== undefined ? { count } : {}) };
        return;
    }
    if (preamble.type === "civ") {
        throw new Error(`Line ${lineNo}: internal error: unresolved civ directive '${preamble.civName}'.`);
    }
    if (preamble.type === "ruleset") {
        throw new Error(`Line ${lineNo}: internal error: unresolved ruleset directive '${preamble.rulesetName}'.`);
    }
    if (preamble.type === "setting") {
        throw new Error(`Line ${lineNo}: internal error: unresolved setting directive '${preamble.settingName}'.`);
    }
    if (preamble.type === "startingResource") {
        if (symbols?.resources && !symbols.resources.has(preamble.resource)) {
            throw new Error(
                `Line ${lineNo}: unknown resource '${preamble.resource}'.${suggestionSuffix(preamble.resource, symbols.resources)}`,
            );
        }
        if (!state.startingResources) state.startingResources = {};
        state.startingResources[preamble.resource] = parseNumber(preamble.amountToken, lineNo);
        return;
    }
    if (preamble.type === "startWith") {
        const parsed = parseCommaEntriesFromTokens(preamble.entries, lineNo, "invalid empty item in 'start with' list.");
        if (!state.startingEntities) state.startingEntities = {};
        for (const entry of parsed.entries) {
            const m = entry.match(/^([^\s,]+)(?:\s+x(\d+))?$/);
            if (!m) {
                throw new Error(`Line ${lineNo}: invalid start-with item '${entry}'. Use '<entityType>' or '<entityType> x<count>'.`);
            }
            const entityType = m[1];
            if (!entityType) continue;
            if (symbols?.entityTypes && !symbols.entityTypes.has(entityType)) {
                throw new Error(
                    `Line ${lineNo}: unknown entity type '${entityType}'.${suggestionSuffix(entityType, symbols.entityTypes)}`,
                );
            }
            const count = m[2] ? parseNumber(m[2], lineNo) : 1;
            state.startingEntities[entityType] = (state.startingEntities[entityType] ?? 0) + count;
        }
        return;
    }
    if (preamble.type === "startNode") {
        if (symbols?.nodePrototypes && !symbols.nodePrototypes.has(preamble.prototypeId)) {
            throw new Error(
                `Line ${lineNo}: unknown resource node prototype '${preamble.prototypeId}'.${suggestionSuffix(preamble.prototypeId, symbols.nodePrototypes)}`,
            );
        }
        const count = preamble.countToken !== undefined ? parseNumber(preamble.countToken, lineNo) : 1;
        if (!Number.isInteger(count) || count < 1) throw new Error(`Line ${lineNo}: start-node count must be a positive integer.`);
        if (!state.startingResourceNodes) state.startingResourceNodes = [];
        state.startingResourceNodes.push({ prototypeId: preamble.prototypeId, count });
        return;
    }
    if (preamble.type === "scoreTime") {
        const condition = parseTriggerCondition(preamble.condKind, preamble.condTarget, lineNo, selectorAliases, symbols);
        const count = preamble.countToken !== undefined ? parseNumber(preamble.countToken, lineNo) : undefined;
        if (!state.scores) state.scores = [];
        state.scores.push({ method: "time", condition, ...(count !== undefined ? { count } : {}) });
        return;
    }
    if (symbols?.actions && !symbols.actions.has(preamble.actionId)) {
        throw new Error(`Line ${lineNo}: unknown action '${preamble.actionId}'.${suggestionSuffix(preamble.actionId, symbols.actions)}`);
    }
    const chance = parseNumber(preamble.chanceToken, lineNo);
    const minSeconds = parseNumber(preamble.minToken, lineNo);
    const maxSeconds = parseNumber(preamble.maxToken, lineNo);
    if (chance < 0 || chance > 1) throw new Error(`Line ${lineNo}: human-delay chance must be between 0 and 1.`);
    if (minSeconds < 0 || maxSeconds < 0 || maxSeconds < minSeconds) {
        throw new Error(`Line ${lineNo}: human-delay requires 0 <= minSec <= maxSec.`);
    }
    if (!state.humanDelays) state.humanDelays = {};
    const buckets = state.humanDelays[preamble.actionId] ?? [];
    buckets.push({ chance, minSeconds, maxSeconds });
    const totalChance = buckets.reduce((sum, bucket) => sum + bucket.chance, 0);
    if (totalChance > 1 + 1e-9) {
        throw new Error(`Line ${lineNo}: human-delay total chance for '${preamble.actionId}' cannot exceed 1.`);
    }
    state.humanDelays[preamble.actionId] = buckets;
}

export function applyAstDslLine(
    line: AstDslLine,
    lineNo: number,
    selectorAliases: Record<string, string>,
    state: DslLoweringState,
    symbols?: DslValidationSymbols,
): void {
    if (line.type === "preamble") {
        applyPreambleLine(line.preamble, lineNo, selectorAliases, state, symbols);
        return;
    }
    state.commands.push(...lowerAstCommandLine(line.command, lineNo, selectorAliases, symbols));
}
