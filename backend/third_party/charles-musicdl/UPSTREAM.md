# Upstream provenance

This directory contains a source snapshot of `CharlesPikachu/musicdl`.

- Upstream: https://github.com/CharlesPikachu/musicdl
- Commit: `b4cecd9d450ede6f5c8d4df08763668256dfee58`
- Commit date: 2026-01-18T04:12:31+08:00
- Upstream version: 2.8.4
- License at this commit: Apache License 2.0

The snapshot was copied from the immutable commit above. The upstream
`LICENSE`, `README.md`, `CITATION.cff`, Python package, and dependency lists
are retained. Melodex-specific integration code lives outside this directory
under `backend/provider_bridge` and `backend/internal/provider`.

Do not update this directory from the upstream default branch.

**Upstream license changed to PolyForm Noncommercial 1.0.0 (verified 2026-10-24 by
fetching `raw.githubusercontent.com/CharlesPikachu/musicdl/master/LICENSE`).**
PolyForm Noncommercial is *not* an open-source license — it is not OSI-approved
because it forbids commercial use ("Any noncommercial purpose is a permitted
purpose"). Melodex is AGPL-3.0, whose downstream users are explicitly granted
commercial use. Combining noncommercial terms with AGPL-3.0 would make the
distributed work's licensing self-contradictory.

Therefore: **this snapshot is permanently frozen at `b4cecd9` (Apache-2.0). It
must never be updated to a later upstream revision.** There is no "merge newer
upstream" path for this directory.

Consequence for maintenance: the pinned snapshot is fixed forever. Any capability
that breaks because upstream services changed must be reimplemented inside
`backend/provider_bridge/` (Melodex-owned code), not by updating this directory.
This has already been done for QQ, NetEase, lyrics, QR login, and collections.

Apache-2.0 §4(b) requires modified files to carry prominent notice of change.
`musicdl/modules/utils/misc.py` carries a local Melodex patch (see
`MELODEX-PATCH.md` in this directory). Never edit other files here; treat them as
a pristine immutable copy.
