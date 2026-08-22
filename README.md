# Local Board

Совместная realtime-доска для занятий и работы: один участник создаёт комнату, делится ссылкой или коротким кодом, и все подключённые участники видят общий рисунок во время письма.

Сейчас проект удобно запускать на Linux в локальной сети. Архитектура при этом не привязана к `localhost`: тот же room-flow рассчитан на будущий HTTPS-деплой на обычном домене.

## Что уже есть

- отдельные комнаты с явным lifecycle;
- создание комнаты с главной страницы;
- **ровно 4 цифры в коде комнаты**;
- кнопка «Поделиться» с копированием ссылки;
- realtime-штрихи через WebSocket;
- Apple Pencil + pressure;
- Pencil-only ink с WebKit recovery: основной Pointer Events path плюс stylus Touch Events fallback для проблемных быстрых контактов Safari;
- защита от Safari text-selection/callout/drag на рабочей доске;
- Pencil samples обрабатываются локально сразу, а WebSocket append-события батчатся раз в animation frame, чтобы не забивать main thread;
- completed-stroke bitmap cache: на realtime append не перерисовывается весь старый конспект;
- palm rejection: пока Pencil касается экрана, touch/palm не рисует и не двигает холст;
- один палец — pan, два пальца — pinch zoom;
- мышь используется только для навигации;
- локальное optimistic rendering: Pencil не ждёт сеть;
- **плавное role-neutral auto-follow**: если удалённый активный пишущий участник выходит к краю/за пределы локального viewport, пассивный экран мягко подруливает к месту письма;
- новый штрих передаёт `source_zoom`, поэтому при заметной разнице масштаба пассивный экран плавно подстраивает visual scale под устройство, где пишут;
- auto-follow одновременно анимирует pan и zoom, имеет более мягкую инерцию и не делает резких packet-by-packet прыжков;
- auto-follow не синхронизирует viewport между устройствами и временно отключается при локальном письме/pan/zoom, поэтому управление остаётся у каждого участника;
- защита от ping-pong при одновременном письме нескольких участников;
- кнопка **⌖** плавно возвращает к последнему месту письма с сохранённым масштабом источника;
- ручка, ластик, цвета, толщина;
- undo/redo собственных штрихов с синхронизацией у всех;
- общий clear board;
- online/offline status и число подключённых клиентов;
- reconnect с повторной отправкой неподтверждённых операций;
- защита от повторного применения операций через `op_id`;
- серверный snapshot при подключении;
- атомарное сохранение состояния;
- отдельный viewport на каждом устройстве;
- PNG текущего вида.

## Быстрый запуск на Linux

```bash
git clone https://github.com/AlexArutiunian/local-board.git
cd local-board
bash scripts/run.sh
```

На Linux открой:

```text
http://127.0.0.1:8000
```

Для iPad/другого устройства узнай LAN-IP Linux:

```bash
hostname -I
```

Например:

```text
192.168.1.50
```

Тогда на всех устройствах открывай:

```text
http://192.168.1.50:8000
```

На главной нажми **«Создать новую комнату»**. Сервер создаст, например, код:

```text
4821
```

и ссылку:

```text
http://192.168.1.50:8000/b/4821
```

Другому участнику можно отправить ссылку кнопкой **«Поделиться»** или просто сообщить четыре цифры.

> Четырёхзначный код удобен для занятия, но имеет всего 10 000 вариантов и **не является защитой**. Перед публичным интернет-деплоем доступ должен проверяться отдельным owner/invite credential — см. `docs/deployment.md`.

## Почему локальная и будущая интернет-версия — один код

Frontend не содержит hardcoded host/IP:

- HTTP API вызывается через relative same-origin paths;
- WebSocket автоматически использует `ws://` на HTTP и `wss://` на HTTPS;
- share link строится из текущего `location.origin`.

Поэтому сегодня адрес может быть `http://192.168.1.50:8000`, а после деплоя — например `https://board.example.com` без переписывания room/frontend logic.

## Структура

```text
.
├── AGENTS.md
├── README.md
├── pyproject.toml
├── docs/
│   ├── architecture.md
│   └── deployment.md
├── scripts/
│   └── run.sh
├── src/local_board/
│   ├── config.py
│   ├── main.py
│   ├── models.py
│   ├── protocol.py
│   ├── room.py
│   ├── room_service.py
│   ├── storage.py
│   └── web/
└── tests/
```

## Данные

По умолчанию доски хранятся здесь:

```text
~/.local/share/local-board/boards/
```

Свой каталог:

```bash
LOCAL_BOARD_DATA_DIR=/path/to/data bash scripts/run.sh
```

Другой порт:

```bash
LOCAL_BOARD_PORT=9000 bash scripts/run.sh
```

## Firewall для LAN

Если iPad не подключается:

```bash
sudo ufw allow 8000/tcp
```

Проверка сервера:

```bash
ss -ltnp | grep 8000
```

Health check:

```text
http://127.0.0.1:8000/health
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
Путь к будущему интернет-деплою: [`docs/deployment.md`](docs/deployment.md)
