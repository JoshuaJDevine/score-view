#!/usr/bin/env bash
# Runs the unit and end-to-end suites (each e2e on its own port).
#   bash test/run-all.sh [-j N] [all|unit|e2e|smoke] [suite ...]
#     tier      all (default) | unit | e2e | smoke     (npm test / test:unit / test:e2e / test:smoke)
#     -j N      run up to N suites at once (default 1, or env JOBS). Unit suites run first, then the e2e suites, so a
#               unit and an e2e suite never write the same fixture file at once. Results print in the same order
#               whatever N is.
#     suite     only run these suites (names as printed, e.g. notation-e2e theme-e2e)
#   npm passes extra arguments after --:  npm test -- -j 3
# smoke = the fast tier (~25 s): render, a few quick unit suites, the request guard and the page smoke test.
# Ports: an e2e suite gets PORT_BASE + 100*slot + i (slot = the parallel worker running it, 0-based; i = its position
# among the tier's e2e suites, 1-based), so concurrent suites never share a port; a suite may also use PORT+1 .. PORT+50.
# PORT_BASE defaults to 8900; give each concurrent copy of this script its own PORT_BASE (and keep clear of 8765).
cd "$(dirname "$0")/.."
usage() { echo "usage: bash test/run-all.sh [-j N] [all|unit|e2e|smoke] [suite ...]"; }
tier=all; nj=${JOBS:-1}; only=()
while [ $# -gt 0 ]; do
  case $1 in
    -j) nj=$2; shift; [ $# -gt 0 ] && shift;;
    -j*) nj=${1#-j}; shift;;
    all|unit|e2e|smoke) tier=$1; shift;;
    -h|--help) usage; exit 0;;
    -*) usage >&2; exit 2;;
    *) only+=("$1"); shift;;
  esac
done
case $nj in ''|*[!0-9]*|0) echo "run-all: -j needs a whole number >= 1" >&2; exit 2;; esac
port_base=${PORT_BASE:-8900}

# ---- the suite list: name, command and, for an e2e suite, its port index
names=(); cmds=(); pidx=(); unit_ids=(); e2e_ids=(); n_e2e=0
wanted() { [ ${#only[@]} -eq 0 ] && return 0; local o; for o in "${only[@]}"; do [ "$o" = "$1" ] && return 0; done; return 1; }
unit() { # name, command
  wanted "$1" || return 0
  names+=("$1"); cmds+=("$2"); pidx+=(""); unit_ids+=($(( ${#names[@]} - 1 )))
}
e2e() { # name, command. The port index counts every e2e suite of the tier, filtered or not, so a suite's port is fixed.
  n_e2e=$((n_e2e+1))
  wanted "$1" || return 0
  names+=("$1"); cmds+=("$2"); pidx+=("$n_e2e"); e2e_ids+=($(( ${#names[@]} - 1 )))
}
if [ "$tier" = smoke ]; then
  unit render "node test/render-test.mjs"
  for t in engine-fixes motifs orchestrate instruments sections security; do unit "$t-test" "node test/$t-test.mjs"; done
  e2e e2e-smoke "node test/e2e-smoke.mjs"
else
  if [ "$tier" != e2e ]; then
    unit render "node test/render-test.mjs"
    for t in test/*-test.mjs; do
      case $t in test/render-test.mjs|test/dawproject-test.mjs) continue;; esac
      unit "$(basename "$t" .mjs)" "node $t"
    done
  fi
  if [ "$tier" != unit ]; then
    for t in test/e2e-*.mjs test/*-e2e.mjs; do e2e "$(basename "$t" .mjs)" "node $t"; done
  fi
fi
for o in "${only[@]}"; do # a mistyped name is an error, not a silently smaller run
  found=; for n in "${names[@]}"; do [ "$n" = "$o" ] && found=1; done
  [ -n "$found" ] || { echo "run-all: no suite named $o in tier $tier" >&2; exit 2; }
done
if [ ${#names[@]} -eq 0 ]; then echo "run-all: no suites in tier $tier" >&2; exit 2; fi

# ---- running: up to $nj workers claim suites in list order (mkdir is atomic); each suite's output goes to <id>.out,
# then <id>.rc = "status milliseconds". The main loop prints results in list order as they arrive.
tmp=$(mktemp -d)
trap 'kill $(jobs -p) 2>/dev/null; rm -rf "$tmp"' EXIT
trap 'exit 130' INT TERM
now_ms() { if [ -n "$EPOCHREALTIME" ]; then local t=${EPOCHREALTIME/[.,]/}; echo $((10#$t / 1000)); else echo $(( $(date +%s) * 1000 )); fi; }
secs() { echo "$(($1 / 1000)).$(( ($1 % 1000) / 100 ))s"; }
worker() { # slot, ids...
  local slot=$1 i t0 rc; shift
  for i in "$@"; do
    mkdir "$tmp/claim.$i" 2>/dev/null || continue
    t0=$(now_ms)
    if [ -n "${pidx[i]}" ]; then
      env PORT=$((port_base + 100*slot + pidx[i])) timeout 300 ${cmds[i]} > "$tmp/$i.out" 2>&1; rc=$?
    else
      timeout 300 ${cmds[i]} > "$tmp/$i.out" 2>&1; rc=$?
    fi
    echo "$rc $(( $(now_ms) - t0 ))" > "$tmp/$i.rc.part" && mv "$tmp/$i.rc.part" "$tmp/$i.rc"
  done
}
pass=0; fail=0; failed=()
phase() { # ids...
  [ $# -eq 0 ] && return
  local s i rc ms
  for ((s = 0; s < nj && s < $#; s++)); do worker "$s" "$@" & done
  for i in "$@"; do
    while [ ! -f "$tmp/$i.rc" ]; do sleep 0.2; done
    read -r rc ms < "$tmp/$i.rc"
    if [ "$rc" = 0 ]; then pass=$((pass+1)); printf 'PASS  %-24s %7s\n' "${names[i]}" "$(secs "$ms")"
    else
      fail=$((fail+1)); failed+=("${names[i]}"); printf 'FAIL  %-24s %7s\n' "${names[i]}" "$(secs "$ms")"
      [ "$rc" = 124 ] && echo "      (timed out after 300 s)"
      grep -v '^\s*at ' "$tmp/$i.out" | tail -6 | sed 's/^/      /'
    fi
  done
  wait
}
t_start=$(now_ms)
phase "${unit_ids[@]}"
phase "${e2e_ids[@]}"
echo "---- $pass passed, $fail failed ${failed[*]}  ($(secs $(( $(now_ms) - t_start ))), -j $nj)"
[ $fail -eq 0 ]
