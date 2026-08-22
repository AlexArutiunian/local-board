from __future__ import annotations

import asyncio
import logging
import time
from collections import deque
from typing import Any

from fastapi import WebSocket

from .models import BoardObject, Stroke
from .protocol import MAX_POINTS_PER_STROKE, ProtocolError, normalize_background
from .storage import JsonBoardStore

logger = logging.getLogger(__name__)
MAX_ACTIVE_STROKE_TIMERS = 2048


class BoardRoom:
    """In-memory authoritative state for one realtime board."""

    def __init__(self, board_id: str, store: JsonBoardStore, document: dict[str, Any]):
        self.board_id = board_id
        self.store = store
        self.revision = int(document.get("revision", 0))
        self.background = normalize_background(document.get("background"))

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
        self.client_profiles: dict[str, dict[str, str]] = {}
        self._stroke_started_ms: dict[str, int] = {}
        self._state_lock = asyncio.Lock()
        self._persist_lock = asyncio.Lock()
        self._recent_op_order: deque[str] = deque(maxlen=10_000)
        self._recent_ops: dict[str, int] = {}

    def snapshot_document(self) -> dict[str, Any]:
        return {
            "version": 1,
            "board_id": self.board_id,
            "revision": self.revision,
            "background": dict(self.background),
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

    def presence_payload(self) -> dict[str, Any]:
        roster = []
        for client_id in self.clients:
            profile = self.client_profiles.get(client_id) or {
                "name": "Участник",
                "role": "student",
                "device": "Устройство",
            }
            roster.append({"client_id": client_id, **profile})
        roster.sort(key=lambda item: (0 if item["role"] == "teacher" else 1, item["name"].lower(), item["device"].lower()))
        return {"type": "presence", "participants": len(roster), "roster": roster}

    async def connect(self, client_id: str, websocket: WebSocket, profile: dict[str, str]) -> None:
        self.clients[client_id] = websocket
        self.client_profiles[client_id] = dict(profile)
        await self._log_activity(
            {
                "v": 1,
                "t": now_ms(),
                "k": "join",
                "actor": self._actor(client_id),
            }
        )
        presence = self.presence_payload()
        await websocket.send_json(
            {
                "type": "snapshot",
                "board": self.snapshot_document(),
                "participants": presence["participants"],
                "roster": presence["roster"],
            }
        )
        await self.broadcast_presence()

    async def disconnect(self, client_id: str, websocket: WebSocket) -> None:
        current = self.clients.get(client_id)
        if current is not websocket:
            return
        actor = self._actor(client_id)
        self.clients.pop(client_id, None)
        self.client_profiles.pop(client_id, None)
        await self._log_activity({"v": 1, "t": now_ms(), "k": "leave", "actor": actor})
        await self.persist()
        await self.broadcast_presence()

    async def broadcast_presence(self) -> None:
        await self._broadcast(self.presence_payload(), exclude=None)

    async def handle_event(self, client_id: str, event: dict[str, Any]) -> None:
        if event["type"] == "ping":
            websocket = self.clients.get(client_id)
            if websocket:
                await websocket.send_json({"type": "pong"})
            return

        activity: dict[str, Any] | None = None
        event_time = now_ms()
        async with self._state_lock:
            op_id = event["op_id"]
            duplicate_revision = self._recent_ops.get(op_id)
            if duplicate_revision is not None:
                await self._ack(client_id, op_id, duplicate_revision)
                return

            before = self._activity_before(event)
            self._apply_mutation(client_id, event)
            self.revision += 1
            revision = self.revision
            self._remember_op(op_id, revision)
            activity = self._activity_for_event(client_id, event, revision, event_time, before)

        if activity is not None:
            await self._log_activity(activity)

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
            "object.reorder",
            "object.delete",
            "board.background",
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
                crop_x=raw.get("crop_x", 0.0),
                crop_y=raw.get("crop_y", 0.0),
                crop_width=raw.get("crop_width", 1.0),
                crop_height=raw.get("crop_height", 1.0),
            )
            self.objects[object_id] = board_object
            self.object_order.append(object_id)
            return

        if event_type == "object.update":
            board_object = self.objects.get(event["object_id"])
            if board_object is None:
                raise ProtocolError("unknown object")
            patch = event["patch"]
            crop_x = patch.get("crop_x", board_object.crop_x)
            crop_y = patch.get("crop_y", board_object.crop_y)
            crop_width = patch.get("crop_width", board_object.crop_width)
            crop_height = patch.get("crop_height", board_object.crop_height)
            if crop_x + crop_width > 1.000001 or crop_y + crop_height > 1.000001:
                raise ProtocolError("invalid object crop")
            for key, value in patch.items():
                setattr(board_object, key, value)
            return

        if event_type == "object.reorder":
            object_id = event["object_id"]
            if object_id not in self.objects:
                raise ProtocolError("unknown object")
            self.object_order = [item for item in self.object_order if item != object_id]
            if event["position"] == "front":
                self.object_order.append(object_id)
            else:
                self.object_order.insert(0, object_id)
            return

        if event_type == "object.delete":
            object_id = event["object_id"]
            self.objects.pop(object_id, None)
            self.object_order = [item for item in self.object_order if item != object_id]
            return

        if event_type == "board.background":
            self.background = dict(event["background"])
            return

        if event_type == "board.clear":
            self.strokes.clear()
            self.order.clear()
            self.objects.clear()
            self.object_order.clear()
            self._stroke_started_ms.clear()
            return

        raise ProtocolError("unsupported mutation")

    def _activity_before(self, event: dict[str, Any]) -> dict[str, Any]:
        event_type = event["type"]
        if event_type in {"stroke.end", "stroke.delete", "stroke.translate"}:
            stroke = self.strokes.get(event.get("stroke_id"))
            return {"stroke": stroke} if stroke is not None else {}
        if event_type == "object.delete":
            board_object = self.objects.get(event.get("object_id"))
            return {"object": board_object} if board_object is not None else {}
        if event_type == "board.clear":
            return {"strokes": len(self.strokes), "objects": len(self.objects)}
        return {}

    def _activity_for_event(
        self,
        client_id: str,
        event: dict[str, Any],
        revision: int,
        timestamp_ms: int,
        before: dict[str, Any],
    ) -> dict[str, Any] | None:
        event_type = event["type"]
        actor = self._actor(client_id)
        base = {"v": 1, "t": timestamp_ms, "k": event_type, "rev": revision, "actor": actor}

        if event_type == "stroke.begin":
            stroke_id = event["stroke"]["id"]
            self._remember_stroke_start(stroke_id, timestamp_ms)
            return None

        if event_type == "stroke.append":
            return None

        if event_type == "stroke.end":
            stroke = before.get("stroke") or self.strokes.get(event["stroke_id"])
            start_ms = self._stroke_started_ms.pop(event["stroke_id"], timestamp_ms)
            if stroke is None:
                return None
            return {
                **base,
                "k": "stroke",
                "sid": stroke.id,
                "t0": start_ms,
                "ms": max(0, timestamp_ms - start_ms),
                **stroke_activity_summary(stroke),
            }

        if event_type == "stroke.delete":
            stroke = before.get("stroke")
            self._stroke_started_ms.pop(event["stroke_id"], None)
            record = {**base, "sid": event["stroke_id"]}
            if stroke is not None:
                record["target_author"] = stroke.author_id
                record["complete"] = bool(stroke.complete)
                record.update(stroke_activity_summary(stroke))
            return record

        if event_type == "stroke.restore":
            stroke = self.strokes.get(event["stroke"]["id"])
            return {**base, "sid": event["stroke"]["id"], **(stroke_activity_summary(stroke) if stroke else {})}

        if event_type == "stroke.translate":
            stroke = before.get("stroke")
            return {
                **base,
                "sid": event["stroke_id"],
                "dx": round(float(event["dx"]), 2),
                "dy": round(float(event["dy"]), 2),
                "target_author": stroke.author_id if stroke else None,
            }

        if event_type == "object.create":
            raw = event["object"]
            return {**base, "oid": raw["id"], "name": raw.get("name", "image")}

        if event_type == "object.update":
            return {**base, "oid": event["object_id"], "patch": compact_numeric_dict(event["patch"])}

        if event_type == "object.reorder":
            return {**base, "oid": event["object_id"], "position": event["position"]}

        if event_type == "object.delete":
            board_object = before.get("object")
            record = {**base, "oid": event["object_id"]}
            if board_object is not None:
                record["name"] = board_object.name
                record["target_author"] = board_object.author_id
            return record

        if event_type == "board.background":
            return {**base, "background": dict(event["background"])}

        if event_type == "board.clear":
            return {**base, "removed": {"strokes": before.get("strokes", 0), "objects": before.get("objects", 0)}}

        return None

    def _remember_stroke_start(self, stroke_id: str, timestamp_ms: int) -> None:
        self._stroke_started_ms[stroke_id] = timestamp_ms
        if len(self._stroke_started_ms) <= MAX_ACTIVE_STROKE_TIMERS:
            return
        oldest_id = min(self._stroke_started_ms, key=self._stroke_started_ms.get)
        self._stroke_started_ms.pop(oldest_id, None)

    def _actor(self, client_id: str) -> dict[str, str]:
        profile = self.client_profiles.get(client_id) or {
            "name": "Участник",
            "role": "student",
            "device": "Устройство",
        }
        return {
            "id": client_id,
            "name": profile["name"],
            "role": profile["role"],
            "device": profile["device"],
        }

    async def _log_activity(self, record: dict[str, Any]) -> None:
        try:
            await asyncio.to_thread(self.store.append_activity, self.board_id, record)
        except Exception:
            logger.exception("failed to append activity for board %s", self.board_id)

    def _remember_op(self, op_id: str, revision: int) -> None:
        if len(self._recent_op_order) == self._recent_op_order.maxlen:
            oldest = self._recent_op_order[0]
            self._recent_ops.pop(oldest, None)
        self._recent_op_order.append(op_id)
        self._recent_ops[op_id] = revision

    async def _ack(self, client_id: str, op_id: str, revision: int) -> None:
        websocket = self.clients.get(client_id)
        if websocket:
            await websocket.send_json({"type": "ack", "op_id": op_id, "revision": revision)

    async def _broadcast(self, message: dict[str, Any], exclude: str | None) -> None:
        stale: list[tuple[str, dict[str, str]]] = []
        for client_id, websocket in list(self.clients.items()):
            if exclude is not None and client_id == exclude:
                continue
            try:
                await websocket.send_json(message)
            except Exception:
                stale.append((client_id, self._actor(client_id)))
        for client_id, actor in stale:
            self.clients.pop(client_id, None)
            self.client_profiles.pop(client_id, None)
            await self._log_activity({"v": 1, "t": now_ms(), "k": "leave", "actor": actor, "reason": "stale"})

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


def now_ms() -> int:
    return time.time_ns() // 1_000_000


def stroke_activity_summary(stroke: Stroke) -> dict[str, Any]:
    points = stroke.points
    summary: dict[str, Any] = {
        "points": len(points),
        "color": stroke.color,
        "width": round(float(stroke.width), 2),
        "pointer": stroke.pointer_type,
    }
    if not points:
        return summary

    min_x = max_x = float(points[0]["x"])
    min_y = max_y = float(points[0]["y"])
    for point in points[1:]:
        x = float(point["x"])
        y = float(point["y"])
        min_x = min(min_x, x)
        min_y = min(min_y, y)
        max_x = max(max_x, x)
        max_y = max(max_y, y)
    summary["bbox"] = [round(min_x, 2), round(min_y, 2), round(max_x, 2), round(max_y, 2)]
    return summary


def compact_numeric_dict(payload: dict[str, Any]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in payload.items():
        if isinstance(value, float):
            result[key] = round(value, 4)
        else:
            result[key] = value
    return result
