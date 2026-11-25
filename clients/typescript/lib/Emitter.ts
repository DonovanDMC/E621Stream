export type Listener<Args extends Array<unknown>> = (...args: Args) => void;

export default class Emitter<Events extends { [K in keyof Events]: Array<unknown> }> {
    private listeners = new Map<keyof Events, Array<unknown>>();

    protected emit<K extends keyof Events>(event: K, ...args: Events[K]): void {
        // copied, a once listener removes itself while this runs
        for (const listener of [...this.listeners.get(event) ?? []]) (listener as Listener<Events[K]>)(...args);
    }

    protected emitUnchecked(event: keyof Events, ...args: Array<unknown>): void {
        for (const listener of [...this.listeners.get(event) ?? []]) (listener as Listener<Array<unknown>>)(...args);
    }

    off<K extends keyof Events>(event: K, listener: NoInfer<Listener<Events[K]>>): this {
        const list = this.listeners.get(event);
        const index = list?.indexOf(listener) ?? -1;
        if (index !== -1) list!.splice(index, 1);
        return this;
    }

    on<K extends keyof Events>(event: K, listener: NoInfer<Listener<Events[K]>>): this {
        let list = this.listeners.get(event);
        if (!list) this.listeners.set(event, list = []);
        // added once, like the set this used to be
        if (!list.includes(listener)) list.push(listener);
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
