# Realtime And Resync

Basecamp uses in-memory FastAPI WebSocket rooms for the MVP.

WebSocket messages are notifications, not authority. The source of truth is Postgres, and clients recover by calling REST resync after reconnect.
