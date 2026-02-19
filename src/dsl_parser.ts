import { createToken, CstNode, CstParser, Lexer } from "chevrotain";
import { AstCommandCondition, AstCommandLine, AstDslLine, AstTriggerKind } from "./dsl_ast";
import { tokenizeDslLine } from "./dsl_tokenizer";

const WhiteSpace = createToken({ name: "WhiteSpace", pattern: /[ \t\r\n]+/, group: Lexer.SKIPPED });
const Comma = createToken({ name: "Comma", pattern: /,/ });
const Time = createToken({ name: "Time", pattern: /\d+:\d{1,2}/ });
const NumberTok = createToken({ name: "NumberTok", pattern: /-?\d+(?:\.\d+)?/ });
const At = createToken({ name: "At", pattern: /at(?![^,\s])/ });
const After = createToken({ name: "After", pattern: /after(?![^,\s])/ });
const Every = createToken({ name: "Every", pattern: /every(?![^,\s])/ });
const On = createToken({ name: "On", pattern: /on(?![^,\s])/ });
const Then = createToken({ name: "Then", pattern: /then(?![^,\s])/ });
const Clicked = createToken({ name: "Clicked", pattern: /clicked(?![^,\s])/ });
const Completed = createToken({ name: "Completed", pattern: /completed(?![^,\s])/ });
const Depleted = createToken({ name: "Depleted", pattern: /depleted(?![^,\s])/ });
const Exhausted = createToken({ name: "Exhausted", pattern: /exhausted(?![^,\s])/ });
const Word = createToken({ name: "Word", pattern: /[^,\s]+/ });

const allTokens = [
    WhiteSpace,
    Comma,
    Time,
    NumberTok,
    At,
    After,
    Every,
    On,
    Then,
    Clicked,
    Completed,
    Depleted,
    Exhausted,
    Word,
];

const commandLexer = new Lexer(allTokens);

function tokenToTriggerKind(image: string): AstTriggerKind {
    if (image === "clicked" || image === "completed" || image === "depleted" || image === "exhausted") {
        return image;
    }
    throw new Error(`internal parser error: invalid trigger kind '${image}'`);
}

function collapseCommas(tokens: string[]): string[] {
    const out: string[] = [];
    for (const token of tokens) {
        if (token === ",") {
            const last = out[out.length - 1];
            if (!last) {
                out.push(",");
                continue;
            }
            out[out.length - 1] = `${last},`;
            continue;
        }
        out.push(token);
    }
    return out;
}

class CommandLineCstParser extends CstParser {
    constructor() {
        super(allTokens, { recoveryEnabled: false });
        const self = this as any;

        this.RULE("commandLine", () => {
            this.OPTION(() => {
                this.SUBRULE(self.atClause);
            });

            this.MANY(() => {
                this.SUBRULE(self.afterCondition);
            });

            this.OPTION2(() => {
                this.SUBRULE(self.onCondition);
            });

            this.SUBRULE(self.directiveTokens);

            this.OPTION3(() => {
                this.CONSUME(Then);
                this.SUBRULE2(self.directiveTokens, { LABEL: "thenDirectiveTokens" });
            });
        });

        this.RULE("atClause", () => {
            this.CONSUME(At);
            this.OR([{ ALT: () => this.CONSUME(Time) }, { ALT: () => this.CONSUME(NumberTok) }]);
        });

        this.RULE("triggerKeyword", () => {
            this.OR([
                { ALT: () => this.CONSUME(Clicked) },
                { ALT: () => this.CONSUME(Completed) },
                { ALT: () => this.CONSUME(Depleted) },
                { ALT: () => this.CONSUME(Exhausted) },
            ]);
        });

        this.RULE("afterCondition", () => {
            this.CONSUME(After);
            this.OPTION(() => this.CONSUME(Every));
            this.OR([
                {
                    GATE: () => {
                        const next = this.LA(1).tokenType;
                        return next === Clicked || next === Completed || next === Depleted || next === Exhausted;
                    },
                    ALT: () => {
                        this.SUBRULE(self.triggerKeyword);
                        this.CONSUME(Word, { LABEL: "afterTarget" });
                    },
                },
                {
                    ALT: () => {
                        this.CONSUME2(Word, { LABEL: "entityToken" });
                        this.OPTION2(() => this.CONSUME(NumberTok, { LABEL: "entityCount" }));
                    },
                },
            ]);
        });

        this.RULE("onCondition", () => {
            this.CONSUME(On);
            this.SUBRULE(self.triggerKeyword);
            this.CONSUME(Word, { LABEL: "onTarget" });
        });

        this.RULE("directiveTokens", () => {
            this.AT_LEAST_ONE({
                DEF: () => this.SUBRULE(self.directiveToken),
            });
        });

        this.RULE("directiveToken", () => {
            this.OR([
                { ALT: () => this.CONSUME(Comma) },
                {
                    GATE: () => this.LA(1).tokenType !== Then,
                    ALT: () =>
                        this.OR2([
                            { ALT: () => this.CONSUME(Time) },
                            { ALT: () => this.CONSUME(NumberTok) },
                            { ALT: () => this.CONSUME(At) },
                            { ALT: () => this.CONSUME(After) },
                            { ALT: () => this.CONSUME(Every) },
                            { ALT: () => this.CONSUME(On) },
                            { ALT: () => this.CONSUME(Clicked) },
                            { ALT: () => this.CONSUME(Completed) },
                            { ALT: () => this.CONSUME(Depleted) },
                            { ALT: () => this.CONSUME(Exhausted) },
                            { ALT: () => this.CONSUME(Word) },
                        ]),
                },
            ]);
        });

        this.performSelfAnalysis();
    }
}

