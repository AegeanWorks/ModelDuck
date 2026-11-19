"""Share of answer time spent on items on which every candidate agreed.

Reproduces a number in docs/tuning-improvement-report.md (F10). Needs YOUR tune history: it reads
~/.modelduck/tune-runs (the *.json run records and *.answers.jsonl files that `npm run tune` writes), so the
figures differ per machine. Usage, from the repository root:

    node -e "Promise.all([import('./benchmarks/suite.mjs'),import('./benchmarks/tasks.mjs')]).then(([s,t])=>{const m={};for(const p of s.PROMPTS)m[p.id]=t.taskIdOfCategory(p.category);require('fs').writeFileSync('task-of.json',JSON.stringify(m))})"
    python docs/tuning-repro/item-concordance.py .

(the argument is the folder that holds task-of.json). Read-only; it writes nothing.
"""
import json, glob, os, collections, sys


def load_json(path):
    with open(path, encoding='utf-8') as handle:
        return json.load(handle)


def json_rows(path):
    """The rows of a .jsonl file; a damaged line is reported on stderr and skipped."""
    with open(path, encoding='utf-8') as handle:
        lines = handle.read().splitlines()
    rows = []
    for line in lines:
        if not line.strip():
            continue
        try:
            rows.append(json.loads(line))
        except ValueError as error:
            print('skipped a damaged line in %s: %s' % (os.path.basename(path), error), file=sys.stderr)
    return rows


def load_run(path):
    """One run record, or None (reported on stderr) when it is damaged."""
    try:
        return load_json(path)
    except ValueError as error:
        print('skipped %s: %s' % (os.path.basename(path), error), file=sys.stderr)
        return None


S = sys.argv[1]
task_of = load_json(S + '/task-of.json')
d = os.path.expanduser('~/.modelduck/tune-runs')
cost = collections.defaultdict(lambda: [0.0, 0])
for f in glob.glob(d + '/*.answers.jsonl'):
    for r in json_rows(f):
        c = cost[r['item']]
        c[0] += r.get('ms') or 0
        c[1] += 1
mean = {k: v[0] / v[1] for k, v in cost.items() if v[1]}

tot = collections.defaultdict(lambda: [0.0, 0.0, 0, 0])  # task -> [time concordant, time discordant, n concordant, n discordant]
for f in glob.glob(d + '/*.json'):
    if f.endswith('.bak'):
        continue
    r = load_run(f)
    if r is None:
        continue
    for s in r.get('sweeps') or []:
        if s.get('stage') not in ('sampling', 'prompt'):
            continue
        for rung in s.get('rungs') or []:
            cands = [c for c in rung.get('candidates') or [] if c.get('outcomes')]
            if len(cands) < 2:
                continue
            for it in cands[0]['outcomes']:
                vals = [c['outcomes'][it] for c in cands if it in c['outcomes']]
                if len(vals) < 2:
                    continue
                ms = mean.get(it, 0) * len(vals)  # every candidate answered it
                t = task_of.get(it, '?')
                if len(set(vals)) > 1:
                    tot[t][1] += ms
                    tot[t][3] += len(vals)
                else:
                    tot[t][0] += ms
                    tot[t][2] += len(vals)

allc = sum(v[0] for v in tot.values())
alld = sum(v[1] for v in tot.values())
print('answers whose item had every candidate agree, by task (sampling and prompt sweeps, item-cost weighted):')
for t, (c, dsc, nc, nd) in tot.items():
    print('  %-14s concordant %5.1f%% of answers, %5.1f%% of time' % (t, 100 * nc / (nc + nd), 100 * c / (c + dsc)))
print('  all tasks: %.1f%% of the time went to items on which every candidate agreed' % (100 * allc / (allc + alld)))
