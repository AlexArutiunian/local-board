# Architecture

## Goal

`local-board` — room-based realtime-доска для совместных занятий и работы. Один участник создаёт доску, делится ссылкой или 4-значным кодом, и все участники видят общий canvas в realtime.

Текущий deployment — один Linux-хост в LAN. Frontend остаётся **host-agnostic**: same-origin HTTP/WebSocket работает одинаково на `localhost`, LAN-IP и будущем HTTPS-домене.

Главный flow:

```text
Dashboard / → explicit room
→ participants join /b/<code>
→ local optimistic Pencil/object interaction
→ validated realtime mutation
→ authoritative BoardRoom
→ event to peers
→ durable JSON snapshot + separate image assets
```

## Components

```mermaid
flowchart LR
    D[Board dashboard] -->|GET/POST /api/rooms| A[FastAPI]
    A --> RS[RoomService]
    A --> AS[Asset endpoints]
    RS --> J[(Board JSON)]
    AS --> F[(Image assets)]

    I[iPad / Pencil] <-->|WebSocket| R[BoardRoom]
    L[Laptop browser] <-->|WebSocket| R
    O[Other participant] <-->|WebSocket| R
    R --> J
```

## Room/dashboard lifecycle

1. `POST /api/rooms` allocates a free code `0000..9999`.
2. Empty room state is persisted immediately.
3. `GET /api/rooms` lists persisted boards by last modified time for the dashboard.
4. `/b/<code>` and `/ws/<code>` exist only for known rooms.

The 4-digit code is classroom UX, **not authorization**. Public deployment needs a separate invite/owner credential.

## Shared board model

The room has two persistent content types:

```text
strokes[]  # freehand ink
objects[]  # positioned board objects; currently image
```

Images are deliberately **not base64-embedded in board JSON/WebSocket events**. The browser uploads bytes to:

```text
POST /api/boards/<room>/assets
```

and the shared object contains only same-room metadata:

```text
{id, kind:"image", x, y, width, height, src, name}
```

Assets live under `~/.local/share/local-board/assets/<room>/`. The server rejects cross-room image references in `object.create`.

## Frontend responsibilities

### Pencil/input

- native Canvas 2D; no whiteboard framework dependency;
- dedicated `PencilEngine` keeps ink independent of mouse/touch navigation;
- normal path `pointerdown → pointermove* → pointerup` plus WebKit recovery from contact-bearing `pointermove` and stylus `TouchEvent` fallback;
- Pencil ink has no debounce/cooldown and no synchronous persistence in the hot path;
- coalesced samples render locally before network transport;
- touch/palm never creates ink; one finger pans, two fingers pinch;
- eraser is a separate tool and can be operated by Pencil or mouse; it deletes whole ink strokes;
- Safari selection/callout/drag/gesture handling is suppressed on the board surface.

### Selection/object editing

`SelectionController` owns local selection state; selection itself is **not shared room state**.

Supported interactions:

- Select tool (`V`);
- click hit-test;
- drag marquee;
- `Shift` additive selection;
- `Ctrl/Cmd+A` select all;
- `Esc` clear selection;
- `Delete/Backspace` deletes selected strokes/images;
- `Ctrl/Cmd + drag` temporarily routes input to Select without changing the active tool;
- selected strokes and image objects can move;
- a single selected image can resize from its corner while preserving aspect ratio.

Transforms are committed as semantic realtime mutations (`stroke.translate`, `object.update`) rather than retransmitting every historical point/image byte.

### Images

`AssetController` supports:

- Image toolbar button / file picker;
- drag&drop onto the canvas;
- paste from clipboard;
- PNG/JPEG/WEBP/GIF up to the current server limit;
- upload first, then `object.create` with same-origin asset URL;
- image bytes are fetched/cached independently by `ImageCache`.

### Rendering

- completed ink + image objects are cached into a bitmap base layer;
- only active ink and selection overlays are repainted every display frame;
- image cache invalidates the base only when an image finishes loading;
- PNG export suppresses local selection/marquee overlays;
- viewport (`x/y/zoom`) remains local per browser.

## Camera assistance

`source_zoom` on new strokes is descriptive metadata only. Camera helpers remain local:

- **auto-follow** controls whether a passive viewer pans toward remote active writing;
- **auto-scale** independently controls whether viewer zoom approaches the writer's `source_zoom`;
- both preferences are local and remembered separately;
- local writing/pan/pinch/wheel immediately wins and pauses automatic movement;
- camera target is retargetable and eased rather than packet-jumped;
- **⌖** returns to the last writing location;
- zoom percentage displays actual local zoom; clicking it returns to 100% around current viewport center.

No role names such as teacher/student are part of this engine.

## Realtime protocol

Client mutations:

- `stroke.begin`
- `stroke.append`
- `stroke.end`
- `stroke.delete`
- `stroke.restore`
- `stroke.translate`
- `object.create`
- `object.update`
- `object.delete`
- `board.clear`

Server messages:

- `snapshot`
- `event`
- `ack`
- `presence`
- `error`

Every mutation carries `op_id`; retries are deduplicated server-side. Structural mutations are persisted atomically. Reconnect starts from authoritative snapshot and resends pending operations.

## Persistence

```text
~/.local/share/local-board/boards/<room>.json
~/.local/share/local-board/assets/<room>/<asset>
```

Override the root with `LOCAL_BOARD_DATA_DIR`.

JSON + filesystem assets intentionally fit the current single-process phase. Persistence, room state and transport are separated so a future internet deployment can replace storage without rewriting Pencil/selection/rendering logic.

## Deployment boundary

### Current phase

- one Uvicorn/FastAPI process;
- active `BoardRoom` state is process-local;
- persistent JSON + image files on one disk;
- trusted/small-room usage;
- no authentication.

### Public single-instance phase

```text
Browsers
  ↓ HTTPS / WSS
Reverse proxy / TLS
  ↓
one Local Board process
  ↓
persistent volume
```

While `BoardRoom` is in memory, run **one application worker**. Before public exposure add at minimum HTTPS/WSS, ownership/invite auth separate from room code, rate limits, Origin/Host checks, upload/request limits, backups and abuse monitoring.

### Multi-instance phase

When one process is insufficient, introduce shared durable room metadata/state plus a cross-instance event/presence layer (for example Redis/broker). Do not merely start multiple workers and hope clients land on the same process.

CRDT remains optional and should be introduced only when richer concurrent object editing actually requires it.

## Deliberate non-goals for 0.4

- fixed teacher/student behavior in drawing engine;
- accounts/authentication;
- public internet hardening;
- multi-process horizontal scaling;
- rich text/sticky notes/connectors/PDF-page objects;
- lesson scheduling/history product layer.

Images and basic object selection are now part of the implemented board model; richer object types can extend the same protocol/state seams later.

See [`deployment.md`](deployment.md) for the staged deployment plan.
