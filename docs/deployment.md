# Deployment path

Этот документ описывает не текущую обязанность «срочно задеплоить», а границы, которые позволяют развивать локальную версию без будущего переписывания frontend/realtime flow.

## Stage 1 — LAN development / demo

Текущий режим:

```bash
bash scripts/run.sh
```

Пример адреса:

```text
http://192.168.1.50:8000
```

Главная `/` создаёт комнату с четырёхзначным кодом, после чего преподаватель отправляет ученику ссылку `/b/<room-code>` или сообщает 4 цифры.

На этом этапе допустимо:

- один процесс приложения;
- JSON на локальном диске;
- отсутствие аккаунтов;
- доверенные участники в LAN;
- HTTP/WS.

## Stage 2 — один публичный сервер

Первый интернет-деплой не требует менять canvas/realtime frontend.

Целевая схема:

```text
Internet
  ↓
HTTPS / WSS domain
  ↓
reverse proxy with TLS
  ↓
Local Board: one application process
  ↓
persistent volume
```

Frontend уже готов к этому режиму:

- REST paths relative;
- WebSocket выбирает `wss://` при HTTPS;
- invitation URL строится из текущего origin.

### До публичного запуска обязательно добавить

1. **Identity / permissions**
   - владелец комнаты (teacher);
   - участник (student);
   - решение, кто может clear/delete/export/rename;
   - invite policy.

2. **Transport security**
   - HTTPS/WSS;
   - secure cookies/tokens, если появится auth;
   - корректная WebSocket Origin policy.

3. **Abuse controls**
   - rate limit создания комнат;
   - rate limit/size limits WebSocket messages;
   - ограничения числа клиентов/комнат;
   - логирование ошибок и подозрительной нагрузки.

4. **Durability**
   - persistent volume вне container filesystem;
   - backup policy;
   - проверяемое восстановление.

5. **Operations**
   - health endpoint;
   - service restart policy;
   - structured logs;
   - конфигурация через environment/secrets;
   - обновления без ручного редактирования production-файлов.

### Важное ограничение

Пока room state находится в памяти процесса, production должен запускать **один application worker**.

Нельзя просто включить несколько Uvicorn/Gunicorn workers: разные участники одной комнаты могут попасть в разные процессы и перестанут видеть общий realtime state.

## Stage 3 — multi-instance

Переход нужен только когда один процесс/сервер действительно перестаёт справляться.

Предполагаемый seam:

```text
Clients
  ↓
Load balancer
  ↓
App instance A ─┐
App instance B ─┼─ shared realtime broker / presence
App instance C ─┘
        ↓
shared durable database
```

Тогда:

- room metadata/ownership хранится в БД;
- durable state хранится в общей storage layer;
- events/presence проходят через Redis/аналогичный broker;
- любой app instance может обслуживать клиента комнаты;
- sticky sessions могут быть оптимизацией, но не основой корректности.

## Room codes and security

Текущий room code — **ровно 4 цифры**. Это удобно на занятии: преподаватель может просто сказать ученику `4821`, а не диктовать длинный идентификатор.

Но 4 цифры дают всего 10 000 вариантов, поэтому код **никогда нельзя считать секретом или механизмом авторизации** при публичном интернет-деплое.

Перед публичным запуском короткий human-friendly room code должен быть отделён от доступа. Например:

- teacher account/session + отдельный случайный invite token ученика;
- owner secret для преподавателя + случайный participant invite token;
- либо другой нормальный auth/invite flow.

То есть в будущем можно сохранить красивый URL/код `4821` для UX, но реальное право подключиться должно проверяться отдельным credential. Сложную auth-систему пока не встраиваем в realtime ink core.

## What must remain deployment-neutral

При дальнейшей разработке нельзя:

- hardcode `localhost`, LAN-IP или будущий домен во frontend;
- хранить user data внутри git checkout/container image;
- связывать rendering/input напрямую с конкретной БД;
- заставлять клиент знать внутреннюю topology backend;
- добавлять multi-worker deployment до shared room coordination.

Именно эти ограничения позволяют продолжать локальную разработку, а позже задеплоить тот же продуктовый flow.
