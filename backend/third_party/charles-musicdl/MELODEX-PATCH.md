# Local patches to the pinned musicdl snapshot

The pinned snapshot in this directory is **frozen at commit `b4cecd9` (Apache-2.0)**
and must never be updated — see `UPSTREAM.md` for why (upstream relicensed to
PolyForm Noncommercial 1.0.0, incompatible with this project's AGPL-3.0).

Because the directory can never be re-synced, every local edit here is permanent
and must be listed in this file. Apache License 2.0 §4(b) also requires each
modified file to carry a prominent notice that it was changed.

**Keep this list as short as possible.** New capability work belongs in
`backend/provider_bridge/` (Melodex-owned), not here.

| File | Commit | Purpose |
| --- | --- | --- |
| `musicdl/modules/utils/misc.py` | `dbc231a` (2026-09-17) | `AudioLinkTester` HEAD/GET probes use `with` context managers instead of explicit `resp.close()`, so background search refresh releases probe responses deterministically. No change to request parameters, classification, or return shapes. |

Audit the pinned tree against upstream `b4cecd9` at any time with:

```bash
git diff b4cecd9-import-commit -- backend/third_party/charles-musicdl
# or, with a fresh upstream checkout:
diff -r <musicdl@b4cecd9> backend/third_party/charles-musicdl
```

The repeatable provenance audit is `backend/scripts/provenance_audit.go`.
