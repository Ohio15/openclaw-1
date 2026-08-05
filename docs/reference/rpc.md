---
summary: "RPC adapters for external CLIs (signal-cli, legacy imsg) and gateway patterns"
read_when:
  - Adding or changing external CLI integrations
  - Debugging RPC adapters (signal-cli, imsg)
title: "RPC Adapters"
---

# RPC adapters

OpenClaw integrates external CLIs via JSON-RPC. Two patterns are used today.

## Pattern A: HTTP daemon (signal-cli)

- `signal-cli` runs as a daemon with JSON-RPC over HTTP.
- Event stream is SSE (`/api/v1/events`).
- Health probe: `/api/v1/check`.
- OpenClaw owns lifecycle when `channels.signal.autoStart=true`.

With `channels.signal.transport="rest"` OpenClaw talks to
bbernhard/signal-cli-rest-api instead, which serves none of the paths above:
send is `POST /v2/send`, inbound is `ws://…/v1/receive/{number}`, health is
`GET /v1/health` (204) and the version banner is `GET /v1/about`. There is no
`/api/v1/rpc` on that image, so RPC methods other than send are unavailable.

`GET /v1/health` is container liveness only — it answers 204 whenever the HTTP
server is up, regardless of whether any account is registered, and every account
sharing a container gets the same answer. The health probe therefore also checks
`GET /v1/accounts` (a JSON array of registered E.164 numbers) and reports the
account unhealthy when its number is absent. `channels.signal.account` is
required on this transport for that reason; an unreadable or unexpected
`/v1/accounts` payload is reported unhealthy rather than assumed healthy.

When the backend sits behind a TLS proxy demanding a client certificate, set
`channels.signal.tlsCaFile`/`tlsCertFile`/`tlsKeyFile` (all three or none). HTTP
requests then carry an undici dispatcher holding that CA and keypair, and the
`rest` receive WebSocket is opened with the same material.

See [Signal](/channels/signal) for setup and endpoints.

## Pattern B: stdio child process (legacy: imsg)

> **Note:** For new iMessage setups, use [BlueBubbles](/channels/bluebubbles) instead.

- OpenClaw spawns `imsg rpc` as a child process (legacy iMessage integration).
- JSON-RPC is line-delimited over stdin/stdout (one JSON object per line).
- No TCP port, no daemon required.

Core methods used:

- `watch.subscribe` → notifications (`method: "message"`)
- `watch.unsubscribe`
- `send`
- `chats.list` (probe/diagnostics)

See [iMessage](/channels/imessage) for legacy setup and addressing (`chat_id` preferred).

## Adapter guidelines

- Gateway owns the process (start/stop tied to provider lifecycle).
- Keep RPC clients resilient: timeouts, restart on exit.
- Prefer stable IDs (e.g., `chat_id`) over display strings.
