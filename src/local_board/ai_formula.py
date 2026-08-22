from __future__ import annotations

import asyncio
import json
import logging
import re
import time
from typing import Any

import httpx

OPENROUTER_CHAT_URL = "https://openrouter.ai/api/v1/chat/completions"

# Formula OCR needs a model that is actually good at visual mathematics.
# Qwen2.5-VL-32B is explicitly free on OpenRouter and is tuned for mathematical
# reasoning / MathVista-style visual tasks. 72B is a deterministic free fallback.
DEFAULT_FORMULA_MODEL = "qwen/qwen2.5-vl-32b-instruct:free"
FREE_FORMULA_FALLBACK_MODELS = (
    "qwen/qwen2.5-vl-72b-instruct:free",
)

# Values used by older revisions. Migrate them automatically so a stale .env
# cannot keep selecting a rate-limited or low-quality route after git pull.
LEGACY_FORMULA_MODELS = {
    "stealth/ox-alpha",
    "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free",
    "dots-studio/dots-3-note-preview:free",
    "openrouter/free",
    "google/gemma-4-31b-it-20260402:free",
    "google/gemma-4-31b-it:free",
    "google/gemma-4-26b-a4b-it:free",
}

MAX_FORMULA_IMAGE_CHARS = 3_500_000
MAX_LATEX_CHARS = 4096
MAX_OUTPUT_TOKENS = 96
NO_FORMULA_TOKEN = "__NO_FORMULA__"

# Give the math-focused 32B model the first shot. If it is slow, hedge to 72B.
# If 32B returns a provider 429/5xx, 72B starts immediately instead of waiting.
FALLBACK_HEDGE_SECONDS = 1.0
PER_ATTEMPT_TIMEOUT_SECONDS = 3.2
TOTAL_OCR_TIMEOUT_SECONDS = 4.0
TRANSIENT_HTTP_STATUSES = {408, 409, 425, 429, 500, 502, 503, 504}
_IMAGE_DATA_URL_RE = re.compile(r"^data:image/(png|jpeg|webp);base64,[A-Za-z0-9+/=\r\n]+$")

logger = logging.getLogger(__name__)
_http_client: httpx.AsyncClient | None = None


class FormulaRecognitionError(RuntimeError):
    pass


class FormulaNotFoundError(FormulaRecognitionError):
    pass


class FormulaProviderUnavailableError(FormulaRecognitionError):
    pass


def validate_formula_image_data_url(value: Any) -> str:
    image = str(value or "")
    if not image or len(image) > MAX_FORMULA_IMAGE_CHARS:
        raise ValueError("formula image is missing or too large")
    if not _IMAGE_DATA_URL_RE.fullmatch(image):
        raise ValueError("formula image must be a PNG/JPEG/WEBP data URL")
    return image


def validate_free_formula_model(model: str) -> str:
    value = str(model or "").strip()
    if not value or value in LEGACY_FORMULA_MODELS:
        return DEFAULT_FORMULA_MODEL
    if not value.endswith(":free"):
        raise FormulaRecognitionError(
            "OPENROUTER_FORMULA_MODEL must be an explicit :free model"
        )
    return value


def formula_model_candidates(model: str) -> list[str]:
    primary = validate_free_formula_model(model)
    ordered = [primary, *FREE_FORMULA_FALLBACK_MODELS]
    result: list[str] = []
    for candidate in ordered:
        candidate = validate_free_formula_model(candidate)
        if candidate not in result:
            result.append(candidate)
    return result


