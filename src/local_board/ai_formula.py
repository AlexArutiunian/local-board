from __future__ import annotations

import json
import logging
import re
from typing import Any

import httpx

OPENROUTER_CHAT_URL = "https://openrouter.ai/api/v1/chat/completions"

# Primary route is deliberately the fastest free multimodal model we currently
# use. Free endpoints can be flaky, so every request may fail over to other
# explicitly-free vision routes. Never silently send a paid request.
DEFAULT_FORMULA_MODEL = "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free"
FREE_FORMULA_FALLBACK_MODELS = (
    "dots-studio/dots-3-note-preview:free",
    "openrouter/free",
)
LEGACY_PAID_FORMULA_MODELS = {"stealth/ox-alpha"}
ALLOWED_FREE_ROUTERS = {"openrouter/free"}

MAX_FORMULA_IMAGE_CHARS = 3_500_000
MAX_LATEX_CHARS = 4096
MAX_OUTPUT_TOKENS = 160
NO_FORMULA_TOKEN = "__NO_FORMULA__"
PER_ATTEMPT_TIMEOUT_SECONDS = 3.5
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
    if not value:
        return DEFAULT_FORMULA_MODEL
    # We previously documented ox-alpha in .env. Treat that exact legacy value
    # as a migration signal and replace it locally; never send a paid request.
    if value in LEGACY_PAID_FORMULA_MODELS:
        return DEFAULT_FORMULA_MODEL
    if value in ALLOWED_FREE_ROUTERS:
        return value
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
    failures: list[str] = []
    saw_no_formula = False

    for index, candidate in enumerate(candidates):
        try:
            result = await _recognize_with_model(
                image_data_url,
                api_key=api_key,
                model=candidate,
            )
        except FormulaNotFoundError as exc:
            saw_no_formula = True
            failures.append(f"{candidate}: no formula")
            logger.info("Formula OCR found no formula with %s", candidate)
            continue
        except FormulaProviderUnavailableError as exc:
            failures.append(f"{candidate}: {exc}")
            logger.warning("Formula OCR provider failed (%s): %s", candidate, exc)
            continue
        except FormulaRecognitionError as exc:
            # A model-specific malformed response/unsupported parameter should
            # not take the board down if another free vision model can answer.
            failures.append(f"{candidate}: {exc}")
            logger.warning("Formula OCR model failed (%s): %s", candidate, exc)
            continue

        result["fallback_index"] = index
        result["attempted_models"] = candidates[: index + 1]
        if index:
            logger.info("Formula OCR succeeded via free fallback %s", candidate)
        return result

    if saw_no_formula:
        raise FormulaNotFoundError("В выделенной области не удалось найти формулу")

    compact = "; ".join(failures[-3:])
    raise FormulaProviderUnavailableError(
        "Бесплатные OCR-модели временно недоступны"
        + (f": {compact}" if compact else "")
    )


async def _recognize_with_model(
    image_data_url: str,
    *,
    api_key: str,
    model: str,
) -> dict[str, Any]:
    prompt = (
        "Fast mathematical OCR only. Read the handwritten or printed mathematical "
        "expression in this crop and return ONLY valid MathJax LaTeX. Do not solve, "
        "simplify, explain, or add markdown/dollar signs. Preserve symbols, powers, "
        "subscripts, fractions, roots, integrals, sums, brackets and relations exactly. "
        "A graph may contain a formula label; transcribe the label if clearly present. "
        f"If there is no recognizable mathematical expression, return exactly {NO_FORMULA_TOKEN}."
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
            timeout=httpx.Timeout(PER_ATTEMPT_TIMEOUT_SECONDS, connect=2.0),
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
        raise FormulaRecognitionError("empty model response")
    if len(latex) > MAX_LATEX_CHARS:
        raise FormulaRecognitionError("recognized formula is too large")

    usage = data.get("usage") if isinstance(data, dict) else None
    return {
        "latex": latex,
        "model": model,
        "usage": usage if isinstance(usage, dict) else None,
    }


def _get_http_client() -> httpx.AsyncClient:
    global _http_client
    if _http_client is None or _http_client.is_closed:
        _http_client = httpx.AsyncClient(
            timeout=httpx.Timeout(12.0, connect=4.0),
            limits=httpx.Limits(max_keepalive_connections=4, max_connections=8),
        )
    return _http_client


def extract_latex(content: Any) -> str:
    if isinstance(content, list):
        text_parts = []
        for item in content:
            if isinstance(item, dict) and isinstance(item.get("text"), str):
                text_parts.append(item["text"])
        content = "".join(text_parts)
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
    text = text.strip().strip("$").strip()
    return text


def is_no_formula_response(value: Any) -> bool:
    text = str(value or "").strip().lower().replace(" ", "_")
    return text in {
        NO_FORMULA_TOKEN.lower(),
        "no_formula",
        "no_formula_found",
        "no_recognizable_formula",
    }


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
