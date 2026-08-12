# Upgrade Triggers

Basecamp begins with simple MVP infrastructure and upgrades only when observed
needs justify it.

- Add Redis/PubSub only when multiple API instances require cross-instance
  WebSocket invalidation fanout.
- Add durable distributed metrics only when process-local, restart-resetting
  counters are insufficient for operations.
- Add a background queue only when planning or cleanup can no longer safely
  run through the current bounded scheduler/request-safe paths.
- Move to paid/always-on API hosting when cold starts or free-tier sleep
  materially harms collaboration.
- Scale the database only when measured connection or query load warrants it.
- Add object storage/CDN only for a future product requirement that needs it.

Do not introduce these systems merely to anticipate scale. Basecamp has no
place-discovery, route, weather, or provider-cache architecture to operate.
