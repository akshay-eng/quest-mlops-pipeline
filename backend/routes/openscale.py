"""
Watson OpenScale (IBM Watson AI Fairness) — Model Monitoring routes.

Endpoints:
  GET /api/openscale/deployments          — all subscriptions with monitor status
  GET /api/openscale/deployments/{sub_id} — single subscription detail + last run metrics
  POST /api/openscale/deployments/{sub_id}/investigate — trigger Watson X Orchestrate agent
"""

import os
import time
import asyncio
import httpx
from fastapi import APIRouter, HTTPException

router = APIRouter()

# Shared async client — limits concurrent connections to avoid overwhelming OpenScale
_http_client: httpx.AsyncClient | None = None

def _get_client() -> httpx.AsyncClient:
    global _http_client
    if _http_client is None or _http_client.is_closed:
        _http_client = httpx.AsyncClient(
            timeout=httpx.Timeout(connect=10, read=20, write=10, pool=5),
            limits=httpx.Limits(max_connections=20, max_keepalive_connections=10),
        )
    return _http_client

IBM_API_KEY   = os.environ.get("IBM_API_KEY", "")
INSTANCE_ID   = os.environ.get("OPENSCALE_INSTANCE_ID", "c6614aae-7f6f-4a92-ab36-0c432f433dc2")
ORCHESTRATE_WEBHOOK = os.environ.get("WATSONX_ORCHESTRATE_WEBHOOK_URL", "")

OS_BASE = f"https://aiopenscale.cloud.ibm.com/openscale/{INSTANCE_ID}/v2"

# --------------------------------------------------------------------------
# Monitor definitions we surface in the UI
# --------------------------------------------------------------------------
MONITOR_LABELS = {
    "quality":        "Quality",
    "fairness":       "Fairness",
    "drift_v2":       "Drift v2",
    "explainability": "Explainability",
}

# Human-readable names for metric IDs returned by OpenScale
METRIC_NAMES: dict[str, str] = {
    # Fairness
    "false_positive_rate_difference":       "False positive rate difference",
    "false_negative_rate_difference":       "False negative rate difference",
    "error_rate_difference":                "Error rate difference",
    "false_omission_rate_difference":       "False omission rate difference",
    "disparate_impact":                     "Disparate impact",
    "statistical_parity_difference":        "Statistical parity difference",
    "false_discovery_rate_difference":      "False discovery rate difference",
    "average_odds_difference":              "Average odds difference",
    "average_absolute_odds_difference":     "Average absolute odds difference",
    # Quality
    "true_positive_rate":                   "True positive rate (TPR)",
    "area_under_roc":                       "Area under ROC",
    "precision":                            "Precision",
    "matthews_correlation_coefficient":     "Matthews correlation coefficient",
    "f1_measure":                           "F1-Measure",
    "accuracy":                             "Accuracy",
    "label_skew":                           "Label skew",
    "gini_coefficient":                     "Gini coefficient",
    "logarithmic_loss":                     "Logarithmic loss",
    "false_positive_rate":                  "False positive rate (FPR)",
    "area_under_pr":                        "Area under PR",
    "recall":                               "Recall",
    "brier_score":                          "Brier score",
    # Drift v2  (OpenScale uses confidence_drift_score etc. internally)
    "output_drift":                         "Output drift",
    "confidence_drift_score":               "Output drift",
    "prediction_drift":                     "Prediction drift",
    "model_quality_drift":                  "Model quality drift",
    "feature_drift":                        "Feature drift",
    "data_drift_magnitude":                 "Feature drift",
    # Explainability
    "global_explanation_stability":         "Global explanation stability",
}

# Metrics that are internal/system — never shown in UI
_SKIP_METRICS = {"records_processed", "num_records", "sample_size"}


def _metric_name(metric_id: str) -> str:
    return METRIC_NAMES.get(metric_id, metric_id.replace("_", " ").title())


def _parse_violation(metric: dict) -> float | None:
    """Return how much the metric violates its threshold, or None if within bounds."""
    value = metric.get("value")
    if value is None:
        return None
    upper = metric.get("upper_limit")
    if isinstance(upper, dict): upper = upper.get("value")
    lower = metric.get("lower_limit")
    if isinstance(lower, dict): lower = lower.get("value")
    if upper is not None and float(value) > float(upper):
        return round(float(value) - float(upper), 4)
    if lower is not None and float(value) < float(lower):
        return round(float(lower) - float(value), 4)
    return None

# --------------------------------------------------------------------------
# IAM token cache  (tokens expire after ~1 hour; cache for 55 min)
# --------------------------------------------------------------------------
_token_cache: dict = {"token": None, "expires_at": 0}


