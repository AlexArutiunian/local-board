# Local Board

Совместная realtime-доска для занятий и работы: создаёшь доску, делишься 4-значным кодом или ссылкой, и все участники видят общий canvas в реальном времени.

Сейчас проект запускается на одном Linux-хосте в LAN, но frontend и room-flow не привязаны к `localhost` и рассчитаны на последующий HTTPS/WSS-деплой.

## Что уже есть

- **dashboard досок** на `/`: создание новой доски, вход по 4-значному коду и список ранее созданных досок с последним временем изменения;
- realtime-комнаты через WebSocket, snapshot/reconnect, `ack`, `op_id` и защита от повторного применения операций;
- Apple Pencil ink + pressure, WebKit recovery для быстрых контактов Safari, palm rejection;
- безопасный default input: Apple Pencil рисует, один палец и мышь двигают canvas, два пальца делают pinch zoom;
- отдельный локальный toggle **«рисовать мышью/пальцем»**: с Pen один палец или ЛКМ рисуют, с Eraser стирают; Pan tool всегда возвращает перемещение;
- даже в режиме finger ink второй палец отменяет только незавершённый finger-stroke и сразу переводит жест в обычный pinch, поэтому масштабирование не теряется;
- ластик работает Apple Pencil и мышью, а при включённом direct-ink режиме — также пальцем; удаляет рукописные штрихи целиком;
- Select tool (`V`): click, drag-marquee, `Shift` multi-select, `Ctrl/Cmd+A`, `Esc`, `Delete/Backspace`;
- **ПКМ + удержание + drag** — временная рамка выделения из любого инструмента; при отпускании ПКМ рамка исчезает, выбранные объекты остаются;
- `Ctrl/Cmd + drag` временно включает выделение даже из другого инструмента;
- выделенные штрихи и картинки можно перемещать; картинку можно менять по размеру за угловой handle;
- изображения: кнопка Image, drag&drop и paste из clipboard; PNG/JPEG/WEBP/GIF хранятся отдельно от JSON и синхронизируются как board objects;
- **неразрушающее кадрирование изображений**: выбери одну картинку → Crop → двигай рамку или её 8 handles → ✓ применить / × отменить; crop metadata синхронизируется и сохраняется в snapshot;
- цвет через компактный popover + произвольный цвет, толщина линии;
- undo/redo рукописных штрихов, включая удаление ластиком и удаление выбранной рукописи;
- completed-ink bitmap cache для плавного remote rendering;
- role-neutral auto-follow за активным пишущим участником;
- отдельная кнопка **автоследования** и отдельная кнопка **автомасштаба под источник**; обе настройки запоминаются локально;
- `⌖` — плавно перейти к последнему месту письма;
- процент в toolbar показывает **реальный текущий zoom**; клик по нему возвращает масштаб к `100%` вокруг центра текущего viewport, не телепортируя в начало доски;
- плавающие верхние карточки вместо пустой полноширинной шапки;
- PNG и Clear спрятаны в меню `⋯`;
- атомарное сохранение состояния досок и локальное хранение изображений.

## Быстрый запуск

```bash
git clone https://github.com/AlexArutiunian/local-board.git
cd local-board
bash scripts/run.sh
```

На Linux:

```text
http://127.0.0.1:8000
```

Для iPad/другого устройства узнай LAN-IP:

```bash
hostname -I
```

и открой, например:

```text
http://192.168.1.50:8000
```

Главная `/` теперь является списком досок. Создай новую доску или открой прошлую карточкой. Внутри комнаты кнопка **Поделиться** копирует `/b/<4-digit-code>`.

> 4-значный код удобен для занятия, но не является авторизацией. Перед публичным интернет-деплоем нужен отдельный owner/invite credential — см. `docs/deployment.md`.

## Управление

| Действие | Управление |
|---|---|
| Рисование Apple Pencil | Pen tool, работает всегда |
| Рисование мышью/пальцем | включить отдельную кнопку direct ink → Pen tool → ЛКМ / один палец |
| Обычный pan | direct ink выключен: палец/мышь; либо в любой момент выбрать Pan tool |
| Zoom | два пальца / колесо; работает и при включённом direct ink |
| Ластик | `E`; Pencil/мышь, а с direct ink — также один палец |
| Select | `V` |
| Быстрая рамка выделения | удерживать `ПКМ` и тянуть; отпускание завершает выбор |
| Временно выделить | `Ctrl/Cmd + drag` |
| Добавить к выбору | `Shift + click/drag` |
| Выделить всё | `Ctrl/Cmd+A` |
| Удалить выделенное | `Delete` / `Backspace` |
| Ручка | `P` |
| Pan tool | `H` |
| Вставить изображение | кнопка Image / drag&drop / paste |
| Кадрировать изображение | выбрать одну картинку → Crop → рамка/handles → ✓ или × |
| Undo/Redo рисования и стирания | `Ctrl/Cmd+Z`, `Ctrl/Cmd+Shift+Z` |

## Данные

По умолчанию:

```text
~/.local/share/local-board/boards/   # состояние досок
~/.local/share/local-board/assets/   # изображения по комнатам
```

Свой каталог:

```bash
LOCAL_BOARD_DATA_DIR=/path/to/data bash scripts/run.sh
```

Другой порт:

```bash
LOCAL_BOARD_PORT=9000 bash scripts/run.sh
```

## Структура

```text
.
├── AGENTS.md
├── README.md
├── pyproject.toml
├── docs/
├── scripts/
├── src/local_board/
│   ├── main.py
│   ├── protocol.py
│   ├── room.py
│   ├── storage.py
│   └── web/
└── tests/
```

## Development

```bash
python3 -m venv .venv
. .venv/bin/activate
pip install -e '.[dev]'
pytest
uvicorn local_board.main:app --host 0.0.0.0 --port 8000
```

Архитектура: [`docs/architecture.md`](docs/architecture.md)  
Деплой: [`docs/deployment.md`](docs/deployment.md)
