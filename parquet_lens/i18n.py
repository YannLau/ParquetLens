"""Share the browser's message catalog with API error responses."""

from __future__ import annotations

import json
from pathlib import Path

ENGLISH = json.loads(
    (Path(__file__).parent / "static/locales/en.json").read_text(encoding="utf-8")
)


def language_from_header(header: str) -> str:
    candidates = []
    for index, part in enumerate(header.split(",")):
        tag, *parameters = part.strip().split(";")
        quality = 1.0
        for parameter in parameters:
            if parameter.strip().startswith("q="):
                try:
                    quality = float(parameter.strip()[2:])
                except ValueError:
                    quality = 0
        language = tag.lower().split("-")[0]
        if language in ("en", "zh") and 0 < quality <= 1:
            candidates.append((-quality, index, language))
    return min(candidates)[2] if candidates else "zh"


def translate(message: str, accept_language: str = "") -> str:
    return (
        ENGLISH.get(message, message)
        if language_from_header(accept_language) == "en"
        else message
    )
