from __future__ import annotations

import secrets

from .storage import JsonBoardStore


class RoomService:
    """Creates explicit collaborative rooms independently of transport/UI concerns."""

    def __init__(self, store: JsonBoardStore) -> None:
        self.store = store

    def create_room(self) -> str:
        # 12 random bytes -> ~16 URL-safe chars / 96 bits of entropy.
        # A room id is intentionally hard to guess, but it is not authentication.
        for _ in range(32):
            room_id = secrets.token_urlsafe(12)
            if not room_id[0].isalnum():
                continue
            if self.store.create(room_id):
                return room_id
        raise RuntimeError("failed to allocate a unique room id")
