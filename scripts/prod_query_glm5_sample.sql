-- Query: GLM-5.1 Request Telemetry — 100-Row Sample
-- Source:  prod-db-01  |  Database: inference_gateway
-- Run via: tailscale ssh ops@prod-db-01 "sudo docker exec inference-gateway-postgres psql -U postgres -d inference_gateway -c \"$(cat this_file)\""
--
-- Returns one row per request with token counts, latency, energy, batching proxy,
-- GPU hardware metadata, and derived TPS.

\x off
\pset format wrapped
\pset border 2

WITH glm_requests AS (
    SELECT
        ue.id,
        ue.request_id,
        ue.created_at,
        ue.model,
        ue.prompt_tokens,
        ue.completion_tokens,
        ue.cached_tokens,
        ue.prompt_tokens + ue.completion_tokens AS total_tokens,
        ue.ttft,
        ue.duration,
        CASE
            WHEN ue.duration > 0 THEN ROUND(ue.completion_tokens::numeric / ue.duration, 2)
            ELSE NULL
        END AS tps,
        ue.energy_joules,
        ue.energy_kwh,
        ue.attribution_method,
        ue.is_synthetic,
        ue.server_id,
        ue.customer_id
    FROM usage_events ue
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
SELECT
    gr.created_at,
    gr.model,
    gr.prompt_tokens AS input_tokens,
    gr.completion_tokens AS output_tokens,
    gr.cached_tokens,
    gr.total_tokens,
    gr.ttft,
    gr.duration AS total_duration_s,
    gr.tps,
    gr.energy_joules AS request_energy_j,
    gr.energy_kwh,
    gr.attribution_method,
    s.gpu_type,
    s.gpu_count,
    s.host AS server_host,
    s.status AS server_status,
    gr.request_id
FROM glm_requests gr
LEFT JOIN inference_servers s ON s.id = gr.server_id
ORDER BY gr.created_at DESC;
