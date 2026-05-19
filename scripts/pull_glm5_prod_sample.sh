#!/usr/bin/env bash
# Pull a real 100-row GLM-5.1 sample from prod Postgres.
# Requires: tailscale ssh access to prod-db-01
# Output: /home/scott/dev/energy-aware-pi-mono/scripts/glm5_prod_sample_100.csv

set -euo pipefail

OUTDIR="/home/scott/dev/energy-aware-pi-mono/scripts"
OUTFILE="${OUTDIR}/glm5_prod_sample_100.csv"

SQL=$(cat <<'EOF'
\copy (
WITH glm_requests AS (
    SELECT
        ue.created_at,
        ue.model,
        ue.prompt_tokens AS input_tokens,
        ue.completion_tokens AS output_tokens,
        ue.cached_tokens,
        ue.prompt_tokens + ue.completion_tokens AS total_tokens,
        ue.ttft,
        ue.duration AS total_duration_s,
        CASE WHEN ue.duration > 0 THEN ROUND((ue.completion_tokens::numeric / ue.duration::numeric), 2) ELSE NULL END AS tps,
        ue.energy_joules AS request_energy_j,
        ue.energy_kwh AS request_energy_kwh,
        ue.attribution_method,
        s.gpu_type,
        s.gpu_count,
        s.host AS server_host,
        s.status AS server_status,
        ue.request_id
    FROM usage_events ue
    LEFT JOIN inference_servers s ON s.id = ue.server_id
    WHERE ue.model LIKE '%GLM-5%'
      AND ue.created_at >= NOW() - INTERVAL '7 days'
      AND ue.is_synthetic = false
      AND NOT EXISTS (
          SELECT 1 FROM customers c
          WHERE c.id = ue.customer_id
            AND (c.email LIKE '%@neuralwatt.com' OR c.email IN ('test@example.com'))
      )
    ORDER BY RANDOM()
    LIMIT 100
)
SELECT * FROM glm_requests ORDER BY created_at DESC
) TO STDOUT WITH CSV HEADER;
EOF
)

echo "Connecting to prod-db-01..."
tailscale ssh ops@prod-db-01 "sudo docker exec inference-gateway-postgres psql -U postgres -d inference_gateway -c \"${SQL}\"" > "${OUTFILE}"

ROW_COUNT=$(tail -n +2 "${OUTFILE}" | wc -l)
echo "Wrote ${ROW_COUNT} rows to ${OUTFILE}"
