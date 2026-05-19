#!/usr/bin/env python3
"""
Generate a synthetic 100-row GLM-5.1 dataset matching the prod usage_events schema.
Output: CSV + JSONL to stdout and files.

Schema mirrors the production query in: prod_query_glm5_sample.sql
"""

import csv
import json
import random
import sys
from datetime import datetime, timedelta, timezone

random.seed(42)

# ---------------------------------------------------------------------------
# Realistic distributions (tuned to match observed GLM-5-FP8 prod behaviour)
# ---------------------------------------------------------------------------
MODELS = [
    "zai-org/GLM-5-FP8",
    "zai-org/GLM-5-FP8",
    "zai-org/GLM-5-FP8",
    "zai-org/GLM-5-A14B-FP8",
    "zai-org/GLM-5-A14B-FP8",
]
GPU_TYPES = [
    ("NVIDIA H100 80GB", 1),
    ("NVIDIA H100 80GB", 2),
    ("NVIDIA H100 80GB", 4),
    ("NVIDIA H200 141GB", 1),
    ("NVIDIA H200 141GB", 2),
    ("NVIDIA H200 141GB", 4),
]
SERVER_HOSTS = [
    "br-rtp-h200-tlv1-01",
    "br-rtp-h200-tlv1-02",
    "us-east-h100-nyc1-04",
    "us-east-h100-nyc1-05",
    "eu-west-h100-ams2-01",
    "eu-west-h100-ams2-02",
    "ap-south-h100-sgp1-03",
]
ATTRIBUTION_METHODS = ["exact", "token_weighted", "token_weighted", "token_weighted", "estimated"]


def randchoice(weights):
    """Weighted random choice from list of (item, weight) tuples."""
    total = sum(w for _, w in weights)
    r = random.uniform(0, total)
    for item, w in weights:
        r -= w
        if r <= 0:
            return item
    return weights[-1][0]


def generate_row(idx, base_time):
    """Generate one synthetic request record."""
    # --- token counts ---
    prompt = int(random.gauss(2500, 1200))
    prompt = max(10, min(prompt, 30000))

    cached = int(random.gauss(400, 200)) if random.random() < 0.35 else 0
    cached = max(0, min(cached, prompt))

    output = int(random.gauss(800, 400))
    output = max(5, min(output, 8000))

    total = prompt + output

    # --- latency ---
    # TTFT scales with prompt length (prefill) + static overhead
    ttft = 0.05 + (prompt / 30000) * 1.2 + random.gauss(0, 0.08)
    ttft = max(0.02, ttft)

    # TPS (output tokens / second) is the dominant variability
    tps = random.gauss(42, 14)  # GLM-5-FP8 on H100/H200 range
    tps = max(8, min(tps, 95))

    # Total duration = TTFT + (output / TPS)
    duration = ttft + (output / tps) + random.gauss(0, 0.05)
    duration = max(ttft + 0.02, duration)

    # --- energy ---
    # Energy ≈ power * time; H100 ~ 300-450W during inference
    # Token-weighted requests have higher energy because GPU is busier
    attribution = random.choice(ATTRIBUTION_METHODS)
    power_w = random.gauss(380, 60) if attribution == "exact" else random.gauss(420, 70)
    energy_j = max(0.01, power_w * duration + random.gauss(0, 2))

    # GPU assignment
    gpu_type, gpu_count = random.choice(GPU_TYPES)
    server = random.choice(SERVER_HOSTS)

    # Timestamp within last 7 days, clustered to simulate traffic patterns
    offset_minutes = random.gauss(0, 3000)  # ±~2 days centered
    created = base_time + timedelta(minutes=offset_minutes)

    return {
        "timestamp": created.isoformat(),
        "model": random.choice(MODELS),
        "input_tokens": prompt,
        "output_tokens": output,
        "cached_tokens": cached,
        "total_tokens": total,
        "ttft_s": round(ttft, 3),
        "total_duration_s": round(duration, 3),
        "tps": round(tps, 2),
        "request_energy_j": round(energy_j, 3),
        "request_energy_kwh": round(energy_j / 3_600_000, 9),
        "attribution_method": attribution,
        "gpu_type": gpu_type,
        "gpu_count": gpu_count,
        "server_host": server,
        "server_status": "healthy",
        "request_id": f"req-{random.randint(10_000_000, 99_999_999):08x}",
    }


def generate_dataset(n=100):
    base_time = datetime.now(timezone.utc)
    return [generate_row(i, base_time) for i in range(n)]


def write_csv(rows, path):
    if not rows:
        return
    with open(path, "w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=rows[0].keys())
        writer.writeheader()
        writer.writerows(rows)


def write_jsonl(rows, path):
    with open(path, "w") as f:
        for r in rows:
            f.write(json.dumps(r) + "\n")


def main():
    rows = generate_dataset(100)

    csv_path = "/home/scott/dev/energy-aware-pi-mono/scripts/glm5_sample_100.csv"
    jsonl_path = "/home/scott/dev/energy-aware-pi-mono/scripts/glm5_sample_100.jsonl"

    write_csv(rows, csv_path)
    write_jsonl(rows, jsonl_path)

    print(f"Wrote {len(rows)} rows to:")
    print(f"  CSV:  {csv_path}")
    print(f"  JSONL: {jsonl_path}")
    print()

    # Print first 5 rows as preview (JSON)
    print("--- Preview (first 5 rows) ---")
    for r in rows[:5]:
        print(json.dumps(r))

    # Summary stats
    print("\n--- Summary Statistics ---")
    energies = [r["request_energy_j"] for r in rows]
    ttfts = [r["ttft_s"] for r in rows]
    tps_vals = [r["tps"] for r in rows]
    durations = [r["total_duration_s"] for r in rows]
    inputs = [r["input_tokens"] for r in rows]
    outputs = [r["output_tokens"] for r in rows]
    cached = [r["cached_tokens"] for r in rows]

    print(f"Input tokens:    mean={sum(inputs)/len(inputs):.0f},  max={max(inputs)}")
    print(f"Output tokens:   mean={sum(outputs)/len(outputs):.0f},  max={max(outputs)}")
    print(f"Cached tokens:   mean={sum(cached)/len(cached):.0f}")
    print(f"TTFT (s):        mean={sum(ttfts)/len(ttfts):.3f},  p50={sorted(ttfts)[50]:.3f}")
    print(f"Duration (s):    mean={sum(durations)/len(durations):.2f},  p50={sorted(durations)[50]:.2f}")
    print(f"TPS (tok/s):     mean={sum(tps_vals)/len(tps_vals):.1f},  p50={sorted(tps_vals)[50]:.1f}")
    print(f"Energy (J):      mean={sum(energies)/len(energies):.2f},  p50={sorted(energies)[50]:.2f}")

    batched = sum(1 for r in rows if r["attribution_method"] == "token_weighted")
    print(f"Batched requests: {batched}/{len(rows)} ({batched/len(rows)*100:.0f}%)")


if __name__ == "__main__":
    main()
