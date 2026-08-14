# Provider extensions provenance

The primary search, media URL, lyric, and source-specific request handling in
Melodex is provided by the pinned Apache-2.0 `CharlesPikachu/musicdl` snapshot
documented in `backend/third_party/charles-musicdl/UPSTREAM.md`.

This directory contains Melodex-owned Go extensions for application features
that the pinned upstream does not expose, such as playlist and album browsing,
category lists, user playlists, and QR login. These files use Melodex's stable
provider models and do not import the legacy provider module being removed.

The Kugou, Kuwo, and Migu playlist/album implementations were written against
public platform HTTP responses verified on 2026-08-15. Their mapping tests use
local fixtures, while opt-in live tests are enabled with
`MELODEX_LIVE_EXTENSIONS=1`.

Do not copy provider code into this directory without recording its immutable
upstream revision and license. Independently implemented platform adapters
should document the observed API surface and include both mapping and opt-in
live-flow tests.
