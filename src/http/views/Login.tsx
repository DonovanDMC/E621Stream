import Main from "./layouts/Main.tsx";

export default function Login(options: { return: string }): JSX.Element {
    return (
        <Main title="Login">
            <div class="container">
                <div class="row justify-content-center pt-5">
                    <div class="col-12 col-sm-8 col-md-6 col-lg-4">
                        <form action="/user/login" class="card card-body">
                            <input type="hidden" name="redirect" value={options.return} />
                            <h1 class="h4 mb-3 text-center">Login</h1>
                            <div class="mb-3">
                                <label for="username" class="form-label">Username</label>
                                <input type="text" class="form-control" id="username" name="username" autocomplete="username" required />
                            </div>
                            <div class="mb-3">
                                <label for="api_key" class="form-label">API Key</label>
                                <input type="password" class="form-control" id="api_key" name="api_key" autocomplete="current-password" required />
                            </div>
                            <button type="submit" class="btn btn-secondary w-100">Login</button>
                            <div class="d-flex align-items-center my-3">
                                <hr class="flex-grow-1" />
                                <span class="px-2 text-body-secondary">or</span>
                                <hr class="flex-grow-1" />
                            </div>
                            <a class="btn btn-primary w-100" href={`/user/login/oauth?return=${encodeURIComponent(options.return)}`}>Login With E621</a>
                        </form>
                    </div>
                </div>
            </div>
        </Main>
    );
}
