"""Simulates ordering items by flips per second learned inside one tune (out-of-sample).

Reproduces a number in docs/tuning-improvement-report.md (F10). Needs YOUR tune history: it reads
~/.modelduck/tune-runs (the *.json run records and *.answers.jsonl files that `npm run tune` writes), so the
figures differ per machine. Usage, from the repository root:

    node -e "Promise.all([import('./benchmarks/suite.mjs'),import('./benchmarks/tasks.mjs')]).then(([s,t])=>{const m={};for(const p of s.PROMPTS)m[p.id]=t.taskIdOfCategory(p.category);require('fs').writeFileSync('task-of.json',JSON.stringify(m))})"
    python docs/tuning-repro/item-online-order.py .

(the argument is the folder that holds task-of.json). Read-only; it writes nothing.
"""
import json, glob, os, collections, sys, random


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

# one tune = one run file; sweeps in recorded order per task
runs = []
for f in sorted(glob.glob(d + '/*.json')):
    if f.endswith('.bak'):
        continue
    r = load_run(f)
    if r is None:
        continue
    per_task = collections.defaultdict(list)
    for s in r.get('sweeps') or []:
        rungs = s.get('rungs') or []
        if not rungs or s.get('stage') not in ('sampling', 'prompt'):
            continue
        cands = [c for c in rungs[-1].get('candidates') or [] if c.get('outcomes') and not c.get('partial')]
        if len(cands) < 2:
            continue
        rec = {}
        for it in cands[0]['outcomes']:
            vals = {c['outcomes'].get(it) for c in cands if it in c['outcomes']}
            rec[it] = 1 if len(vals) > 1 else 0
        per_task[s.get('task')].append(rec)
    runs.append((r.get('profileId'), per_task))

PRIOR = 0.15


def coverage(order, rec, budget_fraction):
    items = [i for i in order if i in rec]
    total = sum(mean.get(i, 1000) for i in items)
    info = sum(rec.values())
    if info == 0:
        return None
    spent = got = 0
    for i in items:
        if spent + mean.get(i, 1000) > budget_fraction * total and spent > 0:
            break
        spent += mean.get(i, 1000)
        got += rec[i]
    return got / info


results = collections.defaultdict(lambda: collections.defaultdict(list))
for model, per_task in runs:
    for task, sweeps in per_task.items():
        if len(sweeps) < 4:
            continue
        flips = collections.defaultdict(float)
        seen = collections.defaultdict(float)
        for k, rec in enumerate(sweeps):
            if k >= 2:
                items = list(rec)
                online = sorted(items, key=lambda i: -(((flips[i] + PRIOR) / (seen[i] + 1)) / max(mean.get(i, 1000), 1)))
                rnd = items[:]
                random.Random(k).shuffle(rnd)
                for frac in (0.25, 0.5):
                    a = coverage(rnd, rec, frac)
                    b = coverage(online, rec, frac)
                    if a is not None and b is not None:
                        results[(task, frac)]['random'].append(a)
                        results[(task, frac)]['online'].append(b)
            for it, v in rec.items():
                flips[it] += v
                seen[it] += 1

print('simulated on %d recorded tunes; sweeps from the third onward, learning from earlier sweeps of the same task' % len(runs))
for (task, frac), v in sorted(results.items(), key=lambda x: (x[0][0] or '', x[0][1])):
    n = len(v['random'])
    print('%-14s budget %d%% of rung cost: random %.0f%%  online %.0f%% of the sweep disagreement  (%d sweeps)' % (task, frac * 100, 100 * sum(v['random']) / n, 100 * sum(v['online']) / n, n))