async def _get_iam_token() -> str:
    now = time.time()
    if _token_cache["token"] and now < _token_cache["expires_at"]:
        return _token_cache["token"]

    if not IBM_API_KEY:
        raise HTTPException(status_code=503, detail="IBM_API_KEY env var not set")

    print(f"[openscale] Getting IAM token for key ...{IBM_API_KEY[-6:]}")
    try:
        resp = await _get_client().post(
            "https://iam.cloud.ibm.com/identity/token",
            data={
                "grant_type": "urn:ibm:params:oauth:grant-type:apikey",
                "apikey":     IBM_API_KEY,
            },
            headers={"Content-Type": "application/x-www-form-urlencoded"},
        )
    except (httpx.ConnectTimeout, httpx.ConnectError, httpx.HTTPError) as e:
        raise HTTPException(status_code=502, detail=f"IAM connection error: {e}")

    print(f"[openscale] IAM response: {resp.status_code} — {resp.text[:120]}")
    if resp.status_code != 200:
        raise HTTPException(status_code=502, detail=f"IAM token error {resp.status_code}: {resp.text[:200]}")

    data = resp.json()
    _token_cache["token"]      = data["access_token"]
    _token_cache["expires_at"] = now + int(data.get("expires_in", 3600)) - 300
    return _token_cache["token"]


async def _os_get(path: str, token: str) -> dict:
    try:
        resp = await _get_client().get(
            f"{OS_BASE}{path}",
            headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        )
        if resp.status_code != 200:
            print(f"[openscale] GET {path[-80:]} → {resp.status_code}: {resp.text[:200]}")
            return {}
        return resp.json()
    except (httpx.ConnectTimeout, httpx.ReadTimeout, httpx.ConnectError, httpx.HTTPError) as e:
        print(f"[openscale] GET {path[-80:]} → timeout/error: {e}")
        return {}


# --------------------------------------------------------------------------
# Helpers to build deployment card data
# --------------------------------------------------------------------------
def _run_state_to_ui(state: str | None) -> str:
    """Map OpenScale run state to a UI-friendly string."""
    if not state:         return "unknown"
    if state == "finished": return "ok"
    if state == "error":    return "error"
    if state == "running":  return "running"
    return state


def _normalize_monitor_id(raw_id: str) -> str:
    """Map raw OpenScale monitor_definition_id to our short key.

    OpenScale returns IDs like 'watson_openscale_quality' or just 'quality'.
    We strip known prefixes so both forms resolve to our MONITOR_LABELS key.
    """
    for prefix in ("watson_openscale_", "openscale_"):
        if raw_id.startswith(prefix):
            return raw_id[len(prefix):]
    return raw_id


def _build_monitor_summary(monitor_instances: list) -> dict:
    """Extract per-monitor last-run state from monitor_instances list."""
    summary = {}
    for mi in monitor_instances:
        ent = mi.get("entity", {})
        raw_id = ent.get("monitor_definition_id", "")
        mon_id = _normalize_monitor_id(raw_id)
        if mon_id not in MONITOR_LABELS:
            continue
        params     = ent.get("parameters", {})
        # last_run_status can live at entity level or nested under parameters
        last_state = (
            ent.get("last_run_status")
            or params.get("last_run_status")
            or ent.get("status", {}).get("state")
        )
        # Normalise run state to ui values
        if last_state:
            last_state = last_state.lower()
            if "finished_without" in last_state: last_state = "warning"
            elif "finished" in last_state:        last_state = "ok"
            elif "error" in last_state:           last_state = "error"
            elif last_state in ("active", "enabled", "running"): last_state = "ok"

        summary[mon_id] = {
            "label":       MONITOR_LABELS[mon_id],
            "state":       last_state or "unknown",
            "instance_id": mi["metadata"]["id"],
        }
    return summary


async def _get_latest_run(token: str, instance_id: str) -> dict | None:
    """Fetch the most recent run for a monitor instance."""
    data = await _os_get(f"/monitor_instances/{instance_id}/runs?limit=1", token)
    runs = data.get("runs", [])
    if not runs:
        return None
    run    = runs[0]
    entity = run.get("entity", {})
    status = entity.get("status", {})
    alert_count = (
        entity.get("triggered_alerts_count")
        or entity.get("triggered_alerts")
        or entity.get("alert_count")
        or 0
    )
    return {
        "id":           run.get("metadata", {}).get("id"),   # needed for measurements lookup
        "state":        status.get("state"),
        "completed_at": status.get("completed_at"),
        "alert_count":  int(alert_count) if alert_count else 0,
        "error":        status.get("failure", {}).get("errors", [{}])[0].get("message") if status.get("failure") else None,
    }


