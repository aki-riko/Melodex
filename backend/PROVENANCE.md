# Backend provenance

This document records the source boundary of the current Melodex backend tree.

## Melodex application code

The Go application under `cmd`, `core`, `internal/fileutil`, `internal/maintenance`,
`internal/provider`, and `internal/web` is maintained as Melodex code. It does
not import, vendor, or use a Go module replacement for either of the historical
`guohuiyuan/go-music-dl` or `guohuiyuan/music-lib` repositories.

The Python files under `provider_bridge` are the Melodex JSON adapter and
process boundary. They load only the pinned provider snapshot described below.

`MUSIC_DL_*` environment variables, the `/music` route prefix, and a small
number of public compatibility identifiers remain stable deployment/API names.
They do not indicate a runtime or source dependency on the historical Go
projects.

## Pinned third-party provider

Multi-source song search, media URL resolution, and lyric retrieval are supplied
by the source snapshot in `third_party/charles-musicdl`:

- Upstream: <https://github.com/CharlesPikachu/musicdl>
- Commit: `b4cecd9d450ede6f5c8d4df08763668256dfee58`
- Version: `2.8.4`
- License at the pinned commit: Apache License 2.0

The immutable revision, upstream date, retained files, and update policy are in
`third_party/charles-musicdl/UPSTREAM.md`. Its original license is retained at
`third_party/charles-musicdl/LICENSE`.

## Current-tree audit

On 2026-08-15, the current non-vendored Go production and test sources were
compared against these immutable audit references:

- `guohuiyuan/go-music-dl@9382c00a8401417d303a42336ddc5a8fbdf94842`
- `guohuiyuan/music-lib@59dd7753bbc8ddba6cb5c859ee93b4d98401e833`

The repeatable lexer-based audit is implemented in
`scripts/provenance_audit.go`. It excludes package/import declarations and
comments, then checks exact token windows, complete functions, and whole-file
hashes. The 2026-08-15 run reported:

- `production_40_token_windows=0`, `test_40_token_windows=0`
- `production_exact_functions=0`, `test_exact_functions=0`
- `exact_nonlicense_files=0`, `forbidden_imports=0`
- `charles_files_compared=65`, `charles_mismatches=0`

The audit also reports short five-line windows as an informational signal. The
same run found 122 production and 9 test five-line windows, but none reached the
40-token implementation threshold; these are isolated short field lists,
standard error responses, and test assertions rather than reusable implementation
blocks. In addition to the source comparison, the audit parses every non-vendor
Go import and fails on either historical module path; the reported
`forbidden_imports=0` is the direct import-graph check. The Go module graph and
repository text scan contain no dependency/import path for either historical
project.

This is a current-tree statement, not a Git-history rewrite. Earlier commits in
this repository still contain historical source. Removing those objects would
require a coordinated history rewrite and force push; that operation is outside
this migration and has not been performed.

## Project license

Melodex application code is distributed under the repository's AGPL-3.0 license.
The pinned CharlesPikachu provider snapshot remains under Apache-2.0. Other
frontend and client attributions remain in `frontend/THIRD-PARTY-LICENSES.md`.
