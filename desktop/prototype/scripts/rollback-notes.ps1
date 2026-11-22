# Roll back the melodex container to a previously tagged image.
# Read-only until the final "up -d"; run this only if the new deploy misbehaves.
#
# Usage on the NAS (bare commands, paste directly):
#   cd /mnt/cache/appdata/melodex-src
#   docker tag melodex:rollback-1e12ac0 melodex:latest
#   docker compose up -d --no-build --no-deps melodex
#   docker exec melodex wget -qO- http://127.0.0.1:8329/api/v1/healthz
#
# This file is documentation only; it is not executed by the agent.
Write-Output 'See header comments for the rollback commands.'
