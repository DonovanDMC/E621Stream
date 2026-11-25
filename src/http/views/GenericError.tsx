import Main from "./layouts/Main.tsx";

export default function GenericError({ message, title }: { message: string; title: string }): JSX.Element {
    return (
        <Main title={title}>
            <div class="d-flex flex-column justify-content-center align-items-center text-center vh-100">
                <h1>{message}</h1>
                <h2 class="mb-0"><a href="javascript:history.back()">Return To Previous Page</a></h2>
            </div>
        </Main>
    );
}
