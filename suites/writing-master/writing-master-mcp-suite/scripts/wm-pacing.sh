#!/usr/bin/env bash
# wm-pacing.sh — WritingMaster（详见: bash $(dirname $0)/wm-pacing.sh --help）
set -euo pipefail
exec node "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/wm.js" pacing "$@"
