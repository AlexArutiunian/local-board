from __future__ import annotations

import json
import logging
import re
import time
from typing import Any

import httpx

OPENROUTER_CHAT_URL = "https://openrouter.ai/api/v1/chat/completions"

# Ox Alpha is currently free on OpenRouter, accepts image input and has a single
# highly-available provider. Keep formula OCR deterministic: one known model,
# never a random free router that can return unrelated/safety output.
DEFAULT_FORMULA_MODEL = "stealth/ox-alpha"

# Old values from previous experiments are intentionally migrated back to Ox.
# This keeps existing local .env files working after git pull.
LEGACY_FORMULA_MODELS = {
    "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free",
    "nvidia/nemotron-nano-12b-v2-vl:free",
    "dots-studio/dots-3-note-preview:free",
    "openrouter/free",
    "google/gemma-4-31b-it-20260402:free",
    "google/gemma-4-31b-it:free",
    "google/gemma-4-26b-a4b-it:free",
    "qwen/qwen2.5-vl-32b-instruct:free",
    "qwen/qwen2.5-vl-72b-instruct:free",
}

MAX_FORMULA_IMAGE_CHARS = 2_000_000
MAX_LATEX_CHARS = 2048
# A short formula needs very few visible tokens, but do not use an extremely
# tiny cap on a reasoning model: some providers account hidden reasoning against
# completion limits differently. Latency is controlled with minimal reasoning.
MAX_OUTPUT_TOKENS = 256
NO_FORMULA_TOKEN = "__NO_FORMULA__"

# OpenRouter currently reports Ox Alpha around 6.8s P50 latency. A 9s client
# timeout was therefore cutting off healthy slow-tail requests and surfacing
# them as fake 503s. Keep a generous transport timeout; UI timing still exposes
# the real latency so we can evaluate the model honestly.
REQUEST_TIMEOUT_SECONDS = 22.0
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
    # Ox Alpha is free even though its slug does not end in :free.
    if value == DEFAULT_FORMULA_MODEL:
        return value
    # Keep custom overrides financially fail-closed.
    if value.endswith(":free"):
        return value
    raise FormulaRecognitionError(
        "OPENROUTER_FORMULA_MODEL must be stealth/ox-alpha or an explicit :free model"
    )


def formula_model_candidates(model: str) -> list[str]:
    return [validate_free_formula_model(model)]


async def recognize_formula(
    image_data_url: str,
    *,
    api_key: str,
    model: str = DEFAULT_FORMULA_MODEL,
) -> dict[str, Any]:
    image_data_url = validate_formula_image_data_url(image_data_url)
    model = validate_free_formula_model(model)
    if not api_key:
        raise FormulaRecognitionError("OPENROUTER_API_KEY is not configured")

    started = time.perf_counter()
    try:
        result = await _recognize_with_model(image_data_url, api_key=api_key, model=model)
    except Exception:
        elapsed_ms = round((time.perf_counter() - started) * 1000)
        logger.exception("Formula OCR failed via %s after %dms", model, elapsed_ms)
        raise
    result["attempted_models"] = [model]
    result["elapsed_ms"] = round((time.perf_counter() - started) * 1000)
    logger.info("Formula OCR succeeded via %s in %dms", model, result["elapsed_ms"])
    return result


async def _recognize_with_model(
    image_data_url: str,
    *,
    api_key: str,
    model: str,
) -> dict[str, Any]:
    prompt = (
        "OCR the handwritten math in this crop. Return ONLY the exact MathJax LaTeX, "
        "no explanation, no solving, no markdown, no $ delimiters. Preserve every "
        "symbol exactly. If no formula is visible return __NO_FORMULA__."
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
        # OCR is transcription, not a reasoning task. Use the smallest supported
        # reasoning effort. If a provider normalizes this value, OpenRouter still
        # keeps the request valid; excluding reasoning keeps only useful text.
        "reasoning": {"effort": "minimal", "exclude": True},
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

    request_started = time.perf_counter()
    try:
        client = _get_http_client()
        response = await client.post(
            OPENROUTER_CHAT_URL,
            headers=headers,
            json=payload,
            timeout=httpx.Timeout(REQUEST_TIMEOUT_SECONDS, connect=2.0),
        )
    except httpx.TimeoutException as exc:
        elapsed = round((time.perf_counter() - request_started) * 1000)
        logger.warning("Ox Alpha HTTP timeout after %dms", elapsed)
        raise FormulaProviderUnavailableError(
            f"Ox Alpha did not answer within {REQUEST_TIMEOUT_SECONDS:.0f}s"
        ) from exc
    except httpx.NetworkError as exc:
        elapsed = round((time.perf_counter() - request_started) * 1000)
        logger.warning("Ox Alpha network error after %dms: %s", elapsed, exc)
        raise FormulaProviderUnavailableError("Ox Alpha network error") from exc
    except httpx.HTTPError as exc:
        elapsed = round((time.perf_counter() - request_started) * 1000)
        logger.warning("OpenRouter HTTP error after %dms: %s", elapsed, exc)
        raise FormulaProviderUnavailableError("OpenRouter is unreachable") from exc

    elapsed = round((time.perf_counter() - request_started) * 1000)
    if response.status_code >= 400:
        detail = _openrouter_error_detail(response)
        logger.warning(
            "Ox Alpha HTTP %d after %dms: %s",
            response.status_code,
            elapsed,
            detail,
        )
        if response.status_code in {401, 403}:
            raise FormulaRecognitionError(
                f"OpenRouter authentication error {response.status_code}: {detail}"
            )
        if response.status_code in TRANSIENT_HTTP_STATUSES:
            raise FormulaProviderUnavailableError(
                f"Ox Alpha temporarily unavailable ({response.status_code}): {detail}"
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
        raise FormulaNotFoundError("В выделенной области не удалось найти формулу")
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
            timeout=httpx.Timeout(REQUEST_TIMEOUT_SECONDS, connect=2.0),
            limits=httpx.Limits(max_keepalive_connections=4, max_connections=8),
            http2=False,
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
