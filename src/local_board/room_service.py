from __future__ import annotations

import secrets

from .storage import JsonBoardStore


class RoomService:
    """Creates explicit collaborative rooms independently of transport/UI concerns."""

    def __init__(self, store: JsonBoardStore) -> None:
        self.store = store

    def create_room(self) -> str:
        # Human-friendly room code for lessons: exactly four decimal digits.
        # This is intentionally NOT an authentication secret. Public deployment must
        # add a separate owner/invite credential instead of treating the code as access control.
        for _ in range(128):
            room_id = f"{secrets.randbelow(10_000):04d}"
            if self.store.create(room_id):
                return room_id
        raise RuntimeError("failed to allocate a unique room id")