async def recognize_formula(
    image_data_url: str,
    *,
    api_key: str,
    model: str = DEFAULT_FORMULA_MODEL,
) -> dict[str, Any]:
    image_data_url = validate_formula_image_data_url(image_data_url)
    if not api_key:
        raise FormulaRecognitionError("OPENROUTER_API_KEY is not configured")

    candidates = formula_model_candidates(model)
    started = time.perf_counter()
    active: dict[asyncio.Task, str] = {}
    launched: list[str] = []
    failures: list[str] = []
    saw_no_formula = False
    fallback_started = False
    loop = asyncio.get_running_loop()
    deadline = loop.time() + TOTAL_OCR_TIMEOUT_SECONDS
    hedge_at = loop.time() + FALLBACK_HEDGE_SECONDS

    def launch(candidate: str) -> None:
        task = asyncio.create_task(
            _recognize_with_model(image_data_url, api_key=api_key, model=candidate)
        )
        active[task] = candidate
        launched.append(candidate)

    launch(candidates[0])

    try:
        while active:
            now = loop.time()
            if now >= deadline:
                break

            next_wake = deadline
            if not fallback_started and len(candidates) > 1:
                next_wake = min(next_wake, hedge_at)

            done, _ = await asyncio.wait(
                active.keys(),
                timeout=max(0.0, next_wake - now),
                return_when=asyncio.FIRST_COMPLETED,
            )

            if not done:
                if not fallback_started and len(candidates) > 1:
                    launch(candidates[1])
                    fallback_started = True
                    logger.info("Formula OCR hedged to %s", candidates[1])
                continue

            for task in done:
                candidate = active.pop(task)
                try:
                    result = task.result()
                except FormulaNotFoundError:
                    saw_no_formula = True
                    failures.append(f"{candidate}: no formula")
                    if not fallback_started and len(candidates) > 1:
                        launch(candidates[1])
                        fallback_started = True
                    continue
                except FormulaProviderUnavailableError as exc:
                    failures.append(f"{candidate}: {exc}")
                    logger.warning("Formula OCR provider failed (%s): %s", candidate, exc)
                    if not fallback_started and len(candidates) > 1:
                        launch(candidates[1])
                        fallback_started = True
                    continue
                except FormulaRecognitionError as exc:
                    failures.append(f"{candidate}: {exc}")
                    logger.warning("Formula OCR rejected response (%s): %s", candidate, exc)
                    if not fallback_started and len(candidates) > 1:
                        launch(candidates[1])
                        fallback_started = True
                    continue
                except asyncio.CancelledError:
                    continue

                elapsed_ms = round((time.perf_counter() - started) * 1000)
                result["attempted_models"] = list(launched)
                result["elapsed_ms"] = elapsed_ms
                logger.info("Formula OCR succeeded via %s in %dms", candidate, elapsed_ms)
                return result

        if saw_no_formula:
            raise FormulaNotFoundError("В выделенной области не удалось найти формулу")

        compact = "; ".join(failures[-2:])
        raise FormulaProviderUnavailableError(
            "Бесплатные Qwen OCR-модели сейчас ограничены/недоступны"
            + (f": {compact}" if compact else "")
        )
    finally:
        pending = list(active.keys())
        for task in pending:
            task.cancel()
        if pending:
            await asyncio.gather(*pending, return_exceptions=True)


async def _recognize_with_model(
    image_data_url: str,
    *,
    api_key: str,
    model: str,
) -> dict[str, Any]:
    prompt = (
        "Mathematical OCR only. Transcribe EXACTLY the handwritten or printed "
        "mathematical expression visible in this crop into MathJax LaTeX. "
        "Do not solve, simplify, explain, classify safety, or add prose. Preserve "
        "coefficients, variables, exponents, subscripts, signs, brackets, fractions, "
        "roots, integrals, sums and relations exactly as drawn. Return ONLY the LaTeX "
        f"expression, without $ delimiters. If there is no formula, return {NO_FORMULA_TOKEN}."
    )

    payload = {
        "model": model,
        "messages": [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": prompt},
                    {"type": "image_url", "image_url": {"url": image_data_url}},
                ],
            }
        ],
        "max_tokens": MAX_OUTPUT_TOKENS,
        "temperature": 0,
        "provider": {
            "sort": "latency",
            "allow_fallbacks": True,
        },
    }
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
        "HTTP-Referer": "https://local-board.local",
        "X-Title": "Local Board Formula OCR",
    }

    try:
        client = _get_http_client()
        response = await client.post(
            OPENROUTER_CHAT_URL,
            headers=headers,
            json=payload,
            timeout=httpx.Timeout(PER_ATTEMPT_TIMEOUT_SECONDS, connect=1.5),
        )
    except (httpx.TimeoutException, httpx.NetworkError) as exc:
        raise FormulaProviderUnavailableError("timeout/network error") from exc
    except httpx.HTTPError as exc:
        raise FormulaProviderUnavailableError("OpenRouter is unreachable") from exc

    if response.status_code >= 400:
        detail = _openrouter_error_detail(response)
        if response.status_code in {401, 403}:
            raise FormulaRecognitionError(
                f"OpenRouter authentication error {response.status_code}: {detail}"
            )
        if response.status_code in TRANSIENT_HTTP_STATUSES:
            raise FormulaProviderUnavailableError(
                f"OpenRouter {response.status_code}: {detail}"
            )
        raise FormulaRecognitionError(
            f"OpenRouter error {response.status_code}: {detail}"
        )

    try:
        data = response.json()
        content = data["choices"][0]["message"]["content"]
    except (ValueError, KeyError, IndexError, TypeError) as exc:
        raise FormulaRecognitionError("invalid OpenRouter response") from exc

    latex = extract_latex(content)
    if is_no_formula_response(latex):
        raise FormulaNotFoundError("no formula")
    if not latex:
        raise FormulaRecognitionError("model returned an empty formula")
    if looks_like_non_formula_output(latex):
        raise FormulaRecognitionError("model returned non-formula text")
    if len(latex) > MAX_LATEX_CHARS:
        raise FormulaRecognitionError("recognized formula is too large")

    usage = data.get("usage") if isinstance(data, dict) else None
    actual_model = data.get("model") if isinstance(data, dict) else None
    return {
        "latex": latex,
        "model": model,
        "actual_model": str(actual_model) if actual_model else model,
        "usage": usage if isinstance(usage, dict) else None,
    }


