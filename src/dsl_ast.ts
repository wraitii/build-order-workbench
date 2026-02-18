export type AstTriggerKind = "clicked" | "completed" | "depleted" | "exhausted";

export interface AstAfterTriggerCondition {
    type: "afterTrigger";
    triggerKind: AstTriggerKind;
    target: string;
    mode: "once" | "every";
}

export interface AstAfterEntityCondition {
    type: "afterEntity";
    entityToken: string;
    countToken?: string;
}

export interface AstOnTriggerCondition {
    type: "onTrigger";
    triggerKind: AstTriggerKind;
    target: string;
}

export type AstCommandCondition = AstAfterTriggerCondition | AstAfterEntityCondition | AstOnTriggerCondition;

export interface AstCommandLine {
    atToken?: string;
    conditions: AstCommandCondition[];
    directiveTokens: string[];
    thenDirectiveTokens?: string[];
}

export type AstPreambleLine =
    | { type: "evaluation"; timeToken: string }
    | { type: "debtFloor"; valueToken: string }
    | { type: "startingResource"; resource: string; amountToken: string }
    | { type: "startWith"; entries: string[] }
    | { type: "scoreTime"; condKind: AstTriggerKind; condTarget: string; countToken?: string }
    | { type: "humanDelay"; actionId: string; chanceToken: string; minToken: string; maxToken: string };

export type AstDslLine =
    | { type: "preamble"; preamble: AstPreambleLine }
    | { type: "command"; command: AstCommandLine };