const parser = new CommandLineCstParser();

function imageOf(token: unknown): string | undefined {
    if (typeof token !== "object" || token === null) return undefined;
    const maybe = token as { image?: unknown };
    return typeof maybe.image === "string" ? maybe.image : undefined;
}

function collectDirectiveImages(node: CstNode): string[] {
    const images: string[] = [];
    const tokens = node.children.directiveToken ?? [];
    for (const tokenNode of tokens) {
        if (!("children" in tokenNode)) continue;
        const childLists = Object.values(tokenNode.children);
        for (const list of childLists) {
            for (const token of list) {
                if ("image" in token) images.push(token.image);
            }
        }
    }
    return collapseCommas(images);
}

function toAstConditions(commandLine: CstNode, lineNo: number): AstCommandCondition[] {
    const out: AstCommandCondition[] = [];
    const afterNodes = commandLine.children.afterCondition ?? [];
    for (const node of afterNodes) {
        if (!("children" in node)) continue;
        const c = node.children;
        const every = (c.Every?.length ?? 0) > 0;
        const triggerNode = c.triggerKeyword?.[0];
        const triggerChildren = triggerNode && "children" in triggerNode ? triggerNode.children : undefined;
        const triggerToken =
            triggerChildren?.Clicked?.[0] ??
            triggerChildren?.Completed?.[0] ??
            triggerChildren?.Depleted?.[0] ??
            triggerChildren?.Exhausted?.[0] ??
            undefined;
        if (triggerToken) {
            const target = c.afterTarget?.[0];
            const targetImage = imageOf(target);
            if (!targetImage) throw new Error(`Line ${lineNo}: expected trigger target after 'after'.`);
            out.push({
                type: "afterTrigger",
                triggerKind: tokenToTriggerKind(imageOf(triggerToken) ?? ""),
                target: targetImage,
                mode: every ? "every" : "once",
            });
            continue;
        }

        if (every) {
            throw new Error(`Line ${lineNo}: 'after every' can only be used with clicked/completed/depleted/exhausted.`);
        }

        const entityToken = c.entityToken?.[0];
        const entityTokenImage = imageOf(entityToken);
        if (!entityTokenImage) throw new Error(`Line ${lineNo}: expected condition after 'after'.`);
        const countToken = c.entityCount?.[0];
        const countTokenImage = imageOf(countToken);
        out.push({
            type: "afterEntity",
            entityToken: entityTokenImage,
            ...(countTokenImage !== undefined ? { countToken: countTokenImage } : {}),
        });
    }

    const onNodes = commandLine.children.onCondition ?? [];
    for (const node of onNodes) {
        if (!("children" in node)) continue;
        const c = node.children;
        const triggerNode = c.triggerKeyword?.[0];
        const triggerChildren = triggerNode && "children" in triggerNode ? triggerNode.children : undefined;
        const triggerToken =
            triggerChildren?.Clicked?.[0] ??
            triggerChildren?.Completed?.[0] ??
            triggerChildren?.Depleted?.[0] ??
            triggerChildren?.Exhausted?.[0] ??
            undefined;
        const target = c.onTarget?.[0];
        const targetImage = imageOf(target);
        if (!triggerToken || !targetImage) {
            throw new Error(`Line ${lineNo}: expected 'on <clicked|completed|depleted|exhausted> <target> <directive...>'.`);
        }
        out.push({
            type: "onTrigger",
            triggerKind: tokenToTriggerKind(imageOf(triggerToken) ?? ""),
            target: targetImage,
        });
    }

    return out;
}