def _get_http_client() -> httpx.AsyncClient:
    global _http_client
    if _http_client is None or _http_client.is_closed:
        _http_client = httpx.AsyncClient(
            timeout=httpx.Timeout(8.0, connect=2.0),
            limits=httpx.Limits(max_keepalive_connections=4, max_connections=8),
        )
    return _http_client


def extract_json_latex(content: Any) -> str:
    """Compatibility parser for older JSON-producing OCR responses."""
    if isinstance(content, list):
        parts = []
        for item in content:
            if isinstance(item, dict) and isinstance(item.get("text"), str):
                parts.append(item["text"])
        content = "".join(parts)
    text = str(content or "").strip()
    if text.startswith("```"):
        text = re.sub(r"^```(?:json)?\s*", "", text, flags=re.IGNORECASE)
        text = re.sub(r"\s*```$", "", text)
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError:
        return ""
    if not isinstance(parsed, dict):
        return ""
    return str(parsed.get("latex") or "").strip().strip("$").strip()


def extract_latex(content: Any) -> str:
    if isinstance(content, list):
        parts = []
        for item in content:
            if isinstance(item, dict) and isinstance(item.get("text"), str):
                parts.append(item["text"])
        content = "".join(parts)

    text = str(content or "").strip()
    if text.startswith("```"):
        text = re.sub(r"^```(?:latex|tex|json)?\s*", "", text, flags=re.IGNORECASE)
        text = re.sub(r"\s*```$", "", text)

    try:
        parsed = json.loads(text)
    except json.JSONDecodeError:
        parsed = None
    if isinstance(parsed, dict):
        text = str(parsed.get("latex") or "").strip()

    text = re.sub(r"^\s*latex\s*:\s*", "", text, flags=re.IGNORECASE)
    text = text.strip()
    for left, right in (("$$", "$$"), ("$", "$"), ("\\(", "\\)"), ("\\[", "\\]")):
        if text.startswith(left) and text.endswith(right) and len(text) >= len(left) + len(right):
            text = text[len(left):-len(right)].strip()
            break
    return text


def is_no_formula_response(value: Any) -> bool:
    text = str(value or "").strip().lower().replace(" ", "_")
    return text in {
        NO_FORMULA_TOKEN.lower(),
        "no_formula",
        "no_formula_found",
        "no_recognizable_formula",
    }


def looks_like_non_formula_output(value: Any) -> bool:
    text = str(value or "").strip().lower()
    forbidden = (
        "usersafety",
        "user safety",
        "safe",
        "unsafe",
        "policy",
        "category:",
        "assistant:",
        "reasoning:",
        "i cannot",
        "i can't",
        "the image",
        "this image",
    )
    if any(token in text for token in forbidden):
        return True
    if len(text.split()) >= 8 and not re.search(r"[=+\-*/^_\\<>]", text):
        return True
    return False


def _openrouter_error_detail(response: httpx.Response) -> str:
    try:
        payload = response.json()
        if isinstance(payload, dict):
            error = payload.get("error")
            if isinstance(error, dict) and error.get("message"):
                return str(error["message"])[:220]
            if error:
                return str(error)[:220]
    except ValueError:
        pass
    return (response.text or "request failed")[:220]
