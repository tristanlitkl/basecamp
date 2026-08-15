"""Single-instance WebSocket rooms for Basecamp's authoritative resync model."""

import asyncio
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any
from uuid import UUID, uuid4

from fastapi import WebSocket


@dataclass(eq=False)
class WebSocketConnection:
    """A socket's authenticated, server-side room membership."""

    websocket: WebSocket
    user_id: UUID
    plan_id: UUID
    display_name: str = "Plan member"
    avatar_emoji: str = "🧭"
    connection_id: UUID = field(default_factory=uuid4)
    connected_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))
    last_seen_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))
    active_context: str | None = None
    editing_entity_type: str | None = None
    editing_entity_id: UUID | None = None


class ConnectionManager:
    """In-memory, single-process rooms. Socket packets are invalidations only."""

    def __init__(self, *, presence_ttl_seconds: float = 70) -> None:
        self.active_rooms: dict[UUID, set[WebSocketConnection]] = {}
        self._room_lock = asyncio.Lock()
        self._debounced_tasks: dict[tuple[UUID, str], asyncio.Task[None]] = {}
        self._event_sequences: dict[UUID, int] = {}
        # Presence is deliberately process-local: Basecamp currently has one API instance.
        self.presence_ttl_seconds = presence_ttl_seconds
        self._presence_expiry_tasks: dict[WebSocketConnection, asyncio.Task[None]] = {}

    async def connect(
        self,
        websocket: WebSocket,
        *,
        user_id: UUID,
        plan_id: UUID,
        display_name: str = "Plan member",
        avatar_emoji: str = "🧭",
    ) -> WebSocketConnection:
        await websocket.accept()
        connection = WebSocketConnection(
            websocket=websocket,
            user_id=user_id,
            plan_id=plan_id,
            display_name=display_name,
            avatar_emoji=avatar_emoji,
        )
        async with self._room_lock:
            self.active_rooms.setdefault(plan_id, set()).add(connection)
            self._schedule_presence_expiry(connection)
        try:
            await websocket.send_json({"type": "connected"})
        except Exception:
            await self.disconnect(plan_id, connection)
            raise
        await self.broadcast_presence(plan_id, event_type="presence.snapshot")
        return connection

    async def disconnect(self, plan_id: UUID, connection: WebSocketConnection) -> None:
        removed = False
        async with self._room_lock:
            room = self.active_rooms.get(plan_id)
            if room is None:
                return
            if connection in room:
                room.remove(connection)
                removed = True
            self._cancel_presence_expiry(connection)
            if not room:
                self.active_rooms.pop(plan_id, None)
                self._event_sequences.pop(plan_id, None)
                for task_key, task in list(self._debounced_tasks.items()):
                    if task_key[0] == plan_id:
                        task.cancel()
                        self._debounced_tasks.pop(task_key, None)
        if removed:
            await self.broadcast_presence(plan_id, event_type="presence.updated")

    async def touch(self, connection: WebSocketConnection) -> None:
        connection.last_seen_at = datetime.now(timezone.utc)
        async with self._room_lock:
            if connection in self.active_rooms.get(connection.plan_id, set()):
                self._schedule_presence_expiry(connection)

    async def update_presence_context(
        self,
        connection: WebSocketConnection,
        *,
        active_context: str | None,
        editing_entity_type: str | None,
        editing_entity_id: UUID | None,
    ) -> None:
        await self.touch(connection)
        connection.active_context = active_context
        connection.editing_entity_type = editing_entity_type
        connection.editing_entity_id = editing_entity_id
        await self.broadcast_presence(connection.plan_id, event_type="presence.updated")

    def _cancel_presence_expiry(self, connection: WebSocketConnection) -> None:
        task = self._presence_expiry_tasks.pop(connection, None)
        if task is not None and task is not asyncio.current_task():
            task.cancel()

    def _schedule_presence_expiry(self, connection: WebSocketConnection) -> None:
        self._cancel_presence_expiry(connection)

        async def expire() -> None:
            try:
                await asyncio.sleep(self.presence_ttl_seconds)
                if datetime.now(timezone.utc) - connection.last_seen_at < timedelta(
                    seconds=self.presence_ttl_seconds
                ):
                    return
                await self.disconnect(connection.plan_id, connection)
                try:
                    await connection.websocket.close(code=1001, reason="presence_heartbeat_expired")
                except Exception:
                    pass
            except asyncio.CancelledError:
                return
            finally:
                if self._presence_expiry_tasks.get(connection) is task:
                    self._presence_expiry_tasks.pop(connection, None)

        task = asyncio.create_task(expire())
        self._presence_expiry_tasks[connection] = task

    def _presence_snapshot(self, plan_id: UUID) -> list[dict[str, Any]]:
        """Return one safe, latest-context record per visible member."""
        newest_by_user: dict[UUID, WebSocketConnection] = {}
        for connection in self.active_rooms.get(plan_id, set()):
            existing = newest_by_user.get(connection.user_id)
            # A user is shown once across tabs, but an active editing context wins
            # over an idle newer tab so collaborators do not lose the indicator.
            if (
                existing is None
                or (connection.active_context is not None and existing.active_context is None)
                or (
                    (connection.active_context is not None) == (existing.active_context is not None)
                    and connection.last_seen_at > existing.last_seen_at
                )
            ):
                newest_by_user[connection.user_id] = connection
        return [
            {
                "user_id": str(connection.user_id),
                "display_name": connection.display_name,
                "avatar_emoji": connection.avatar_emoji,
                "active_context": connection.active_context,
                "editing_entity_type": connection.editing_entity_type,
                "editing_entity_id": str(connection.editing_entity_id)
                if connection.editing_entity_id
                else None,
            }
            for connection in sorted(
                newest_by_user.values(), key=lambda value: (value.connected_at, str(value.user_id))
            )
        ]

    async def broadcast_presence(self, plan_id: UUID, *, event_type: str) -> None:
        # These packets are ephemeral UI state, never plan invalidations.
        await self.broadcast(
            plan_id,
            {
                "type": event_type,
                "plan_id": str(plan_id),
                "users": self._presence_snapshot(plan_id),
            },
        )

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
