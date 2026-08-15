"""Collection and album operations exposed by the Charles provider sidecar."""

from __future__ import annotations

from typing import Any

from provider_bridge.platforms.kugou import KugouCollections
from provider_bridge.platforms.kuwo import KuwoCollections
from provider_bridge.platforms.migu import MiguCollections
from provider_bridge.platforms.netease import NeteaseCollections
from provider_bridge.platforms.qq import QQCollections


COLLECTION_CLIENTS = {
    "netease": NeteaseCollections,
    "qq": QQCollections,
    "kugou": KugouCollections,
    "kuwo": KuwoCollections,
    "migu": MiguCollections,
}


def collection(payload: dict[str, Any], *, session=None) -> dict[str, Any]:
    source = str(payload.get("source") or "").strip().lower()
    action = str(payload.get("action") or "").strip().lower()
    if source not in COLLECTION_CLIENTS:
        raise ValueError(f"unsupported collection source: {source}")
    if not action:
        raise ValueError("collection action is required")
    client = COLLECTION_CLIENTS[source](str(payload.get("cookie") or ""), session=session)
    if action in {"search_album", "search_playlist"}:
        items = getattr(client, action)(str(payload.get("keyword") or ""))
        return {"collections": items}
    if action in {"album", "playlist", "parse_album", "parse_playlist"}:
        if action == "album":
            item, songs = client.album(str(payload.get("id") or ""))
        elif action == "playlist":
            item, songs = client.playlist(str(payload.get("id") or ""))
        elif action == "parse_album":
            item, songs = client.parse_album(str(payload.get("link") or ""))
        else:
            item, songs = client.parse_playlist(str(payload.get("link") or ""))
        return {"collection": item, "songs": songs}
    if action == "recommend":
        return {"collections": client.recommend()}
    if action == "categories":
        return {"categories": client.categories()}
    if action == "category":
        return {"collections": client.category(payload.get("category_id"), payload.get("page"), payload.get("limit"))}
    if action == "user_playlists":
        return {"collections": client.user_playlists(page=payload.get("page"), limit=payload.get("limit"))}
    raise ValueError(f"unsupported collection action: {action}")
