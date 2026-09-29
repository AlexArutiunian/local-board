# Local AI provider

Local Board can use the local OpenAI-compatible endpoint from
`AlexArutiunian/ubuntu_voice_chat` branch `feature/web-ai-shell` for formula OCR.

## 1. Start Local AI Shell

In `ubuntu_voice_chat`:

```bash
git switch feature/web-ai-shell
bash run_web.sh
```

Check both runtime and OpenAI compatibility:

```bash
curl http://127.0.0.1:8787/api/health
curl http://127.0.0.1:8787/v1/models
```

## 2. Configure Local Board

In `.env`:

```env
LOCAL_BOARD_AI_PROVIDER=local
LOCAL_AI_BASE_URL=http://127.0.0.1:8787/v1
LOCAL_AI_MODEL=local
LOCAL_AI_API_KEY=local
```

`LOCAL_AI_MODEL=local` means: use the model configured in the Local AI Shell's
`config.json`. The current shell does not require an API key on loopback, so the
`local` key is only a compatibility placeholder.

Restart Local Board after changing `.env`.

## 3. Switch back to OpenRouter

```env
LOCAL_BOARD_AI_PROVIDER=openrouter
OPENROUTER_API_KEY=sk-or-v1-...
OPENROUTER_FORMULA_MODEL=stealth/ox-alpha
```

OpenRouter remains the default when `LOCAL_BOARD_AI_PROVIDER` is not set.

## Network note

Keep both services on `127.0.0.1` when they run on the same computer. If Local
Board and Local AI run on different machines over LAN/ZeroTier, point
`LOCAL_AI_BASE_URL` at the private address and add authentication before exposing
that endpoint outside a trusted private network.
