#!/usr/bin/env python3
"""Analyze the real GLM-5.1 prod sample pulled from usage_events."""

import csv
import json
import sys
from collections import Counter
from statistics import mean, median, stdev

CSV_PATH = "/home/scott/dev/energy-aware-pi-mono/scripts/glm5_prod_sample_100.csv"


def safe_float(val, default=None):
    try:
        return float(val)
    except (ValueError, TypeError):
        return default


rows = []
with open(CSV_PATH) as f:
    reader = csv.DictReader(f)
    for r in reader:
        rows.append(r)

print(f"Loaded {len(rows)} rows from {CSV_PATH}\n")

# ------------------------------------------------------------------
# Extract numeric columns
# ------------------------------------------------------------------
inputs = [safe_float(r["input_tokens"]) for r in rows if safe_float(r["input_tokens"]) is not None]
outputs = [safe_float(r["output_tokens"]) for r in rows if safe_float(r["output_tokens"]) is not None]
cached = [safe_float(r["cached_tokens"]) for r in rows if safe_float(r["cached_tokens"]) is not None]
totals = [safe_float(r["total_tokens"]) for r in rows if safe_float(r["total_tokens"]) is not None]
ttfts = [safe_float(r["ttft"]) for r in rows if safe_float(r["ttft"]) is not None]
durations = [safe_float(r["total_duration_s"]) for r in rows if safe_float(r["total_duration_s"]) is not None]
tps_vals = [safe_float(r["tps"]) for r in rows if safe_float(r["tps"]) is not None]
energies = [safe_float(r["request_energy_j"]) for r in rows if safe_float(r["request_energy_j"]) is not None]
energy_kwh = [safe_float(r["request_energy_kwh"]) for r in rows if safe_float(r["request_energy_kwh"]) is not None]


def pctile(arr, p):
    s = sorted(arr)
    idx = int(len(s) * p / 100)
    return s[min(idx, len(s) - 1)]


def summarize(name, arr):
    if not arr:
        return
    print(f"{name:25s}  min={min(arr):>12.1f}  p50={median(arr):>12.1f}  mean={mean(arr):>12.1f}  p95={pctile(arr,95):>12.1f}  max={max(arr):>12.1f}")


print("=" * 110)
print("NUMERIC SUMMARY")
print("=" * 110)
summarize("Input tokens", inputs)
summarize("Output tokens", outputs)
summarize("Cached tokens", cached)
summarize("Total tokens", totals)
summarize("TTFT (s)", ttfts)
summarize("Duration (s)", durations)
summarize("TPS (tok/s)", tps_vals)
summarize("Energy (joules)", energies)
summarize("Energy (kWh)", [e * 1000 for e in energy_kwh])  # in mWh

# ------------------------------------------------------------------
# Categorical
# ------------------------------------------------------------------
print("\n" + "=" * 110)
print("CATEGORICAL SUMMARY")
print("=" * 110)

models = Counter(r["model"] for r in rows)
print(f"{'Model':<40s}  {'Count':>8s}")
for m, c in models.most_common():
    print(f"  {m:<38s}  {c:>8d}")

gpus = Counter(r["gpu_type"] for r in rows)
print(f"\n{'GPU Type':<25s}  {'Count':>8s}")
for g, c in gpus.most_common():
    print(f"  {g:<23s}  {c:>8d}")

gpu_counts = Counter(r["gpu_count"] for r in rows)
print(f"\n{'GPU Count':<12s}  {'Count':>8s}")
for gc, c in gpu_counts.most_common():
    print(f"  {gc:<10s}  {c:>8d}")

attrs = Counter(r["attribution_method"] for r in rows)
print(f"\n{'Attribution':<40s}  {'Count':>8s}")
for a, c in attrs.most_common():
    print(f"  {a:<38s}  {c:>8d}")

servers = Counter(r["server_host"] for r in rows)
print(f"\n{'Server Host':<22s}  {'Count':>8s}")
for s, c in servers.most_common():
    print(f"  {s:<20s}  {c:>8d}")

# ------------------------------------------------------------------
# Derived / cross-cutting insights
# ------------------------------------------------------------------
print("\n" + "=" * 110)
print("DERIVED INSIGHTS")
print("=" * 110)

# Energy per output token
epo = [e / o for e, o in zip(energies, outputs) if o > 0]
summarize("Energy/output_token (J/tok)", epo)

# Energy per total token
ept = [e / t for e, t in zip(energies, totals) if t > 0]
summarize("Energy/total_token (J/tok)", ept)

# Cache hit rate
has_cache = sum(1 for c in cached if c > 0)
print(f"\nCache hits:        {has_cache}/{len(rows)}  ({has_cache/len(rows)*100:.1f}%)")

# Batching proxy
batched = sum(1 for a in (r["attribution_method"] for r in rows) if "token_pool_weighted" in a)
print(f"Batched (proxy):   {batched}/{len(rows)}  ({batched/len(rows)*100:.1f}%)")

# TTFT nulls
null_ttft = sum(1 for r in rows if not r["ttft"] or r["ttft"].strip() == "")
print(f"Missing TTFT:      {null_ttft}/{len(rows)}")

# Time range
from datetime import datetime

times = [datetime.fromisoformat(r["created_at"].replace(" ", "T")) for r in rows]
print(f"Date range:        {min(times)}  ->  {max(times)}")
