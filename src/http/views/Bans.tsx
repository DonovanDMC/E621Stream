import { MAX_BAN_REASON_LENGTH } from "../../util/Constants.ts";

import Main from "./layouts/Main.tsx";
import FormButton from "./partials/FormButton.tsx";
import Time from "./partials/Time.tsx";

import type { Ban } from "../../gateway/management.ts";

export default function Bans({ bans }: { bans: Array<Ban> }): JSX.Element {
    return (
        <Main title="Bans">
            <h1 class="h3">Bans ({bans.length})</h1>
            <p class="text-body-secondary">Banned users can't connect to the gateway, and banning someone drops the connections they have.</p>
            <BanForm />
            {bans.length === 0 ? <p>Nobody's banned.</p> : <BanList bans={bans} />}
        </Main>
    );
}

function BanForm(): JSX.Element {
    return (
        <form method="post" action="/admin/ban" class="d-flex flex-wrap gap-2 mb-3">
            <input type="text" class="form-control w-auto" name="user_id" placeholder="e621 user id" inputmode="numeric" pattern="[0-9]+" required />
            <input type="text" class="form-control w-auto" name="reason" placeholder="reason (optional)" maxlength={MAX_BAN_REASON_LENGTH} />
            <button type="submit" class="btn btn-danger">Ban</button>
        </form>
    );
}

function BanList({ bans }: { bans: Array<Ban> }): JSX.Element {
    return (
        <div class="table-responsive">
            <table class="table align-middle">
                <thead>
                    <tr>
                        <th scope="col">User</th>
                        <th scope="col">Reason</th>
                        <th scope="col">By</th>
                        <th scope="col">Banned</th>
                        <th scope="col"></th>
                    </tr>
                </thead>
                <tbody>
                    {bans.map(ban => (
                        <tr>
                            <td><a href={`https://e621.net/users/${ban.user_id}`} safe>{ban.name ?? ban.user_id}</a></td>
                            <td safe>{ban.reason ?? ""}</td>
                            <td safe>{ban.banned_by}</td>
                            <td><Time date={new Date(ban.banned_at)} /></td>
                            <td class="text-end">
                                <FormButton action="/admin/unban" buttonClass="btn-outline-success" fields={{ user_id: ban.user_id }} text="Unban" />
                            </td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
}
