# Local Board

Совместная realtime-доска для занятий: преподаватель создаёт комнату, отправляет ученику ссылку, и все участники видят рисунок друг друга во время письма.

Сейчас проект удобно запускать на Linux в локальной сети. Архитектура при этом не привязана к `localhost`: тот же room-flow рассчитан на будущий HTTPS-деплой на обычном домене.

## Что уже есть

- отдельные комнаты с явным lifecycle;
- создание комнаты с главной страницы;
- случайные трудноугадываемые room ID;
- кнопка «Поделиться» с копированием ссылки;
- realtime-штрихи через WebSocket;
- Apple Pencil + pressure;
- **строго Pencil-only ink**: рисовать и стирать можно только `pointerType === "pen"`;
- palm rejection: пока Pencil касается экрана, touch/palm не рисует и не двигает холст;
- один палец — pan, два пальца — pinch zoom;
- мышь используется только для навигации;
- локальное optimistic rendering: Pencil не ждёт сеть;
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

На главной нажми **«Создать новую комнату»**. Сервер создаст ссылку вида:

```text
http://192.168.1.50:8000/b/7C8xYp2nWk4QeL9a
```

Её можно скопировать кнопкой **«Поделиться»** внутри доски и отправить ученику.

> Room ID сейчас является трудноугадываемым идентификатором, но не заменяет настоящую авторизацию. Перед публичным интернет-деплоем будут нужны роли/permissions и hardening — см. `docs/deployment.md`.

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
