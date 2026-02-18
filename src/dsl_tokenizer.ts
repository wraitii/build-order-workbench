import { createToken, Lexer } from "chevrotain";

const WhiteSpace = createToken({
    name: "WhiteSpace",
    pattern: /[ \t\r\n]+/,
    group: Lexer.SKIPPED,
});

const Comma = createToken({
    name: "Comma",
    pattern: /,/,
});

const Word = createToken({
    name: "Word",
    pattern: /[^,\s]+/,
});

const dslLexer = new Lexer([WhiteSpace, Comma, Word]);

export function tokenizeDslLine(line: string, lineNo: number): string[] {
    const result = dslLexer.tokenize(line);
    if (result.errors.length > 0) {
        const first = result.errors[0];
        const details = first?.message ?? "unknown lexer error";
        throw new Error(`Line ${lineNo}: ${details}`);
    }

    const out: string[] = [];
    for (const token of result.tokens) {
        if (token.tokenType === Comma) {
            const last = out[out.length - 1];
            if (!last) {
                out.push(",");
                continue;
            }
            out[out.length - 1] = `${last},`;
            continue;
        }
        out.push(token.image);
    }
    return out;
}
