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

AI-rendered formulas deliberately reuse the same image-object path after recognition/typesetting; there is no second formula persistence model yet.

## Frontend input model

### Apple Pencil

`PencilEngine` owns active freehand contact and keeps network transport out of the visual critical path. Pointer Events are primary; WebKit contact-move and stylus TouchEvent recovery remain available.

Apple Pencil retains the active Pen/Eraser/Pan semantics even while a finger-selected image is open. A finger can therefore move a task image while Pencil continues to annotate.

The explicit **Select tool is the exception**: when Select is active, Pencil is intentionally a selection pointer rather than an ink pointer. Leaving Select for Pen immediately restores normal Pencil writing.

`pen-ui-controls.js` handles a separate Safari problem: Pencil taps on app-style HTML controls do not always synthesize a reliable click. It converts a short, low-movement Pencil pointer tap on buttons/menu actions into the same semantic click as a finger and suppresses a possible duplicate native click. Binding is idempotent and is installed before the first profile dialog.

`pen-ui-controls.js` also imports `selection-productivity-bootstrap.js` as a side-effect before the app constructs its concrete `InputController`; this keeps Select routing out of `app.js` and the Pencil drawing hot path.

### Finger / mouse

Default tablet model outside Select:

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

### Select routing

Select is deliberately **pointer-type neutral** for the first contact:

```text
Select + mouse → selection
Select + Apple Pencil → selection
Select + 1 finger → selection
Select + 2 fingers → pinch/pan
```

`selection-productivity-bootstrap.js` installs `selection-productivity.js` before concrete `InputController` instances start receiving input. It extends Select routing without inserting selection branches into the Pencil hot path. A first touch is tracked as a selection contact; if a second touch arrives, the current selection preview is cancelled and `InputController.promoteSelectionTouchToNavigation()` promotes both contacts to the standard pinch/pan gesture.

This is a semantic invariant: **two-finger navigation wins over Select** on touch devices.

## Selection and image editing

`SelectionController` owns local-only selection/marquee/crop/context UI. `selection-productivity.js` adds group editing and cross-device routing around that controller.

- `V` — Select;
- marquee appears only after a real drag threshold;
- mouse, Pencil and one finger can create the marquee;
- Shift additive selection;
- `Ctrl/Cmd+A`, Esc, Delete/Backspace;
- `Ctrl/Cmd + drag` temporary Select;
- held RMB + drag temporary marquee; plain RMB click does nothing;
- selected strokes/images move semantically;
- after a group exists, pointer-down **anywhere inside its combined blue bounds** starts a pending group move when the point does not target an unrelated item; hitting the exact stroke is not required;
- two-finger touch during selection move/marquee cancels only the active preview and starts pinch/pan;
- arbitrary stroke/image groups can be snapshotted to an in-browser selection clipboard;
- group `Copy`, `Paste`, `Duplicate`, `Delete` and `Done` are exposed in a contextual touch-friendly toolbar near the selected bounds;
- `Ctrl/Cmd+C`, `Ctrl/Cmd+V`, `Ctrl/Cmd+D` support handwriting/mixed selections in addition to the existing single-image workflow;
- duplicated handwriting uses new stroke IDs and `stroke.restore`, preserving style and points with a small positional offset;
- image resize preserves aspect ratio;
- a single selected image keeps its richer image-specific contextual toolbar rather than showing both bars;
- image actions: crop, copy, duplicate, image front/back, reset crop, delete, done;
- double-click image enters crop;
- crop uses eight handles + draggable crop area.

Selection outlines, clipboards, crop overlay and contextual toolbars are local UI state and are never broadcast. Only semantic mutations resulting from move/delete/paste/etc. enter realtime state.

## AI formula transformation

`formula-transform.js` adds **Преобразовать формулу** to both the generic selection toolbar and single-image toolbar.

Pipeline:

```text
selected board items
→ browser offscreen PNG containing only selected content
→ POST /api/boards/<room>/ai/formula
→ FastAPI ai_formula.py
→ OpenRouter /api/v1/chat/completions
→ stealth/ox-alpha image+text → JSON {latex}
→ MathJax TeX→SVG in browser
→ rasterized transparent PNG
→ existing /assets upload
→ ordinary object.create realtime event
```

The capture is reconstructed from selected board data rather than cropping the visible canvas. Therefore selection outlines, unrelated strokes, current viewport chrome and grid are not sent to the model. Selected image objects are drawn using their current non-destructive crop; selected strokes are redrawn on a white background.

The server owns the OpenRouter credential:

```text
OPENROUTER_API_KEY
OPENROUTER_FORMULA_MODEL=stealth/ox-alpha
```

