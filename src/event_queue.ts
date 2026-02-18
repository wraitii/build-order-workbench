import { EPS } from "./sim_shared";

export interface QueuedEvent<TPhase extends string, TPayload> {
    time: number;
    phase: TPhase;
    order: number;
    payload: TPayload;
}

export class EventQueue<TPhase extends string, TPayload> {
    private nextOrder = 0;
    private events: QueuedEvent<TPhase, TPayload>[] = [];

    constructor(private readonly phasePriority: Record<TPhase, number>) {}

    push(time: number, phase: TPhase, payload: TPayload): void {
        this.events.push({
            time,
            phase,
            order: this.nextOrder,
            payload,
        });
        this.nextOrder += 1;
    }

    pop(): QueuedEvent<TPhase, TPayload> | undefined {
        if (this.events.length === 0) return undefined;
        this.events.sort((a, b) => {
            const dt = a.time - b.time;
            if (Math.abs(dt) > EPS) return dt;
            const dp = this.phasePriority[a.phase] - this.phasePriority[b.phase];
            if (dp !== 0) return dp;
            return a.order - b.order;
        });
        return this.events.shift();
    }

    isEmpty(): boolean {
        return this.events.length === 0;
    }
}
