# local-board

Локальная веб-доска для iPad / Apple Pencil. Сервер запускается на Linux, а доска открывается в Safari по локальной сети.

## Запуск

```bash
git clone https://github.com/AlexArutiunian/local-board.git
cd local-board
./run.sh
```

Локально на Linux:

```text
http://127.0.0.1:8000
```

Чтобы открыть с iPad, узнай IP Linux:

```bash
hostname -I
```

Например, если адрес Linux `192.168.1.50`, открой в Safari:

```text
http://192.168.1.50:8000
```

## Возможности MVP

- Apple Pencil, палец и мышь;
- сглаженные штрихи;
- учёт pressure Apple Pencil;
- ручка, ластик и перемещение холста;
- pinch-to-zoom двумя пальцами;
- undo / redo;
- несколько цветов и настройка толщины;
- точечная сетка;
- автосохранение на Linux;
- экспорт текущего вида в PNG.

Никаких `npm install` или `pip install` не требуется — нужен только Python 3.

Состояние доски хранится локально в `data/board.json` и не коммитится в Git.

## Firewall

Если iPad не видит сервер:

```bash
sudo ufw allow 8000/tcp
```

Проверка:

```bash
ss -ltnp | grep 8000
```

Другой порт:

```bash
WHITEBOARD_PORT=9000 ./run.sh
```

Остановка сервера: `Ctrl+C`.
