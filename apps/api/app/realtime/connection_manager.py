"""Single-instance WebSocket rooms for Basecamp's authoritative resync model."""

import asyncio
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any
from uuid import UUID, uuid4

from fastapi import WebSocket


@dataclass(eq=False)
class WebSocketConnection:
    """A socket's authenticated, server-side room membership."""

    websocket: WebSocket
    user_id: UUID
    plan_id: UUID
    connection_id: UUID = field(default_factory=uuid4)
    connected_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))
    last_seen_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))


class ConnectionManager:
    """In-memory, single-process rooms. Socket packets are invalidations only."""

    def __init__(self) -> None:
        self.active_rooms: dict[UUID, set[WebSocketConnection]] = {}
        self._room_lock = asyncio.Lock()
        self._debounced_tasks: dict[tuple[UUID, str], asyncio.Task[None]] = {}
        self._event_sequences: dict[UUID, int] = {}

    async def connect(
        self, websocket: WebSocket, *, user_id: UUID, plan_id: UUID
    ) -> WebSocketConnection:
        await websocket.accept()
        connection = WebSocketConnection(websocket=websocket, user_id=user_id, plan_id=plan_id)
        async with self._room_lock:
            self.active_rooms.setdefault(plan_id, set()).add(connection)
        try:
            await websocket.send_json({"type": "connected"})
        except Exception:
            await self.disconnect(plan_id, connection)
            raise
        return connection

    async def disconnect(self, plan_id: UUID, connection: WebSocketConnection) -> None:
        async with self._room_lock:
            room = self.active_rooms.get(plan_id)
            if room is None:
                return
            room.discard(connection)
            if not room:
                self.active_rooms.pop(plan_id, None)
                self._event_sequences.pop(plan_id, None)
                for task_key, task in list(self._debounced_tasks.items()):
                    if task_key[0] == plan_id:
                        task.cancel()
                        self._debounced_tasks.pop(task_key, None)

    def touch(self, connection: WebSocketConnection) -> None:
        connection.last_seen_at = datetime.now(timezone.utc)

    async def disconnect_user(self, plan_id: UUID, user_id: UUID, *, reason: str) -> None:
        # Snapshot before closing sockets: close callbacks can mutate the room.
        connections = [
            connection
            for connection in list(self.active_rooms.get(plan_id, set()))
            if connection.user_id == user_id
        ]
        for connection in connections:
            await self.disconnect(plan_id, connection)
            try:
                await connection.websocket.close(code=1008, reason=reason)
            except Exception:
                pass

    async def broadcast(self, plan_id: UUID, payload: dict[str, Any]) -> None:
        # G4: never iterate the mutable live room while sockets can join or leave.
        active_sockets = list(self.active_rooms.get(plan_id, set()))
        packet = payload
        if payload.get("type") == "plan_event":
            sequence = self._event_sequences.get(plan_id, 0) + 1
            self._event_sequences[plan_id] = sequence
            packet = {**payload, "event_sequence": sequence}
        for connection in active_sockets:
            try:
                connection.last_seen_at = datetime.now(timezone.utc)
                await connection.websocket.send_json(packet)
            except Exception:
                await self.disconnect(plan_id, connection)

    def debounce_broadcast(
        self, plan_id: UUID, key: str, payload: dict[str, Any], *, delay_seconds: float = 0.2
    ) -> None:
        """Coalesce rapid committed reorder notices; each notice still follows commit."""
        task_key = (plan_id, key)
        previous = self._debounced_tasks.get(task_key)
        if previous is not None and not previous.done():
            previous.cancel()

        async def send_latest() -> None:
            try:
                await asyncio.sleep(delay_seconds)
                await self.broadcast(plan_id, payload)
            except asyncio.CancelledError:
                return
            finally:
                if self._debounced_tasks.get(task_key) is task:
                    self._debounced_tasks.pop(task_key, None)

        task = asyncio.create_task(send_latest())
        self._debounced_tasks[task_key] = task


connection_manager = ConnectionManager()
