// Minimal Jev-protocol mock for tests: bun scripts/mock-jev.ts  (port 8765)
// choice -> keyword-scored probabilities; noul -> 0.9 if the state looks like a preference.
Bun.serve({
  port: Number(process.env.PORT ?? 8765),
  async fetch(req) {
    const url = new URL(req.url)
    if (url.pathname === '/v1/models') return Response.json({ data: [{ id: 'mock-jev' }] })
    if (url.pathname !== '/v1/systemone') return new Response('not found', { status: 404 })
    const body = (await req.json()) as { state: string; questions: Record<string, any> }
    const state = String(typeof body.state === 'string' ? body.state : JSON.stringify(body.state)).toLowerCase()
    const answers: Record<string, unknown> = {}
    for (const [id, q] of Object.entries(body.questions)) {
      if (q.type === 'noul') {
        answers[id] = { type: 'noul', noul: /always|never|prefer|my project|from now on/.test(state) ? 0.9 : 0.1 }
      } else if (q.type === 'choice') {
        const keys = Object.keys(q.criteria)
        const raw = keys.map((k) => (k === 'code' && /git|commit|branch|linear|bug/.test(state) ? 5 : 1))
        const sum = raw.reduce((a, b) => a + b, 0)
        const probabilities = Object.fromEntries(keys.map((k, i) => [k, raw[i] / sum]))
        const choice = keys[raw.indexOf(Math.max(...raw))]
        answers[id] = { type: 'choice', choice, confidence: probabilities[choice], probabilities }
      }
    }
    return Response.json({ model: 'mock-jev', answers })
  }
})
console.log('mock jev on', process.env.PORT ?? 8765)
