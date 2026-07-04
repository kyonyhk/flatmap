#!/bin/bash
set -e
cd /Users/kuoloonchong/Desktop/sg-property
for round in 1 2 3; do
  echo "=== round $round: streets-only geocode ==="
  STREETS_ONLY=1 bun scripts/03-geocode.ts
  echo "=== round $round: propagate ==="
  bun scripts/03b-propagate.ts
done
echo "=== final: full geocode of leftovers ==="
bun scripts/03-geocode.ts
bun scripts/03b-propagate.ts
echo "ORCHESTRATION DONE"
