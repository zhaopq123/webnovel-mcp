#!/usr/bin/env bash
# wm-review.sh — WritingMaster（详见: bash $(dirname $0)/wm-review.sh --help）
set -euo pipefail
exec node "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/wm.js" review "$@"
