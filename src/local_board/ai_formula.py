from __future__ import annotations

import json
import re
from typing import Any

import httpx

OPENROUTER_CHAT_URL = "https://openrouter.ai/api/v1/chat/completions"
# Fast, vision-capable OpenRouter endpoint whose model slug itself is explicitly
# free. Never silently route formula OCR to a paid model.
DEFAULT_FORMULA_MODEL = "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free"
MAX_FORMULA_IMAGE_CHARS = 3_500_000
MAX_LATEX_CHARS = 4096
MAX_OUTPUT_TOKENS = 192
_IMAGE_DATA_URL_RE = re.compile(r"^data:image/(png|jpeg|webp);base64,[A-Za-z0-9+/=\r\n]+$")

# Reuse connections between OCR requests. Creating a fresh TLS connection for
# every tiny formula is noticeable in an interactive whiteboard.
_http_client: httpx.AsyncClient | None = None


class FormulaRecognitionError(RuntimeError):
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
    # Keep this feature financially fail-closed. An explicit :free model is the
    # only accepted override; a typo can never fall through to a paid endpoint.
    if not value.endswith(":free"):
        raise FormulaRecognitionError(
            "OPENROUTER_FORMULA_MODEL must be an explicit :free model"
        )
    return value


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

    # Keep the prompt and expected output deliberately tiny. Formula OCR does
    # not need chain-of-thought; fewer output tokens materially improve latency.
    prompt = (
        "OCR only. Read the handwritten/printed mathematical expression in this crop. "
        "Return ONLY valid MathJax LaTeX, with no dollar signs, code fence, JSON, "
        "explanation, solution, or commentary. Preserve symbols, superscripts, "
        "subscripts, fractions, roots, integrals, sums, brackets and relations exactly."
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
        # The selected free Nemotron can use extended reasoning when explicitly
        # requested. Formula OCR is a latency-sensitive perception task, so keep
        # it off. OpenRouter ignores unsupported optional reasoning controls.
        "reasoning": {"enabled": False},
        "provider": {
            "sort": "latency",
            "allow_fallbacks": False,
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
        response = await client.post(OPENROUTER_CHAT_URL, headers=headers, json=payload)
    except httpx.HTTPError as exc:
        raise FormulaRecognitionError("OpenRouter is unreachable") from exc

    if response.status_code >= 400:
        detail = _openrouter_error_detail(response)
        raise FormulaRecognitionError(f"OpenRouter error {response.status_code}: {detail}")

    try:
        data = response.json()
        content = data["choices"][0]["message"]["content"]
    except (ValueError, KeyError, IndexError, TypeError) as exc:
        raise FormulaRecognitionError("OpenRouter returned an invalid response") from exc

    latex = extract_latex(content)
    if not latex:
        raise FormulaRecognitionError("model returned an empty formula")
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
    # Keep compatibility with an older JSON-producing OCR configuration.
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError:
        parsed = None
    if isinstance(parsed, dict):
        text = str(parsed.get("latex") or "").strip()
    text = text.strip().strip("$").strip()
    return text


def _openrouter_error_detail(response: httpx.Response) -> str:
    try:
        payload = response.json()
        if isinstance(payload, dict):
            error = payload.get("error")
            if isinstance(error, dict) and error.get("message"):
                return str(error["message"])[:300]
            if error:
                return str(error)[:300]
    except ValueError:
        pass
    return (response.text or "request failed")[:300]