def _run_to_ui_state(run: dict | None) -> str:
    """Convert a run result to a UI state string."""
    if not run:
        return "unknown"
    raw = (run.get("state") or "").lower()
    if "error" in raw or raw == "failed":
        return "error"
    if "finished" in raw or raw == "completed":
        return "error" if run.get("alert_count", 0) > 0 else "ok"
    if raw == "running":
        return "running"
    return "unknown"


def _parse_values_field(values_raw) -> tuple[list, str | None, str | None, int]:
    """Parse the 'values' field from an OpenScale measurement entity.

    Structure confirmed from API:
      values = [
        {
          "metrics": [{"id": "metric_id", "value": 0.5, "lower_limit": 0.8}, ...],
          "tags":    [{"id": "field_name", "value": "Age"}, ...]
        }, ...
      ]

    Returns (metrics_list, monitored_feature, monitored_value, records_count).
    Collects metrics across all value groups; deduplicates by metric id.
    """
    if not values_raw or not isinstance(values_raw, list):
        return [], None, None, 0

    seen:              dict[str, dict] = {}   # metric_id → best entry
    monitored_feature: str | None = None
    monitored_value:   str | None = None
    records_count:     int = 0

    for group in values_raw:
        if not isinstance(group, dict):
            continue

        # Extract tags → dict for easy lookup
        tags = {t["id"]: t["value"] for t in group.get("tags", [])
                if isinstance(t, dict) and "id" in t}

        if not monitored_feature:
            monitored_feature = tags.get("field_name") or tags.get("feature")
        if not monitored_value:
            monitored_value = (tags.get("monitored_value")
                               or tags.get("monitored_range")
                               or tags.get("lower_threshold"))

        for m in group.get("metrics", []):
            if not isinstance(m, dict):
                continue
            mid = m.get("id", "")
            if not mid or mid in _SKIP_METRICS:
                continue

            # records_processed carries the record count
            if mid == "records_processed":
                try:
                    records_count = max(records_count, int(m.get("value", 0) or 0))
                except (ValueError, TypeError):
                    pass
                continue

            value     = m.get("value")
            violation = _parse_violation(m)
            entry = {
                "id":        mid,
                "name":      _metric_name(mid),
                "value":     round(float(value), 4) if value is not None else None,
                "violation": violation,
            }
            # Prefer entry with a known violation over one without
            if mid not in seen or (seen[mid]["violation"] is None and violation is not None):
                seen[mid] = entry

    return list(seen.values()), monitored_feature, monitored_value, records_count


async def _get_measurements(token: str, instance_id: str, run_id: str | None = None) -> dict:
    """Fetch latest measurement data for a monitor instance.

    The OpenScale API requires 'start' for plain calls, so we prefer
    run_id-scoped first, then fall back to an explicit 30-day window.
    Metrics live in entity['values'], not entity['metrics'].
    """
    import datetime

    empty = {"metrics": [], "records_count": 0, "monitored_value": None, "monitored_feature": None, "issue_count": 0}

    end_ts   = datetime.datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ")
    start_ts = (datetime.datetime.utcnow() - datetime.timedelta(days=30)).strftime("%Y-%m-%dT%H:%M:%SZ")

    candidates: list[str] = []
    if run_id:
        candidates.append(f"/monitor_instances/{instance_id}/measurements?run_id={run_id}&limit=50")
    candidates.append(f"/monitor_instances/{instance_id}/measurements?start={start_ts}&end={end_ts}&limit=1")

    measurements = []
    for url in candidates:
        data = await _os_get(url, token)
        measurements = data.get("measurements", [])
        if measurements:
            break

    if not measurements:
        return empty

    latest      = measurements[0]
    entity      = latest.get("entity", {})
    values_raw  = entity.get("values", [])
    issue_count = int(entity.get("issue_count") or 0)

    metrics, monitored_feature, monitored_value, records_count = _parse_values_field(values_raw)

    # Fallback records_count from entity if not found in values
    if not records_count:
        records_count = entity.get("records_count", 0) or 0

    return {
        "metrics":           metrics,
        "records_count":     records_count,
        "monitored_value":   monitored_value,
        "monitored_feature": monitored_feature,
        "issue_count":       issue_count,
    }


