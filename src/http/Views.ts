export async function render(html: JSX.Element, status = 200): Promise<Response> {
    return new Response(await html, { status, headers: { "Content-Type": "text/html; charset=utf-8" } });
}
