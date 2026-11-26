import HTTPConfig from "../../config/HTTPConfig.ts";
import { MAX_TOKEN_NAME_LENGTH } from "../../util/Constants.ts";

import Main from "./layouts/Main.tsx";
import FormButton from "./partials/FormButton.tsx";
import Time from "./partials/Time.tsx";

import type GatewayToken from "../../db/models/GatewayToken.ts";
import type OAuthLink from "../../db/models/OAuthLink.ts";

export default function UserHome({ link, tokens }: { link: OAuthLink | null; tokens: Array<GatewayToken> }): JSX.Element {
    return (
        <Main title="User Home">
            <h2 class="h4 mt-4">Tokens ({tokens.length}/{HTTPConfig.maxTokensPerUser})</h2>
            <p class="text-body-secondary">
                Send in <code>identify</code> as <code>{"auth: { token }"}</code>, or as an <code>Authorization: Bearer</code> header when connecting.<br />
                Deleting a token will disconnect any sessions using it within 1 minute.
            </p>
            {!link?.full ? <MissingFullAccess /> : <RemoveFullAccess />}
            <hr />
            {tokens.length === 0 ? <p>No Tokens Yet</p> : <TokenList tokens={tokens} link={link} />}
            {tokens.length < HTTPConfig.maxTokensPerUser && <CreateTokenForm />}
        </Main>
    );
}

function TokenList({ link, tokens }: { link: OAuthLink | null; tokens: Array<GatewayToken> }): JSX.Element {
    return (
        <div class="table-responsive">
            <table class="table align-middle">
                <thead>
                    <tr>
                        <th scope="col">Name</th>
                        <th scope="col">Creation Date</th>
                        <th scope="col">Last Used</th>
                        <th scope="col"></th>
                    </tr>
                </thead>
                <tbody>
                    {tokens.map(token => (
                        <tr>
                            <td safe>{token.name}</td>
                            <td><Time date={token.created_at} /></td>
                            <td><Time date={token.last_used_at} /></td>
                            <td class="text-end">
                                <div class="d-inline-flex gap-2">
                                    <FormButton action="/user/tokens/delete" buttonClass="btn-outline-danger" confirmText={`Delete ${token.name}? Any gateway sessions will be disconnected. This cannot be undone.`} fields={{ id: token.id }} text="Delete" />
                                    <FormButton action="/user/tokens/toggle-private-events" buttonClass={link?.full === false ? "btn-outline-secondary" : token.private_events ? "btn-outline-warning" : "btn-outline-success"} fields={{ id: token.id }} text={token.private_events ? "Disable Private Events" : "Enable Private Events"} disabled={!link?.full} />
                                </div>
                            </td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
}

function CreateTokenForm(): JSX.Element {
    return (
        <form method="post" action="/user/tokens" class="d-flex flex-wrap gap-2 mt-3">
            <input type="text" class="form-control w-auto" id="tokenName" name="name" placeholder="name" maxlength={MAX_TOKEN_NAME_LENGTH} required />
            <button type="submit" class="btn btn-primary">Create</button>
        </form>
    );
}

function MissingFullAccess(): JSX.Element {
    return (
        <p class="text-warning">
            Your oauth login did not include the full scope, so you cannot enable private events. Click <a href="/user/login/oauth?purpose=upgrade&return=%2Fuser">here</a> to authorize the full scope.
        </p>
    );
}

function RemoveFullAccess(): JSX.Element {
    return (
        <p class="">
            Your oauth login included the full scope. Click <a href="/user/login/oauth?purpose=downgrade&return=%2Fuser">here</a> to downgrade to normal authorization (disables private events).
        </p>
    );
}
