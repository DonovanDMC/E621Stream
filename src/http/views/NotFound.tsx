import GenericError from "./GenericError.tsx";

export default function NotFound(): JSX.Element {
    return (<GenericError title="Not Found" message="That page was not found." />);
}