# --------------------------------------------------------------------------
# GET /api/openscale/deployments
# --------------------------------------------------------------------------
@router.get("/openscale/deployments")
async def list_deployments():
    """Return all OpenScale subscriptions with monitor health summary."""
    token = await _get_iam_token()

    subs_data  = await _os_get("/subscriptions", token)
    subs       = subs_data.get("subscriptions", [])

    # Limit concurrent outbound calls so we don't overwhelm the OpenScale API
    _sem = asyncio.Semaphore(6)

    # Fetch monitor instances for all subs concurrently
    async def _enrich(sub: dict) -> dict:
        sub_id = sub["metadata"]["id"]
        ent    = sub.get("entity", {})
        asset  = ent.get("asset", {})
        dep    = ent.get("deployment", {})
        risk   = ent.get("risk_evaluation_status", {})

        mi_data = await _os_get(
            f"/monitor_instances?target.target_id={sub_id}&target.target_type=subscription",
            token,
        )
        monitors = _build_monitor_summary(mi_data.get("monitor_instances", []))

        # Fetch last run per monitor to get real alert-aware state
        async def _apply_run(mon_id: str, info: dict) -> tuple[str, dict]:
            async with _sem:
                run = await _get_latest_run(token, info["instance_id"])
            real_state = _run_to_ui_state(run)
            # If runs give no useful info, keep the instance-level state (active → ok)
            if real_state == "unknown":
                real_state = info.get("state", "unknown")
            return mon_id, {**info, "state": real_state, "alert_count": run.get("alert_count", 0) if run else 0}

        enriched = await asyncio.gather(*[_apply_run(k, v) for k, v in monitors.items()])
        monitors = dict(enriched)

        # Determine last evaluated time across all monitors
        timestamps = [
            mi.get("metadata", {}).get("modified_at", "")
            for mi in mi_data.get("monitor_instances", [])
            if mi.get("metadata", {}).get("modified_at")
        ]
        last_evaluated = max(timestamps) if timestamps else None

        # Overall status: any error → alert, all ok → ok, else warning
        states = [m["state"] for m in monitors.values()]
        if "error" in states:      overall = "alert"
        elif "warning" in states:  overall = "warning"
        elif all(s == "ok" for s in states if s != "unknown"): overall = "ok"
        else:                      overall = "unknown"

        return {
            "id":             sub_id,
            "name":           asset.get("name", dep.get("name", "Unknown")),
            "deployment_name": dep.get("name", ""),
            "deployment_type": dep.get("deployment_type", "online"),
            "problem_type":   asset.get("problem_type", ""),
            "status":         ent.get("status", {}).get("state", ""),
            "approved":       risk.get("state") == "approved",
            "last_evaluated": last_evaluated,
            "overall_status": overall,
            "monitors":       monitors,
            "openscale_url":  f"https://aiopenscale.cloud.ibm.com/aiopenscale/insights",
        }

    results = await asyncio.gather(*[_enrich(s) for s in subs])
    return list(results)