export function parseDslCommandLine(line: string, lineNo: number): AstCommandLine {
    const lexResult = commandLexer.tokenize(line);
    if (lexResult.errors.length > 0) {
        const first = lexResult.errors[0];
        throw new Error(`Line ${lineNo}: ${first?.message ?? "lexer error"}\n  source: ${line}`);
    }

    parser.input = lexResult.tokens;
    const cst = (parser as any).commandLine();
    if (parser.errors.length > 0) {
        const first = parser.errors[0];
        throw new Error(`Line ${lineNo}: ${first?.message ?? "parse error"}\n  source: ${line}`);
    }

    const atClause = cst.children.atClause?.[0];
    let atToken: string | undefined;
    if (atClause && "children" in atClause) {
        const atTime = atClause.children.Time?.[0] ?? atClause.children.NumberTok?.[0];
        if (!atTime || !("image" in atTime)) throw new Error(`Line ${lineNo}: expected 'at <time> ...'.`);
        atToken = atTime.image;
    }

    const directiveNode = cst.children.directiveTokens?.[0];
    if (!directiveNode || !("children" in directiveNode)) {
        throw new Error(`Line ${lineNo}: expected directive.`);
    }
    const directiveTokens = collectDirectiveImages(directiveNode);
    if (directiveTokens.length === 0) throw new Error(`Line ${lineNo}: expected directive.`);

    let thenDirectiveTokens: string[] | undefined;
    const thenNode = cst.children.thenDirectiveTokens?.[0];
    if (thenNode && "children" in thenNode) {
        thenDirectiveTokens = collectDirectiveImages(thenNode);
        if (thenDirectiveTokens.length === 0) {
            throw new Error(`Line ${lineNo}: expected directive after 'then'.`);
        }
    }

    return {
        ...(atToken !== undefined ? { atToken } : {}),
        conditions: toAstConditions(cst, lineNo),
        directiveTokens,
        ...(thenDirectiveTokens !== undefined ? { thenDirectiveTokens } : {}),
    };
}

