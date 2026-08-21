from local_board.storage import JsonBoardStore, validate_board_id


def test_board_store_roundtrip(tmp_path):
    store = JsonBoardStore(tmp_path)
    document = {
        "version": 1,
        "board_id": "study",
        "revision": 3,
        "strokes": [{"id": "s1", "points": []}],
    }
    store.save("study", document)
    assert store.load("study") == document


def test_new_board_is_empty(tmp_path):
    store = JsonBoardStore(tmp_path)
    board = store.load("new-board")
    assert board["board_id"] == "new-board"
    assert board["strokes"] == []


def test_create_board_is_exclusive(tmp_path):
    store = JsonBoardStore(tmp_path)
    assert store.create("lesson-room") is True
    assert store.exists("lesson-room") is True
    assert store.create("lesson-room") is False


def test_board_id_validation():
    assert validate_board_id("math_2026") == "math_2026"
