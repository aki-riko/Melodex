# coding: utf-8
# SPDX-License-Identifier: AGPL-3.0-only
"""LRC parsing shared by the main player and transparent lyrics window."""

from __future__ import annotations

import re

_TIMESTAMP = re.compile(r"\[(\d{1,2}):(\d{1,2})(?:[.:](\d{1,3}))?\]")


def _seconds(match: re.Match[str]) -> float:
    fraction = (match.group(3) or "").ljust(3, "0")
    milliseconds = int(fraction) if fraction else 0
    return int(match.group(1)) * 60 + int(match.group(2)) + milliseconds / 1000


def _line_segments(line: str) -> list[dict]:
    matches = list(_TIMESTAMP.finditer(line))
    segments: list[dict] = []
    for index, match in enumerate(matches):
        start = match.end()
        end = matches[index + 1].start() if index + 1 < len(matches) else len(line)
        segments.append({"t": _seconds(match), "s": line[start:end]})
    return segments


def _lyric_line(segments: list[dict]) -> dict | None:
    text = "".join(segment["s"] for segment in segments).rstrip()
    if not text.strip():
        return None
    words = [segment.copy() for segment in segments if segment["s"]]
    return {
        "t": segments[0]["t"],
        "text": text,
        "words": words if len(words) >= 2 else [],
    }


def _fill_end_times(lines: list[dict]) -> None:
    for line_index, lyric_line in enumerate(lines):
        line_end = (
            lines[line_index + 1]["t"]
            if line_index + 1 < len(lines)
            else lyric_line["t"] + 5
        )
        lyric_line["end"] = line_end
        words = lyric_line["words"]
        for word_index, word in enumerate(words):
            word["end"] = (
                words[word_index + 1]["t"]
                if word_index + 1 < len(words)
                else line_end
            )


def parse_lrc(raw: str) -> list[dict]:
    """Parse both line LRC and QQ-style word-timestamp LRC."""

    if not isinstance(raw, str) or not raw:
        return []
    output: list[dict] = []
    for line in raw.splitlines():
        segments = _line_segments(line)
        if not segments:
            continue
        if lyric_line := _lyric_line(segments):
            output.append(lyric_line)
    output.sort(key=lambda item: item["t"])
    _fill_end_times(output)
    return output


def current_lyric_index(lines: list[dict], position: float) -> int:
    """Return the last lyric line whose timestamp is not after position."""

    low = 0
    high = len(lines) - 1
    answer = -1
    while low <= high:
        middle = (low + high) // 2
        if lines[middle]["t"] <= position:
            answer = middle
            low = middle + 1
        else:
            high = middle - 1
    return answer
