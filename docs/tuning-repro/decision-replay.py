"""Replays recorded sweeps on an informative subset of the items, with escalation, and compares the decisions.

Reproduces a number in docs/tuning-improvement-report.md (F10). Needs YOUR tune history: it reads
~/.modelduck/tune-runs (the *.json run records and *.answers.jsonl files that `npm run tune` writes), so the
figures differ per machine. Usage, from the repository root:

    node -e "Promise.all([import('./benchmarks/suite.mjs'),import('./benchmarks/tasks.mjs')]).then(([s,t])=>{const m={};for(const p of s.PROMPTS)m[p.id]=t.taskIdOfCategory(p.category);require('fs').writeFileSync('task-of.json',JSON.stringify(m))})"
    python docs/tuning-repro/decision-replay.py .

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
PRIOR = 0.15
TOL = 1  # the tuner keeps a challenger within one item of the best only if it is cheaper; here: who is the top by solved


from math import comb


def mcnemar_p(b, c):
    # one-sided exact: probability of >= c wins out of b+c discordant pairs under p=0.5 (c = challenger wins)
    n = b + c
    if n == 0:
        return 1.0
    return sum(comb(n, k) for k in range(c, n + 1)) / 2 ** n


ALPHA = 0.2


def decide(cands, items, inc):
    base = cands[inc]
    best = None
    ps = []
    for key, out in cands.items():
        if key == inc:
            continue
        c = sum(1 for i in items if out.get(i) == 1 and base.get(i) == 0)
        b = sum(1 for i in items if out.get(i) == 0 and base.get(i) == 1)
        ps.append((mcnemar_p(b, c), key, c - b))
    if not ps:
        return inc
    ps.sort()
    p, key, net = ps[0]
    return key if (net > 0 and p * len(ps) <= ALPHA) else inc


def promising(cands, items, inc):
    base = cands[inc]
    for key, out in cands.items():
        if key == inc:
            continue
        c = sum(1 for i in items if out.get(i) == 1 and base.get(i) == 0)
        b = sum(1 for i in items if out.get(i) == 0 and base.get(i) == 1)
        if c > b and mcnemar_p(b, c) <= TRIGGER:
            return True
    return False


def winner(cands, items, incumbent_key):
    solved = {}
    for key, outcomes in cands.items():
        solved[key] = sum(outcomes[i] for i in items if i in outcomes)
    top = max(solved.values())
    # a challenger replaces the incumbent only by strictly beating it (ties and +0 keep the incumbent), as a paired gain is required
    best = [k for k, v in solved.items() if v == top]
    if incumbent_key in best:
        return incumbent_key, solved
    return sorted(best)[0], solved


rows = []
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
        cs = [c for c in rungs[-1].get('candidates') or [] if c.get('outcomes') and not c.get('partial')]
        if len(cs) < 2:
            continue
        prev = s.get('previous')
        cands = {}
        inc = None
        for c in cs:
            key = json.dumps(c['patch'], sort_keys=True)
            cands[key] = c['outcomes']
            if prev is not None and all(prev.get(k) == v for k, v in c['patch'].items()):
                inc = key
        if inc is None:
            continue
        per_task[s.get('task')].append((cands, inc))
    rows.append((r.get('profileId'), per_task))

for TRIGGER in (0.5, 0.35, 0.25, 0.15, 0.08):
  for frac in (0.25,):
      agree = total = changed_total = changed_kept = 0
      escalated = 0
      false_change = missed = other = 0
      cost_used = cost_all = 0.0
      for model, per_task in rows:
          for task, sweeps in per_task.items():
              flips = collections.defaultdict(float)
              seen = collections.defaultdict(float)
              for k, (cands, inc) in enumerate(sweeps):
                  items = list(next(iter(cands.values())))
                  items = [i for i in items if all(i in o for o in cands.values())]
                  if k >= 2 and len(items) >= 12:
                      order = sorted(items, key=lambda i: -(((flips[i] + PRIOR) / (seen[i] + 1)) / max(mean.get(i, 1000), 1)))
                      total_cost = sum(mean.get(i, 1000) for i in items)
                      chosen, spent = [], 0.0
                      for i in order:
                          if spent >= frac * total_cost and chosen:
                              break
                          chosen.append(i)
                          spent += mean.get(i, 1000)
                      rest = [i for i in items if i not in set(chosen)]
                      rnd = random.Random(k * 7 + len(items))
                      trip = rnd.sample(rest, max(1, len(rest) // 10)) if rest else []
                      sub = chosen + trip
                      w_full = decide(cands, items, inc)
                      w_sub = decide(cands, sub, inc)
                      if promising(cands, sub, inc):
                          w_sub = w_full
                          escalated += 1
                          cost_used += total_cost - sum(mean.get(i, 1000) for i in sub)
                      total += 1
                      agree += int(w_full == w_sub)
                      if w_full == inc and w_sub != inc:
                          false_change += 1
                      if w_full != inc and w_sub == inc:
                          missed += 1
                      if w_full != inc and w_sub != inc and w_full != w_sub:
                          other += 1
                      cost_used += sum(mean.get(i, 1000) for i in sub)
                      cost_all += total_cost
                      if w_full != inc:
                          changed_total += 1
                          changed_kept += int(w_sub == w_full)
                  rec = {i: int(len({c[i] for c in cands.values()}) > 1) for i in items}
                  for i, v in rec.items():
                      flips[i] += v
                      seen[i] += 1
      print('trigger p<=%.2f; budget %d%% + 10%% tripwire (%.0f%% of the rung cost): same decision in %d of %d sweeps (%d escalated to the full rung); full set changes the setting in %d (subset agrees in %d, misses %d, picks another value in %d); subset changes where the full set keeps: %d' % (TRIGGER, frac * 100, 100 * cost_used / cost_all, agree, total, escalated, changed_total, changed_kept, missed, other, false_change))