export function parseDslAstLine(line: string, lineNo: number): AstDslLine {
    const tokens = tokenizeDslLine(line, lineNo);
    const op = tokens[0];

    if (op === "evaluation") {
        const timeToken = tokens[1];
        if (!timeToken) throw new Error(`Line ${lineNo}: missing evaluation time.`);
        return { type: "preamble", preamble: { type: "evaluation", timeToken } };
    }

    if (op === "stop" && tokens[1] === "after") {
        const condKind = tokens[2];
        const condTarget = tokens[3];
        if (!condKind || !condTarget) {
            throw new Error(
                `Line ${lineNo}: expected 'stop after <clicked|completed|depleted|exhausted> <target> [x<count>]'.`,
            );
        }
        if (condKind !== "clicked" && condKind !== "completed" && condKind !== "depleted" && condKind !== "exhausted") {
            throw new Error(
                `Line ${lineNo}: unknown trigger '${condKind}'. Use 'clicked', 'completed', 'depleted', or 'exhausted'.`,
            );
        }
        let countToken: string | undefined;
        const maybeCount = tokens[4];
        if (maybeCount) {
            if (maybeCount === "x" && tokens[5]) {
                countToken = tokens[5];
            } else if (maybeCount.startsWith("x")) {
                countToken = maybeCount.slice(1);
            } else {
                throw new Error(`Line ${lineNo}: unexpected token '${maybeCount}' after stop target.`);
            }
        }
        return {
            type: "preamble",
            preamble: {
                type: "stopAfter",
                condKind,
                condTarget,
                ...(countToken !== undefined ? { countToken } : {}),
            },
        };
    }

    if (op === "debt-floor") {
        const valueToken = tokens[1];
        if (!valueToken) throw new Error(`Line ${lineNo}: missing debt floor value.`);
        return { type: "preamble", preamble: { type: "debtFloor", valueToken } };
    }

    if (op === "civ") {
        const civName = tokens.slice(1).join(" ").trim();
        if (!civName) throw new Error(`Line ${lineNo}: expected 'civ <name>'.`);
        return { type: "preamble", preamble: { type: "civ", civName } };
    }

    if (op === "ruleset") {
        const rulesetName = tokens.slice(1).join(" ").trim();
        if (!rulesetName) throw new Error(`Line ${lineNo}: expected 'ruleset <name>'.`);
        return { type: "preamble", preamble: { type: "ruleset", rulesetName } };
    }

    if (op === "setting") {
        const settingName = tokens.slice(1).join(" ").trim();
        if (!settingName) throw new Error(`Line ${lineNo}: expected 'setting <name>'.`);
        return { type: "preamble", preamble: { type: "setting", settingName } };
    }

    if (op === "start-node") {
        const prototypeId = tokens[1];
        const countToken = tokens[2];
        if (!prototypeId || tokens.length > 3) {
            throw new Error(`Line ${lineNo}: expected 'start-node <prototypeId> [count]'.`);
        }
        return {
            type: "preamble",
            preamble: { type: "startNode", prototypeId, ...(countToken !== undefined ? { countToken } : {}) },
        };
    }

    if (op === "starting-resource") {
        const resource = tokens[1];
        const amountToken = tokens[2];
        if (!resource || !amountToken || tokens.length !== 3) {
            throw new Error(`Line ${lineNo}: expected 'starting-resource <resource> <amount>'.`);
        }
        return { type: "preamble", preamble: { type: "startingResource", resource, amountToken } };
    }

    if (op === "start" && tokens[1] === "with") {
        const entries = tokens.slice(2);
        if (entries.length === 0) throw new Error(`Line ${lineNo}: expected 'start with <entityType>[, <entityType>...]'.`);
        return { type: "preamble", preamble: { type: "startWith", entries } };
    }

    if (op === "score") {
        const method = tokens[1];
        if (method !== "time") throw new Error(`Line ${lineNo}: unknown score method '${method}'. Only 'time' is supported.`);
        const condKind = tokens[2];
        const condTarget = tokens[3];
        if (!condKind || !condTarget) {
            throw new Error(
                `Line ${lineNo}: expected 'score time <clicked|completed|depleted|exhausted> <target> [x<count>]'.`,
            );
        }
        if (condKind !== "clicked" && condKind !== "completed" && condKind !== "depleted" && condKind !== "exhausted") {
            throw new Error(
                `Line ${lineNo}: unknown trigger '${condKind}'. Use 'clicked', 'completed', 'depleted', or 'exhausted'.`,
            );
        }
        let countToken: string | undefined;
        const maybeCount = tokens[4];
        if (maybeCount) {
            if (maybeCount === "x" && tokens[5]) {
                countToken = tokens[5];
            } else if (maybeCount.startsWith("x")) {
                countToken = maybeCount.slice(1);
            } else {
                throw new Error(`Line ${lineNo}: unexpected token '${maybeCount}' after score target.`);
            }
        }
        return {
            type: "preamble",
            preamble: {
                type: "scoreTime",
                condKind,
                condTarget,
                ...(countToken !== undefined ? { countToken } : {}),
            },
        };
    }

    if (op === "human-delay") {
        const actionId = tokens[1];
        const chanceToken = tokens[2];
        const minToken = tokens[3];
        const maxToken = tokens[4];
        if (!actionId || !chanceToken || !minToken || !maxToken || tokens.length !== 5) {
            throw new Error(`Line ${lineNo}: expected 'human-delay <actionId> <chance> <minSec> <maxSec>'.`);
        }
        return {
            type: "preamble",
            preamble: { type: "humanDelay", actionId, chanceToken, minToken, maxToken },
        };
    }

    return { type: "command", command: parseDslCommandLine(line, lineNo) };
}