`.env` is gitignored and `scripts/run.sh` sources it before starting Uvicorn. The API key is never returned to or embedded in browser JavaScript.

The OpenRouter call is deliberately non-streaming and uses low reasoning effort plus a small completion budget because the workload is OCR/serialization rather than mathematical problem solving. The prompt explicitly asks for MathJax-compatible LaTeX and forbids solving/simplifying the expression.

Recognition is **non-destructive in the first product version**. The source selection remains; the typeset result is placed directly below it and scaled to fit approximately the same selected dimensions. This makes visual verification easy and means one normal image-create Undo removes the AI result without needing a cross-event replacement transaction.

MathJax is lazy-loaded only on the first transform from jsDelivr. We use SVG output with `fontCache: none`, then serialize/rasterize it so the persisted shared board still contains a normal PNG image. MathJax is Apache-2.0 licensed.

Privacy boundary: the selected capture is external data sent through OpenRouter to the selected third-party model provider. Do not treat the AI endpoint as local-only processing.

## Undo/redo

`LocalHistoryController` records only locally initiated reversible actions. Remote peer mutations never enter another browser's undo stack.

Current reversible content actions include:

- stroke create/delete;
- image create/delete (including duplicate/paste and AI formula result insertion).

`BoardState` keeps bounded tombstones for deleted strokes and image objects, enabling an image deleted from its contextual menu to return with the same geometry/crop on Undo. Replay uses `recordHistory:false` to avoid recursive history entries.

The local history instance is exposed to the modular selection bootstrap so duplicated handwriting can call the same `recordCreatedStroke()` path used by normal ink.

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

AI recognition itself is an ordinary HTTP helper operation and does not mutate room state. Only the resulting PNG upload plus `object.create` enter the existing realtime protocol.

Presence is ephemeral and additionally carries `roster`; it does not increment board revision.

## Activity logging

Activity history is intentionally separate from the current board snapshot. It is an append-only audit/replay stream, never a second in-memory copy of the whole lesson.

For high-frequency ink the server does **not** log `stroke.begin` or any `stroke.append` packets. `BoardRoom` keeps only a bounded map of active stroke start timestamps (maximum 2048 entries). When `stroke.end` arrives, one semantic activity record is appended with:

```text
server timestamp + start timestamp + duration
actor: client id, name, teacher/student role, device
stroke id
point count
color / width / pointer type
bounding box
path_z
```

`path_z` is a replay payload produced in `activity.py`: `[x,y]` coordinates are quantized to 0.1 board units, serialized compactly, compressed with zlib and base85 encoded. Pressure is intentionally omitted from the audit copy. This preserves enough geometry to replay who wrote what even if the live stroke is later deleted or the board is cleared, without duplicating raw WebSocket traffic.

Other semantic records include:

```text
join / leave
stroke.delete / restore / translate
object.create / update / reorder / delete
board.background
board.clear
```

`JsonBoardStore.append_activity()` opens, appends one compact JSON line and closes the file. Historical lines are never loaded into `BoardRoom`. Logs are sharded by room and UTC day:

```text
activity/<room>/YYYY-MM-DD.jsonl
```

This keeps RAM usage effectively constant with lesson length and prevents one ever-growing activity file.

## Persistence

```text
~/.local/share/local-board/boards/<room>.json
~/.local/share/local-board/assets/<room>/<asset>
~/.local/share/local-board/activity/<room>/YYYY-MM-DD.jsonl
```

Override root with `LOCAL_BOARD_DATA_DIR`.

Current JSON/filesystem storage intentionally matches single-process deployment.

## Deployment boundary

### Current

- one Uvicorn/FastAPI process;
- process-local authoritative `BoardRoom`;
- JSON + image files + append-only activity logs on one disk;
- optional outbound OpenRouter request for formula OCR;
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
persistent volume + outbound OpenRouter
```

Before permanent internet exposure add at minimum:

- owner/invite secrets independent of room code and role label;
- private owner dashboard;
- server-side permission checks;
- Origin/Host validation;
- **rate limits on AI recognition**, because the endpoint uses a server-held API credential;
- request/upload limits;
- backups/abuse monitoring.

While `BoardRoom` is in memory, run one app worker.

### Multi-instance

Multiple app workers require shared durable state plus cross-instance event/presence transport (for example a broker). Do not scale by merely starting several independent `BoardRoom` processes.

CRDT remains optional until richer concurrent editing actually needs it.

## Deliberate non-goals for current phase

- role-based security without real credentials;
- accounts;
- permanent public hardening of the AI endpoint;
- multi-process horizontal scaling;
- rich text/sticky notes/connectors/PDF-page objects;
- lesson scheduling/product CRM layer.

See [`deployment.md`](deployment.md) for deployment stages.
