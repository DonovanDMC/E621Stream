export default function Time({ date }: { date: Date | null }): JSX.Element {
    if (date === null) return (<span class="text-body-secondary">never</span>);
    return <>{date.toISOString().slice(0, 16).replace("T", " ")} UTC</>;
}
