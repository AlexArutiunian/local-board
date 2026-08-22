from local_board.storage import JsonBoardStore, validate_board_id


def test_board_store_roundtrip(tmp_path):
    store = JsonBoardStore(tmp_path)
    document = {
        "version": 1,
        "board_id": "study",
        "revision": 3,
        "strokes": [{"id": "s1", "points": []}],
        "objects": [],
    }
    store.save("study", document)
    assert store.load("study") == document


def test_new_board_is_empty(tmp_path):
    store = JsonBoardStore(tmp_path)
    board = store.load("new-board")
    assert board["board_id"] == "new-board"
    assert board["strokes"] == []
    assert board["objects"] == []


def test_create_board_is_exclusive_and_listed(tmp_path):
    store = JsonBoardStore(tmp_path)
    assert store.create("lesson-room") is True
    assert store.exists("lesson-room") is True
    assert store.create("lesson-room") is False
    listed = store.list_boards()
    assert listed[0]["room_id"] == "lesson-room"
    assert listed[0]["stroke_count"] == 0
    assert listed[0]["object_count"] == 0


def test_asset_storage_is_scoped_to_board(tmp_path):
    store = JsonBoardStore(tmp_path)
    store.create("1234")
    name = store.save_asset("1234", "image/png", b"not-a-real-png-but-storage-is-byte-opaque")
    path = store.asset_path("1234", name)
    assert path.read_bytes().startswith(b"not-a-real")
    assert path.parent.name == "1234"


def test_board_id_validation():
    assert validate_board_id("math_2026") == "math_2026"
