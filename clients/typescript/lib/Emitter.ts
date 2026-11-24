export type Listener<Args extends Array<unknown>> = (...args: Args) => void;

export default class Emitter<Events extends { [K in keyof Events]: Array<unknown> }> {
    private listeners = new Map<keyof Events, Set<unknown>>();

    protected emit<K extends keyof Events>(event: K, ...args: Events[K]): void {
        for (const listener of this.listeners.get(event) ?? []) (listener as Listener<Events[K]>)(...args);
    }

    protected emitUnchecked(event: keyof Events, ...args: Array<unknown>): void {
        for (const listener of this.listeners.get(event) ?? []) (listener as Listener<Array<unknown>>)(...args);
    }

    off<K extends keyof Events>(event: K, listener: NoInfer<Listener<Events[K]>>): this {
        this.listeners.get(event)?.delete(listener);
        return this;
    }

    on<K extends keyof Events>(event: K, listener: NoInfer<Listener<Events[K]>>): this {
        let set = this.listeners.get(event);
        if (!set) this.listeners.set(event, set = new Set());
        set.add(listener);
        return this;
    }

    once<K extends keyof Events>(event: K, listener: NoInfer<Listener<Events[K]>>): this {
        const wrapped: Listener<Events[K]> = (...args) => {
            this.off(event, wrapped);
            listener(...args);
        };
        return this.on(event, wrapped);
    }
}
