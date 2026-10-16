// Claude Code hook entry point: forwards the hook payload to HQ and relays its decision.
const SOCKET = process.env.ORQ_SOCKET;
const AGENT = process.env.ORQ_AGENT_ID;

if (SOCKET && AGENT) {
  try {
    const payload = JSON.parse(await Bun.stdin.text());
    const res = await fetch('http://hq/hook', {
      unix: SOCKET,
      method: 'POST',
      body: JSON.stringify({ agent: AGENT, payload }),
      signal: AbortSignal.timeout(5000),
    } as RequestInit);
    const out = (await res.json()) as Record<string, unknown>;
    if (out && Object.keys(out).length) process.stdout.write(JSON.stringify(out));
  } catch {
    // HQ down: never block the agent.
  }
}
process.exit(0);

export {};
