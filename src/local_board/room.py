from __future__ import annotations

import asyncio
from collections import deque
from typing import Any

from fastapi import WebSocket

from .models import BoardObject, Stroke
from .protocol import MAX_POINTS_PER_STROKE, ProtocolError
from .storage import JsonBoardStore


class BoardRoom:
    """In-memory authoritative state for one realtime board."""

    def __init__(self, board_id: str, store: JsonBoardStore, document: dict[str, Any]):
        self.board_id = board_id
        self.store = store
        self.revision = int(document.get("revision", 0))

        self.strokes: dict[str, Stroke] = {}
        self.order: list[str] = []
        for raw in document.get("strokes", []):
            stroke = Stroke.from_dict(raw)
            self.strokes[stroke.id] = stroke
            self.order.append(stroke.id)

        self.objects: dict[str, BoardObject] = {}
        self.object_order: list[str] = []
        for raw in document.get("objects", []):
            board_object = BoardObject.from_dict(raw)
            self.objects[board_object.id] = board_object
            self.object_order.append(board_object.id)

        self.clients: dict[str, WebSocket] = {}
        self._state_lock = asyncio.Lock()
        self._persist_lock = asyncio.Lock()
        self._recent_op_order: deque[str] = deque(maxlen=10_000)
        self._recent_ops: dict[str, int] = {}

    def snapshot_document(self) -> dict[str, Any]:
        return {
            "version": 1,
            "board_id": self.board_id,
            "revision": self.revision,
            "strokes": [
                self.strokes[stroke_id].to_dict()
                for stroke_id in self.order
                if stroke_id in self.strokes
            ],
            "objects": [
                self.objects[object_id].to_dict()
                for object_id in self.object_order
                if object_id in self.objects
            ],
        }

    async def connect(self, client_id: str, websocket: WebSocket) -> None:
        self.clients[client_id] = websocket
        await websocket.send_json(
            {
                "type": "snapshot",
                "board": self.snapshot_document(),
                "participants": len(self.clients),
            }
        )
        await self.broadcast_presence()

    async def disconnect(self, client_id: str, websocket: WebSocket) -> None:
        current = self.clients.get(client_id)
        if current is not websocket:
            return
        self.clients.pop(client_id, None)
        await self.persist()
        await self.broadcast_presence()

    async def broadcast_presence(self) -> None:
        await self._broadcast({"type": "presence", "participants": len(self.clients)}, exclude=None)

    async def handle_event(self, client_id: str, event: dict[str, Any]) -> None:
        if event["type"] == "ping":
            websocket = self.clients.get(client_id)
            if websocket:
                await websocket.send_json({"type": "pong"})
            return

        async with self._state_lock:
            op_id = event["op_id"]
            duplicate_revision = self._recent_ops.get(op_id)
            if duplicate_revision is not None:
                await self._ack(client_id, op_id, duplicate_revision)
                return

            self._apply_mutation(client_id, event)
            self.revision += 1
            revision = self.revision
            self._remember_op(op_id, revision)

        await self._ack(client_id, op_id, revision)
        await self._broadcast(
            {"type": "event", "revision": revision, "actor_id": client_id, "event": event},
            exclude=client_id,
        )

        if event["type"] in {
            "stroke.end",
            "stroke.delete",
            "stroke.restore",
            "stroke.translate",
            "object.create",
            "object.update",
            "object.delete",
            "board.clear",
        }:
            await self.persist()

    def _apply_mutation(self, client_id: str, event: dict[str, Any]) -> None:
        event_type = event["type"]

        if event_type in {"stroke.begin", "stroke.restore"}:
            raw = event["stroke"]
            stroke_id = raw["id"]
            if event_type == "stroke.begin" and stroke_id in self.strokes:
                raise ProtocolError("stroke id already exists")
            stroke = Stroke(
                id=stroke_id,
                author_id=client_id,
                color=raw["color"],
                width=raw["width"],
                pointer_type=raw["pointer_type"],
                source_zoom=raw.get("source_zoom"),
                points=list(raw["points"]),
                complete=event_type == "stroke.restore",
            )
            self.strokes[stroke_id] = stroke
            if stroke_id not in self.order:
                self.order.append(stroke_id)
            return

        if event_type == "stroke.append":
            stroke = self.strokes.get(event["stroke_id"])
            if stroke is None:
                raise ProtocolError("unknown stroke")
            if len(stroke.points) + len(event["points"]) > MAX_POINTS_PER_STROKE:
                raise ProtocolError("stroke is too large")
            stroke.points.extend(event["points"])
            return

        if event_type == "stroke.end":
            stroke = self.strokes.get(event["stroke_id"])
            if stroke is None:
                raise ProtocolError("unknown stroke")
            stroke.complete = True
            return

        if event_type == "stroke.translate":
            stroke = self.strokes.get(event["stroke_id"])
            if stroke is None:
                raise ProtocolError("unknown stroke")
            dx = event["dx"]
            dy = event["dy"]
            for point in stroke.points:
                point["x"] += dx
                point["y"] += dy
            return

        if event_type == "stroke.delete":
            stroke_id = event["stroke_id"]
            self.strokes.pop(stroke_id, None)
            self.order = [item for item in self.order if item != stroke_id]
            return

        if event_type == "object.create":
            raw = event["object"]
            object_id = raw["id"]
            if object_id in self.objects:
                raise ProtocolError("object id already exists")
            expected_prefix = f"/api/boards/{self.board_id}/assets/"
            if not raw["src"].startswith(expected_prefix):
                raise ProtocolError("image asset belongs to another room")
            board_object = BoardObject(
                id=object_id,
                author_id=client_id,
                kind=raw["kind"],
                x=raw["x"],
                y=raw["y"],
                width=raw["width"],
                height=raw["height"],
                src=raw["src"],
                name=raw.get("name", "image"),
            )
            self.objects[object_id] = board_object
            self.object_order.append(object_id)
            return

        if event_type == "object.update":
            board_object = self.objects.get(event["object_id"])
            if board_object is None:
                raise ProtocolError("unknown object")
            for key, value in event["patch"].items():
                setattr(board_object, key, value)
            return

        if event_type == "object.delete":
            object_id = event["object_id"]
            self.objects.pop(object_id, None)
            self.object_order = [item for item in self.object_order if item != object_id]
            return

        if event_type == "board.clear":
            self.strokes.clear()
            self.order.clear()
            self.objects.clear()
            self.object_order.clear()
            return

        raise ProtocolError("unsupported mutation")

    def _remember_op(self, op_id: str, revision: int) -> None:
        if len(self._recent_op_order) == self._recent_op_order.maxlen:
            oldest = self._recent_op_order[0]
            self._recent_ops.pop(oldest, None)
        self._recent_op_order.append(op_id)
        self._recent_ops[op_id] = revision

    async def _ack(self, client_id: str, op_id: str, revision: int) -> None:
        websocket = self.clients.get(client_id)
        if websocket:
            await websocket.send_json({"type": "ack", "op_id": op_id, "revision": revision})

    async def _broadcast(self, message: dict[str, Any], exclude: str | None) -> None:
        stale: list[str] = []
        for client_id, websocket in list(self.clients.items()):
            if exclude is not None and client_id == exclude:
                continue
            try:
                await websocket.send_json(message)
            except Exception:
                stale.append(client_id)
        for client_id in stale:
            self.clients.pop(client_id, None)

    async def persist(self) -> None:
        async with self._persist_lock:
            document = self.snapshot_document()
            await asyncio.to_thread(self.store.save, self.board_id, document)


class RoomManager:
    def __init__(self, store: JsonBoardStore):
        self.store = store
        self.rooms: dict[str, BoardRoom] = {}
        self._lock = asyncio.Lock()

    async def get(self, board_id: str) -> BoardRoom:
        room = self.rooms.get(board_id)
        if room is not None:
            return room
        async with self._lock:
            room = self.rooms.get(board_id)
            if room is None:
                document = await asyncio.to_thread(self.store.load, board_id)
                room = BoardRoom(board_id, self.store, document)
                self.rooms[board_id] = room
            return room
