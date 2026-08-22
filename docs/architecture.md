# Architecture

## Goal

`local-board` — room-based realtime-доска для занятий. Один Linux-процесс обслуживает несколько браузеров; локальный input отображается оптимистично, shared mutations валидируются сервером, затем broadcast'ятся остальным участникам и сохраняются.

```text
Dashboard / → room /b/<code>
→ local ink/object action
→ validated WebSocket mutation
→ authoritative BoardRoom
→ broadcast to peers
→ JSON snapshot + separate image assets
```

Frontend host-agnostic: same-origin HTTP/WebSocket работает на localhost, LAN и через HTTPS/WSS tunnel/reverse proxy.

## Room lifecycle

1. `POST /api/rooms` создаёт свободный код `0000..9999`.
2. Пустая доска сохраняется сразу.
3. `GET /api/rooms` используется dashboard'ом.
4. Dashboard — преподавательский workflow и открывает комнаты с `role=teacher`.
5. `/b/<code>` и `/ws/<code>` существуют только для сохранённых комнат.

4-значный код — UX, **не авторизация**.

## Participant identity and presence

Каждое WebSocket-подключение передаёт validated connection profile:

```text
name
role: teacher | student
device: iPad | Компьютер | ...
```

`BoardRoom.client_profiles` — ephemeral connection state и не сохраняется в board JSON. Presence payload содержит `roster[]`, поэтому UI может отдельно показать преподавателей/учеников и устройство каждого подключения.

Преподаватель может открыть одну комнату с ноутбука и iPad: teacher invite переносит то же имя/роль, а device определяется каждым браузером самостоятельно. Это остаются два WebSocket clients, поэтому realtime input и reconnect независимы.

**Критическая граница:** текущая роль — только identity/UX. Она client-supplied и не должна использоваться как security permission. Публичный teacher-only доступ потребует server-issued owner/invite credential, отдельного от `role` и room code.

## Shared board model

Persisted board snapshot:

```text
revision
background
strokes[]
objects[]
```

`background`:

```json
{"pattern":"dots","tone":"white"}
```

Allowed patterns:

```text
plain | dots | grid | fine-grid | ruled | cornell | isometric
```

Allowed tones:

```text
white | warm | gray | blue | green
```

Background is **shared board state**: `board.background` is validated, broadcast and persisted. It is not a local viewport preference.

### Ink

A stroke stores freehand points plus style and optional descriptive `source_zoom`. `source_zoom` helps a viewer's local auto-scale but is not shared camera state.

### Images

Images are not embedded as base64 in JSON/WebSocket messages. Browser uploads bytes to:

```text
POST /api/boards/<room>/assets
```

and shared state stores only:

```text
id, kind=image
x, y, width, height
src, name
crop_x, crop_y, crop_width, crop_height
```

Assets live under `~/.local/share/local-board/assets/<room>/`; cross-room asset references are rejected. Crop is non-destructive normalized metadata. `objects[]` order is image stacking order; `object.reorder` persists front/back changes. Ink renders above the image layer.

## Frontend input model

### Apple Pencil

`PencilEngine` owns active freehand contact and keeps network transport out of the visual critical path. Pointer Events are primary; WebKit contact-move and stylus TouchEvent recovery remain available.

Apple Pencil retains the active Pen/Eraser/Pan semantics even while a finger-selected image is open. A finger can therefore move a task image while Pencil continues to annotate.

`pen-ui-controls.js` handles a separate Safari problem: Pencil taps on app-style HTML controls do not always synthesize a reliable click. It converts a short, low-movement Pencil pointer tap on buttons/menu actions into the same semantic click as a finger and suppresses a possible duplicate native click. Binding is idempotent and is installed before the first profile dialog.

### Finger / mouse

Default tablet model:

```text
Pencil → ink
1 finger on image → select/move image
1 finger elsewhere → pan
2 fingers → pinch
```

Touching empty canvas dismisses image editing; there is no sticky object-edit mode. If a second finger arrives during image move/crop, current object preview is cancelled and both fingers become the ordinary pinch gesture.

`directInkEnabled` is an explicit local preference for users without Pencil. When it is on:

```text
Pen + finger/LMB → ink
Eraser + finger/LMB → erase
Pan → navigation
2 fingers → pinch
```

