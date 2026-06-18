#!/usr/bin/env bash
# Trading Review Wiki CLI wrapper for Hermes.
# Reads configuration from environment variables (see SKILL.md).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
if [[ -f "${SCRIPT_DIR}/env.sh" ]]; then
  # shellcheck source=/dev/null
  source "${SCRIPT_DIR}/env.sh"
fi
REPO="${TRADING_WIKI_REPO:-$(cd "${SKILL_DIR}/../.." && pwd)}"

PROVIDER="${TRADING_WIKI_PROVIDER:-openai}"
ENDPOINT="${OPENAI_API_BASE:-${OPENAI_BASE_URL:-https://api.deepseek.com}}"
MODEL="${OPENAI_MODEL:-deepseek-v4-flash}"
API_MODE="${OPENAI_API_MODE:-auto}"
REASONING="${TRADING_WIKI_REASONING_EFFORT:-low}"
PAGE_CONCURRENCY="${TRADING_WIKI_PAGE_CONCURRENCY:-3}"

require_project() {
  PROJECT="${TRADING_WIKI_PROJECT:?Set TRADING_WIKI_PROJECT to your wiki workspace root (contains wiki/ and raw/).}"
}

usage() {
  cat <<EOF
Usage: tw-cli.sh <command> [args...]

Commands:
  ask <query> [--sources wiki,raw,graph,facts]   Human-readable answer (Markdown)
  ask-json <query> [--sources ...]              Machine JSON (--show-sources)
  ask-context <query> [--sources ...]           Full retrieval JSON (--show-context)
  ingest <source.md>                            Stage raw material (api-run, dry-run)
  apply <manifest.json> [--write] [--skip-invalid]               Apply staged changes (--write to commit; --skip-invalid skips bad pages)
  finalize <report-dir>                         Resume failed housekeeping stage
  brain-remember <type> <text>                  Record correction/preference (type: correction|thread|preference|guardrail)
  brain-status                                  Show brain memory status (JSON)
  daily-loop <premarket|postclose|full> [--write]
  company-research <stock> [--deep] [--from YYYY-MM-DD] [--to YYYY-MM-DD]
  temporal-facts-audit [--write]
  hygiene-audit | hygiene-plan | hygiene-apply [--write]
  raw <codex-ingest-args...>                    Pass through to npm run codex:ingest --

Environment (expected already set):
  TRADING_WIKI_PROJECT, TRADING_WIKI_REPO (optional)
  DEEPSEEK_API_KEY or OPENAI_API_KEY
  OPENAI_API_BASE, OPENAI_MODEL, OPENAI_API_MODE (optional)
  TRADING_WIKI_REASONING_EFFORT (default: low), TRADING_WIKI_PAGE_CONCURRENCY (default: 3)
  PG_SHIHAO_* or PG_SHIHAO_CONFIG_PATH (optional, for stock-price / gangtise)

Repo:  ${REPO}
Project: \${TRADING_WIKI_PROJECT:-<not set>}
Provider: ${PROVIDER}
EOF
}

llm_args=()
if [[ "${PROVIDER}" == "openai" ]]; then
  llm_args=(--provider openai --endpoint "${ENDPOINT}" --model "${MODEL}" --api-mode "${API_MODE}" --reasoning-effort "${REASONING}")
elif [[ "${PROVIDER}" == "codex" ]]; then
  llm_args=(--provider codex)
  if [[ -n "${TRADING_WIKI_CODEX_MODEL:-${CODEX_MODEL:-}}" ]]; then
    llm_args+=(--model "${TRADING_WIKI_CODEX_MODEL:-${CODEX_MODEL}}")
  fi
else
  echo "Unsupported TRADING_WIKI_PROVIDER: ${PROVIDER}" >&2
  exit 1
fi

run_ingest() {
  (cd "${REPO}" && npm run codex:ingest -- "$@")
}

cmd="${1:-help}"
shift || true

case "${cmd}" in
  help|-h|--help)
    usage
    ;;
  ask)
    require_project
    query="${1:?Usage: tw-cli.sh ask \"your question\"}"
    shift
    run_ingest ask --project "${PROJECT}" "${llm_args[@]}" --query "${query}" "$@"
    ;;
  ask-json)
    require_project
    query="${1:?Usage: tw-cli.sh ask-json \"your question\"}"
    shift
    run_ingest ask --project "${PROJECT}" "${llm_args[@]}" --query "${query}" --show-sources "$@"
    ;;
  ask-context)
    require_project
    query="${1:?Usage: tw-cli.sh ask-context \"your question\"}"
    shift
    run_ingest ask --project "${PROJECT}" "${llm_args[@]}" --query "${query}" --show-context "$@"
    ;;
  ingest)
    require_project
    source="${1:?Usage: tw-cli.sh ingest /path/to/raw/file.md}"
    shift
    run_ingest api-run --source "${source}" --project "${PROJECT}" "${llm_args[@]}" --page-concurrency "${PAGE_CONCURRENCY}" "$@"
    ;;
  apply)
    require_project
    manifest="${1:?Usage: tw-cli.sh apply /path/to/changes.json [--write]}"
    shift
    run_ingest apply --manifest "${manifest}" --project "${PROJECT}" "$@"
    ;;
  finalize)
    require_project
    report="${1:?Usage: tw-cli.sh finalize /path/to/.llm-wiki/codex-ingest/<run-id>}"
    shift
    run_ingest finalize --report "${report}" --project "${PROJECT}" "${llm_args[@]}" "$@"
    ;;
  brain-remember)
    require_project
    type="${1:?Usage: tw-cli.sh brain-remember correction \"text\"}"
    text="${2:?Missing text}"
    shift 2
    run_ingest brain remember --type "${type}" --text "${text}" --project "${PROJECT}" "$@"
    ;;
  brain-status)
    require_project
    run_ingest brain status --project "${PROJECT}" "$@"
    ;;
  daily-loop)
    require_project
    mode="${1:?Usage: tw-cli.sh daily-loop premarket|postclose|full [--write]}"
    shift
    run_ingest daily-loop --mode "${mode}" --project "${PROJECT}" "${llm_args[@]}" "$@"
    ;;
  company-research)
    require_project
    stock="${1:?Usage: tw-cli.sh company-research \"600519\" [--deep]}"
    shift
    run_ingest company-research --stock "${stock}" --project "${PROJECT}" "$@"
    ;;
  temporal-facts-audit)
    require_project
    run_ingest temporal-facts audit --project "${PROJECT}" "$@"
    ;;
  hygiene-audit)
    require_project
    run_ingest hygiene audit --project "${PROJECT}" "$@"
    ;;
  hygiene-plan)
    require_project
    run_ingest hygiene plan --project "${PROJECT}" "$@"
    ;;
  hygiene-apply)
    require_project
    run_ingest hygiene apply --project "${PROJECT}" "$@"
    ;;
  raw)
    require_project
    run_ingest "$@"
    ;;
  *)
    echo "Unknown command: ${cmd}" >&2
    usage >&2
    exit 1
    ;;
esac
