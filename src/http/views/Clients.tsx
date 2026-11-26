import Main from "./layouts/Main.tsx";
import FormButton from "./partials/FormButton.tsx";
import Time from "./partials/Time.tsx";

import type { ListedClient } from "../../gateway/presence.ts";

const STATES = {
    pending: ["identifying", "text-body-secondary"],
    replaying: ["replaying", "text-info"],
    live: ["live", "text-success"],
} satisfies Record<ListedClient["state"], [label: string, className: string]>;

// only the first few are shown, the rest are behind a toggle
const SHOWN_SUBSCRIPTIONS = 3;

export interface ClientsProps {
    /** Admins & owners, they can't be banned */
    admins: Array<number>;
    clients: Array<ListedClient>;
}

export default function Clients({ admins, clients }: ClientsProps): JSX.Element {
    return (
        <Main title="Clients" styles={["pages/clients"]}>
            <h1 class="h3">Clients ({clients.length})</h1>
            <p class="text-body-secondary">Everyone connected to every gateway. Dropped clients can still reconnect, ban them to stop that.</p>
            {clients.length === 0 ? <p>Nobody's connected.</p> : <ClientList admins={admins} clients={clients} />}
        </Main>
    );
}

function ClientList({ admins, clients }: { admins: Array<number>; clients: Array<ListedClient> }): JSX.Element {
    return (
        <div class="table-responsive">
            <table class="table align-middle">
                <thead>
                    <tr>
                        <th scope="col">Client</th>
                        <th scope="col">User</th>
                        <th scope="col">State</th>
                        <th scope="col">Subscriptions</th>
                        <th scope="col">IP</th>
                        <th scope="col">Connected</th>
                        <th scope="col"></th>
                    </tr>
                </thead>
                <tbody>
                    {clients.map(client => (
                        <tr>
                            <td>{client.client === null ? <span class="text-body-secondary">unnamed</span> : <span safe>{client.client}</span>}</td>
                            <td>{client.user_id === null ? <span class="text-body-secondary">anonymous</span> : <a href={`https://e621.net/users/${client.user_id}`} safe>{client.user ?? client.user_id}</a>}</td>
                            <td class={STATES[client.state][1]}>{STATES[client.state][0]}</td>
                            <td><Subscriptions id={client.session_id} subscriptions={client.subscriptions} /></td>
                            <td safe>{client.ip}</td>
                            <td><Time date={new Date(client.connected_at)} /></td>
                            <td class="text-end">
                                <div class="d-inline-flex gap-2">
                                    <FormButton action="/admin/drop" buttonClass="btn-outline-warning" fields={{ session_id: client.session_id }} text="Drop" />
                                    {client.user_id !== null && !admins.includes(client.user_id) && (
                                        <FormButton action="/admin/ban" buttonClass="btn-outline-danger" confirmText={`Ban ${client.user ?? client.user_id}? This drops all of their connections.`} fields={{ user_id: client.user_id, name: client.user ?? "", return_to: "/admin/clients" }} text="Ban" />
                                    )}
                                </div>
                            </td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
}

function Subscriptions({ id, subscriptions }: { id: string; subscriptions: ListedClient["subscriptions"] }): JSX.Element {
    if (subscriptions.length === 0) return <span class="text-body-secondary">none</span>;
    const items = subscriptions.map((sub) => {
        const types = [...sub.types, ...sub.privateTypes].join(", ");
        // unfiltered ones still have an empty filter
        if (!sub.filter || Object.values(sub.filter).every(value => value === undefined)) return <div><code safe>{types}</code></div>;
        return (
            <details>
                <summary><code safe>{types}</code></summary>
                <code class="d-block ps-3 text-break" safe>{JSON.stringify(sub.filter)}</code>
            </details>
        );
    });
    if (items.length <= SHOWN_SUBSCRIPTIONS) return <>{items}</>;
    return (
        <>
            {items.slice(0, SHOWN_SUBSCRIPTIONS)}
            <div class="collapse" id={`subs-${id}`}>{items.slice(SHOWN_SUBSCRIPTIONS)}</div>
            {/* bootstrap toggles collapsed on the link, which picks the label */}
            <a class="collapsed subs-toggle" href={`#subs-${id}`} data-bs-toggle="collapse" role="button" aria-expanded="false">
                <span class="when-collapsed">{items.length - SHOWN_SUBSCRIPTIONS} more</span>
                <span class="when-expanded">show less</span>
            </a>
        </>
    );
}
