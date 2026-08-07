/**
 * A tiny fixture server for the testenv tests. Reads PORT from the environment
 * (the way the test-environment harness injects it), serves a couple of routes,
 * and — if START_DELAY_MS is set — sleeps before listening, to exercise the
 * readiness-polling path.
 */
const port = Number(process.env.PORT ?? 3000);
const delay = Number(process.env.START_DELAY_MS ?? 0);

if (delay > 0) await new Promise((r) => setTimeout(r, delay));

Bun.serve({
  port,
  fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/health") return new Response("ok");
    if (url.pathname === "/echo") return Response.json({ ok: true, port });
    return new Response("not found", { status: 404 });
  },
});

console.log(`integration-server listening on ${port}`);
