# coding: utf-8
# SPDX-License-Identifier: AGPL-3.0-only
"""Durable per-account playback state for the desktop client."""

from __future__ import annotations

import hashlib
import json
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


class PlaybackStateStore:
    """Persist playback snapshots without mixing servers or user accounts."""

    VERSION = 1

    def __init__(self, path: Path) -> None:
        self._path = path

    @staticmethod
    def _identity_key(service_url: str, user_id: str) -> str:
        identity = f"{service_url.strip()}\0{str(user_id).strip()}"
        return hashlib.sha256(identity.encode("utf-8")).hexdigest()

    def load(self, service_url: str, user_id: str) -> dict[str, Any] | None:
        """Load one account snapshot, ignoring malformed or mismatched entries."""

        document = self._read_document()
        identity_key = self._identity_key(service_url, user_id)
        entry = document["accounts"].get(identity_key)
        if not isinstance(entry, dict):
            return None
        if (
            entry.get("service_url") != service_url
            or str(entry.get("user_id", "")) != str(user_id)
            or not isinstance(entry.get("state"), dict)
        ):
            print(f"[WARN] 忽略身份不匹配的播放状态：{identity_key}")
            return None
        return dict(entry["state"])

    def save(
        self, service_url: str, user_id: str, state: dict[str, Any]
    ) -> None:
        """Atomically replace one account snapshot while preserving the others."""

        serializable_state = json.loads(
            json.dumps(state, ensure_ascii=False, separators=(",", ":"))
        )
        document = self._read_document()
        identity_key = self._identity_key(service_url, user_id)
        document["accounts"][identity_key] = {
            "service_url": service_url,
            "user_id": str(user_id),
            "updated_at": datetime.now(timezone.utc).isoformat(),
            "state": serializable_state,
        }
        self._write_document(document)

    def _read_document(self) -> dict[str, Any]:
        empty = {"version": self.VERSION, "accounts": {}}
        if not self._path.exists():
            return empty
        try:
            payload = json.loads(self._path.read_text(encoding="utf-8"))
        except (OSError, ValueError) as exc:
            print(f"[WARN] 读取桌面播放状态失败，将忽略损坏数据：{exc}")
            return empty
        if (
            not isinstance(payload, dict)
            or payload.get("version") != self.VERSION
            or not isinstance(payload.get("accounts"), dict)
        ):
            print("[WARN] 桌面播放状态格式无效，将忽略旧数据")
            return empty
        return payload

    def _write_document(self, document: dict[str, Any]) -> None:
        self._path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self._path.with_suffix(f"{self._path.suffix}.tmp")
        temporary.write_text(
            json.dumps(document, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        os.replace(temporary, self._path)
        if os.name != "nt":
            os.chmod(self._path, 0o600)