# --------------------------------------------------------------------------
# GET /api/openscale/deployments/{sub_id}
# --------------------------------------------------------------------------
@router.get("/openscale/deployments/{sub_id}")
async def get_deployment(sub_id: str):
    """Return one subscription with full metric tables per monitor."""
    token = await _get_iam_token()

    sub_data = await _os_get(f"/subscriptions/{sub_id}", token)
    if not sub_data:
        raise HTTPException(status_code=404, detail="Subscription not found")

    mi_data = await _os_get(
        f"/monitor_instances?target.target_id={sub_id}&target.target_type=subscription",
        token,
    )
    monitors = _build_monitor_summary(mi_data.get("monitor_instances", []))

    _sem = asyncio.Semaphore(6)

    # Fetch run + measurements concurrently for every tracked monitor
    async def _with_details(mon_id: str, info: dict) -> tuple[str, dict]:
        async with _sem:
            run = await _get_latest_run(token, info["instance_id"])
        async with _sem:
            meas = await _get_measurements(token, info["instance_id"], run_id=run.get("id") if run else None)
        # issue_count from measurements is most accurate; fall back to run alert_count
        alert_count = meas.get("issue_count") or (run.get("alert_count", 0) if run else 0)
        real_state  = "error" if alert_count > 0 else _run_to_ui_state(run)
        if real_state == "unknown":
            real_state = info.get("state", "unknown")
        return mon_id, {
            **info,
            "state":             real_state,
            "alert_count":       alert_count,
            "metrics":           meas["metrics"],
            "records_count":     meas["records_count"],
            "monitored_value":   meas["monitored_value"],
            "monitored_feature": meas["monitored_feature"],
            "issue_count":       alert_count,
            "last_run":          run,
        }

    enriched = await asyncio.gather(*[_with_details(k, v) for k, v in monitors.items()])
    monitors_detail = dict(enriched)

    ent   = sub_data.get("entity", {})
    asset = ent.get("asset", {})
    dep   = ent.get("deployment", {})
    risk  = ent.get("risk_evaluation_status", {})

    # Last evaluation = most recent completed_at across all monitors
    completed_times = [
        v["last_run"]["completed_at"]
        for v in monitors_detail.values()
        if v.get("last_run") and v["last_run"].get("completed_at")
    ]
    last_evaluated = max(completed_times) if completed_times else None

    # Scoring / record counts from subscription payload stats (best-effort)
    payload_stats   = ent.get("payload_logging_table", {}).get("stats", {})
    scoring_last_eval = payload_stats.get("recent_records") or payload_stats.get("last_eval_records")
    scoring_last_7d   = payload_stats.get("total_records")  or payload_stats.get("last_7d_records")

    # Test summary: each monitor = one test; alerting monitors = failed
    tracked = [v for v in monitors_detail.values()]
    if tracked:
        failed = sum(1 for m in tracked if m.get("alert_count", 0) > 0)
        tests  = {"run": len(tracked), "passed": len(tracked) - failed, "failed": failed}
    else:
        tests = None

    # Explainability: extract explanation count
    explanations = None
    if "explainability" in monitors_detail:
        exm = monitors_detail["explainability"]
        explanations = exm.get("records_count") or exm.get("alert_count")

    return {
        "id":              sub_id,
        "name":            asset.get("name", dep.get("name", "")),
        "deployment_name": dep.get("name", ""),
        "deployment_type": dep.get("deployment_type", "online"),
        "problem_type":    asset.get("problem_type", ""),
        "approved":        risk.get("state") == "approved",
        "last_evaluated":  last_evaluated,
        "scoring":         {"last_eval": scoring_last_eval, "last_7d": scoring_last_7d},
        "tests":           tests,
        "explanations":    explanations,
        "monitors":        monitors_detail,
    }


# --------------------------------------------------------------------------
# GET /api/openscale/debug/{sub_id}  — raw API dump for diagnostics
# --------------------------------------------------------------------------
@router.get("/openscale/debug/{sub_id}")
async def debug_deployment(sub_id: str):
    """Return raw OpenScale API data for a subscription — use to diagnose metric parsing."""
    token = await _get_iam_token()

    mi_data = await _os_get(
        f"/monitor_instances?target.target_id={sub_id}&target.target_type=subscription",
        token,
    )
    monitors = _build_monitor_summary(mi_data.get("monitor_instances", []))

    result = {}
    for mon_id, info in monitors.items():
        iid = info["instance_id"]
        import datetime
        end_ts   = datetime.datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ")
        start_ts = (datetime.datetime.utcnow() - datetime.timedelta(days=30)).strftime("%Y-%m-%dT%H:%M:%SZ")

        run_data   = await _os_get(f"/monitor_instances/{iid}/runs?limit=1", token)
        run_entity = run_data.get("runs", [{}])[0].get("entity", {}) if run_data.get("runs") else {}
        run_id     = run_data.get("runs", [{}])[0].get("metadata", {}).get("id") if run_data.get("runs") else None

        meas_plain  = await _os_get(f"/monitor_instances/{iid}/measurements?limit=1", token)
        meas_range  = await _os_get(f"/monitor_instances/{iid}/measurements?start={start_ts}&end={end_ts}&limit=1", token)
        meas_run    = await _os_get(f"/monitor_instances/{iid}/measurements?run_id={run_id}&limit=50", token) if run_id else {}

        result[mon_id] = {
            "instance_id":         iid,
            "run_id":              run_id,
            "run_entity_keys":     list(run_entity.keys()),
            "run_status":          run_entity.get("status"),
            "run_metrics_sample":  str(run_entity.get("metrics", run_entity.get("results", [])))[:500],
            "meas_plain_keys":     list(meas_plain.keys()),
            "meas_plain_count":    len(meas_plain.get("measurements", [])),
            "meas_range_keys":     list(meas_range.keys()),
            "meas_range_count":    len(meas_range.get("measurements", [])),
            "meas_run_count":      len(meas_run.get("measurements", [])) if run_id else "no_run_id",
            "meas_plain_sample":   str(meas_plain.get("measurements", [{}])[0])[:600] if meas_plain.get("measurements") else "empty",
            "meas_range_sample":   str(meas_range.get("measurements", [{}])[0])[:600] if meas_range.get("measurements") else "empty",
            "meas_run_sample":     str(meas_run.get("measurements", [{}])[0])[:600] if meas_run.get("measurements") else "empty",
        }
    return result
