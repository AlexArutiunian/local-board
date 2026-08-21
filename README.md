# Local Board

Локальная совместная веб-доска для iPad / Apple Pencil и обычных браузеров.

**Главное:** все устройства, которые открыли одну и ту же доску, видят рисование друг друга в realtime. Linux-машина выступает локальным сервером и хранит состояние досок.

## Что уже есть

- realtime-штрихи через WebSocket;
- Apple Pencil + pressure;
- локальное optimistic rendering: Pencil не ждёт сеть;
- палец на iPad используется для pan/pinch zoom, чтобы не оставлять случайные линии;
- ручка, ластик, цвета, толщина;
- undo/redo собственных штрихов с синхронизацией у всех;
- общий clear board;
- online/offline status и число подключённых клиентов;
- reconnect с повторной отправкой неподтверждённых операций;
- защита от повторного применения операций через `op_id`;
- серверный snapshot при подключении;
- атомарное сохранение состояния на Linux;
- отдельный viewport на каждом устройстве;
- PNG текущего вида.

## Структура

```text
.
├── AGENTS.md
├── README.md
├── pyproject.toml
├── docs/
│   └── architecture.md
├── scripts/
│   └── run.sh
├── src/local_board/
│   ├── config.py
│   ├── main.py
│   ├── models.py
│   ├── protocol.py
│   ├── room.py
│   ├── storage.py
│   └── web/
│       ├── index.html
│       └── assets/
└── tests/
```

## Запуск на Linux

```bash
git clone https://github.com/AlexArutiunian/local-board.git
cd local-board
bash scripts/run.sh
```

Сервер будет доступен локально:

```text
http://127.0.0.1:8000
```

Узнай IP Linux:

```bash
hostname -I
```

Например, Linux имеет адрес `192.168.1.50`.

Открой **на всех устройствах один и тот же URL**:

```text
http://192.168.1.50:8000/b/study
```

Теперь линия, которую ты проводишь на iPad, должна появляться на ноутбуке/ПК во время рисования.

Можно создавать разные доски просто разными именами:

```text
/b/study
/b/math
/b/lecture_01
```

## Где хранятся доски

По умолчанию:

```text
~/.local/share/local-board/boards/
```

То есть пользовательские данные не лежат внутри git-репозитория.

Свой каталог:

```bash
LOCAL_BOARD_DATA_DIR=/path/to/data bash scripts/run.sh
```

Другой порт:

```bash
LOCAL_BOARD_PORT=9000 bash scripts/run.sh
```

## Если iPad не подключается

Устройства должны видеть Linux по локальной сети. Если включён UFW:

```bash
sudo ufw allow 8000/tcp
```

Проверка:

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

Архитектура и realtime protocol: [`docs/architecture.md`](docs/architecture.md).
