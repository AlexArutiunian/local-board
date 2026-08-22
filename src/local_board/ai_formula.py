from __future__ import annotations

import json
import re
from typing import Any

import httpx

OPENROUTER_CHAT_URL = "https://openrouter.ai/api/v1/chat/completions"
DEFAULT_FORMULA_MODEL = "stealth/ox-alpha"
MAX_FORMULA_IMAGE_CHARS = 6_000_000
MAX_LATEX_CHARS = 4096
_IMAGE_DATA_URL_RE = re.compile(r"^data:image/(png|jpeg|webp);base64,[A-Za-z0-9+/=\r\n]+$")


class FormulaRecognitionError(RuntimeError):
    pass


def validate_formula_image_data_url(value: Any) -> str:
    image = str(value or "")
    if not image or len(image) > MAX_FORMULA_IMAGE_CHARS:
        raise ValueError("formula image is missing or too large")
    if not _IMAGE_DATA_URL_RE.fullmatch(image):
        raise ValueError("formula image must be a PNG/JPEG/WEBP data URL")
    return image


async def recognize_formula(
    image_data_url: str,
    *,
    api_key: str,
    model: str = DEFAULT_FORMULA_MODEL,
) -> dict[str, Any]:
    image_data_url = validate_formula_image_data_url(image_data_url)
    if not api_key:
        raise FormulaRecognitionError("OPENROUTER_API_KEY is not configured")

    prompt = (
        "You are a precise mathematical OCR engine. Read the mathematical expression(s) "
        "inside the supplied crop and convert them to valid MathJax-compatible LaTeX. "
        "Preserve variables, Greek letters, subscripts, superscripts, fractions, roots, "
        "integrals, sums, limits, brackets, matrices and relations exactly as written. "
        "Do not solve, simplify, explain, add commentary, or invent missing content. "
        "Ignore drawing-selection borders and graph axes unless they are semantically part "
        "of the expression. Return JSON only, with exactly one string field named latex. "
        "Do not wrap the LaTeX in dollar signs or code fences."
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
        "reasoning_effort": "low",
        "max_tokens": 512,
        "temperature": 0,
        "response_format": {"type": "json_object"},
    }
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
        "HTTP-Referer": "https://local-board.local",
        "X-Title": "Local Board Formula OCR",
    }

    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(55.0, connect=10.0)) as client:
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


def extract_latex(content: Any) -> str:
    if isinstance(content, list):
        text_parts = []
        for item in content:
            if isinstance(item, dict) and isinstance(item.get("text"), str):
                text_parts.append(item["text"])
        content = "".join(text_parts)
    text = str(content or "").strip()
    if text.startswith("```"):
        text = re.sub(r"^```(?:json)?\s*", "", text, flags=re.IGNORECASE)
        text = re.sub(r"\s*```$", "", text)
    try:
        payload = json.loads(text)
    except json.JSONDecodeError:
        payload = None
    if isinstance(payload, dict):
        text = str(payload.get("latex") or "").strip()
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