Explicit direct ink has priority over image hit-testing, so a student can draw directly over an inserted photo instead of unexpectedly dragging it. Crop mode remains explicit and receives one-finger crop manipulation until it is applied/cancelled.

## Selection and image editing

`SelectionController` owns local-only selection/marquee/crop/context UI.

- `V` — Select;
- marquee appears only after a real drag threshold;
- Shift additive selection;
- `Ctrl/Cmd+A`, Esc, Delete/Backspace;
- `Ctrl/Cmd + drag` temporary Select;
- held RMB + drag temporary marquee; plain RMB click does nothing;
- selected strokes/images move semantically;
- image resize preserves aspect ratio;
- selected image gets a contextual toolbar near the image;
- actions: crop, copy, duplicate, image front/back, reset crop, delete, done;
- double-click image enters crop;
- crop uses eight handles + draggable crop area.

Selection outlines, crop overlay and contextual toolbar are never broadcast.

## Undo/redo

`LocalHistoryController` records only locally initiated reversible actions. Remote peer mutations never enter another browser's undo stack.

Current reversible content actions include:

- stroke create/delete;
- image create/delete (including duplicate/paste).

`BoardState` keeps bounded tombstones for deleted strokes and image objects, enabling an image deleted from its contextual menu to return with the same geometry/crop on Undo. Replay uses `recordHistory:false` to avoid recursive history entries.

Background changes are currently not part of local Undo/Redo.

## Background rendering

`background-presets.js` defines the protocol-compatible presets. `board-background.js` installs the paper renderer into the CanvasRenderer instance without making paper choice a viewport preference.

Patterns are calculated from world-space pan/zoom so grids remain anchored while moving the canvas. The completed base bitmap therefore contains:

```text
paper background
→ images
→ completed ink
```

Active ink and local overlays render above it.

## Camera assistance

Viewport remains local per browser.

- auto-follow controls local pan toward remote writing;
- auto-scale independently approaches writer `source_zoom`;
- both are local remembered preferences;
- local input immediately wins;
- `⌖` focuses last writing location;
- zoom percentage is actual local zoom; clicking returns to 100% around current viewport centre.

Participant roles do not alter these drawing/camera rules.

## Realtime protocol

Client mutations:

```text
stroke.begin
stroke.append
stroke.end
stroke.delete
stroke.restore
stroke.translate
object.create
object.update
object.reorder
object.delete
board.background
board.clear
```

Server messages:

```text
snapshot
event
ack
presence
error
```

Every mutation has `op_id`; retry delivery is deduplicated. Structural mutations are persisted atomically. Reconnect starts from authoritative snapshot then resends pending operations.

Presence is ephemeral and additionally carries `roster`; it does not increment board revision.

## Persistence

```text
~/.local/share/local-board/boards/<room>.json
~/.local/share/local-board/assets/<room>/<asset>
```

Override root with `LOCAL_BOARD_DATA_DIR`.

Current JSON/filesystem storage intentionally matches single-process deployment.

## Deployment boundary

### Current

- one Uvicorn/FastAPI process;
- process-local authoritative `BoardRoom`;
- JSON + image files on one disk;
- no real authentication;
- roles are descriptive only.

### Public single-instance

```text
Browser
 ↓ HTTPS/WSS
Cloudflare Tunnel / reverse proxy
 ↓
one Local Board process
 ↓
persistent volume
```

Before permanent internet exposure add at minimum:

- owner/invite secrets independent of room code and role label;
- private owner dashboard;
- server-side permission checks;
- Origin/Host validation;
- rate limits and request/upload limits;
- backups/abuse monitoring.

While `BoardRoom` is in memory, run one app worker.

### Multi-instance

Multiple app workers require shared durable state plus cross-instance event/presence transport (for example a broker). Do not scale by merely starting several independent `BoardRoom` processes.

CRDT remains optional until richer concurrent editing actually needs it.

## Deliberate non-goals for current phase

- role-based security without real credentials;
- accounts;
- public internet hardening;
- multi-process horizontal scaling;
- rich text/sticky notes/connectors/PDF-page objects;
- lesson scheduling/product CRM layer.

See [`deployment.md`](deployment.md) for deployment stages.
