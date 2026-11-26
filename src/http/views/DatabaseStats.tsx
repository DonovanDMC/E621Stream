import Main from "./layouts/Main.tsx";
import Time from "./partials/Time.tsx";

import type { DatabaseStats as Stats } from "../DatabaseStats.ts";

const UNITS = ["B", "KB", "MB", "GB", "TB"];
function bytes(n: number): string {
    let value = n, unit = 0;
    while (value >= 1024 && unit < UNITS.length - 1) {
        value /= 1024;
        unit++;
    }
    return `${value.toFixed(unit === 0 ? 0 : 1)} ${UNITS[unit]}`;
}
const num = (n: number): string => n.toLocaleString("en-US");

function Table({ children, head }: { children: JSX.Element | Array<JSX.Element>; head: Array<string> }): JSX.Element {
    return (
        <div class="table-responsive">
            <table class="table table-sm table-bordered data-table">
                <thead>
                    <tr>{head.map(name => <th scope="col" safe>{name}</th>)}</tr>
                </thead>
                <tbody>{children}</tbody>
            </table>
        </div>
    );
}

export default function DatabaseStats({ stats }: { stats: Stats }): JSX.Element {
    const resources = Object.entries(stats.snapshots?.resources ?? {}).toSorted(([, a], [, b]) => b.bytes - a.bytes);
    const totalBytes = resources.reduce((total, [, r]) => total + r.bytes, 0);
    const totalRows = resources.reduce((total, [, r]) => total + r.stored, 0);
    return (
        <Main title="Database">
            <h1 class="h3">Database</h1>
            <p>Postgres is using {bytes(stats.database)}, Redis {bytes(stats.redis.used)} (peak {bytes(stats.redis.peak)}).</p>

            <h2 class="h4 mt-4">Snapshots</h2>
            <p class="text-body-secondary">
                The stored data for each resource, before the row and index overhead in the tables below.
                {stats.snapshots ? <> Counted <Time date={new Date(stats.snapshots.computed_at)} /> by the ingester, it's done every 5 minutes.</> : " The ingester hasn't counted them yet."}
            </p>
            <Table head={["Resource", "Stored", "Data", "Average", "Share", "Highest id"]}>
                <>{resources.map(([resource, r]) => (
                    <tr>
                        <td><code safe>{resource}</code></td>
                        <td>{num(r.stored)}</td>
                        <td>{bytes(r.bytes)}</td>
                        <td>{r.stored === 0 ? "" : bytes(Math.round(r.bytes / r.stored))}</td>
                        <td>{totalBytes === 0 ? "" : `${(r.bytes / totalBytes * 100).toFixed(1)}%`}</td>
                        <td>{num(r.max_id)}</td>
                    </tr>
                ))}
                </>
                <tr class="fw-semibold">
                    <td>total</td>
                    <td>{num(totalRows)}</td>
                    <td>{bytes(totalBytes)}</td>
                    <td>{totalRows === 0 ? "" : bytes(Math.round(totalBytes / totalRows))}</td>
                    <td></td>
                    <td></td>
                </tr>
            </Table>

            <h2 class="h4 mt-4">Tables</h2>
            <p class="text-body-secondary">Row counts are postgres' estimates. Toast is values too big to keep in the row, stored compressed apart from it.</p>
            <Table head={["Table", "Rows", "Total", "Table", "Indexes", "Toast"]}>
                {stats.tables.map(table => (
                    <tr>
                        <td><code safe>{table.name}</code></td>
                        <td>{num(table.rows)}</td>
                        <td>{bytes(table.total)}</td>
                        <td>{bytes(table.table)}</td>
                        <td>{bytes(table.indexes)}</td>
                        <td>{bytes(table.toast)}</td>
                    </tr>
                ))}
            </Table>

            <h2 class="h4 mt-4">Indexes</h2>
            <p class="text-body-secondary">Scans are how many times each one has been used since postgres last reset its statistics. One that's never used is only costing space and writes.</p>
            <Table head={["Index", "Table", "Size", "Scans"]}>
                {stats.indexes.map(index => (
                    <tr>
                        <td><code safe>{index.name}</code></td>
                        <td><code safe>{index.table}</code></td>
                        <td>{bytes(index.size)}</td>
                        <td>{num(index.scans)}</td>
                    </tr>
                ))}
            </Table>

            <h2 class="h4 mt-4">Redis</h2>
            <Table head={["", ""]}>
                <tr><td>Memory</td><td>{bytes(stats.redis.used)}</td></tr>
                <tr><td>Peak memory</td><td>{bytes(stats.redis.peak)}</td></tr>
                <tr><td>Keys</td><td>{num(stats.redis.keys)}</td></tr>
                <tr><td>Events in the live stream</td><td>{num(stats.redis.stream)}</td></tr>
            </Table>
        </Main>
    );
}
