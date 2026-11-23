# Codebase Map & Symbol Catalog 🗺️

> **AUTO-GENERATED & VERIFIED BY `scripts/update_knowledge_base.py`**
> This document catalogues Python modules, classes, and exported functions. See Map Coverage for any stack it does not index.

---

## 📊 Codebase Metrics
- **Total Python Modules**: `3`
- **Total Classes**: `0`
- **Total Top-Level Functions**: `14`
- **Total Class Methods**: `0`
- **Total Source Lines**: `422`

## 🧭 Map Coverage
- **Indexed**: python (`3` module(s))
- **Not indexed by this map**: javascript (`223` file(s)), rust (`2` file(s))

> Only Python symbols are catalogued. A language above is reported as not indexed, never as verified by this map.

---

## 📦 Modules & Exported Symbols

### [`docs/tuning-repro/decision-replay.py`](docs/tuning-repro/decision-replay.py)
> *Replays recorded sweeps on an informative subset of the items, with escalation, and compares the decisions.*

**Size**: `201` lines

**Functions:**
- `def load_json(path)`
- `def json_rows(path)` - *The rows of a .jsonl file; a damaged line is reported on stderr and skipped.*
- `def load_run(path)` - *One run record, or None (reported on stderr) when it is damaged.*
- `def mcnemar_p(b, c)`
- `def decide(cands, items, inc)`
- `def promising(cands, items, inc)`
- `def winner(cands, items, incumbent_key)`

---

### [`docs/tuning-repro/item-concordance.py`](docs/tuning-repro/item-concordance.py)
> *Share of answer time spent on items on which every candidate agreed.*

**Size**: `87` lines

**Functions:**
- `def load_json(path)`
- `def json_rows(path)` - *The rows of a .jsonl file; a damaged line is reported on stderr and skipped.*
- `def load_run(path)` - *One run record, or None (reported on stderr) when it is damaged.*

---

### [`docs/tuning-repro/item-online-order.py`](docs/tuning-repro/item-online-order.py)
> *Simulates ordering items by flips per second learned inside one tune (out-of-sample).*

**Size**: `134` lines

**Functions:**
- `def load_json(path)`
- `def json_rows(path)` - *The rows of a .jsonl file; a damaged line is reported on stderr and skipped.*
- `def load_run(path)` - *One run record, or None (reported on stderr) when it is damaged.*
- `def coverage(order, rec, budget_fraction)`

---
