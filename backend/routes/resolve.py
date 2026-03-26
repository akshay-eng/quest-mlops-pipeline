"""
Resolve endpoint — streams SSE events to the WINGS frontend.

Watson X Orchestrate integration point:
  Set the env var  WATSONX_ORCHESTRATE_WEBHOOK_URL  to your IBM Watson X
  Orchestrate agent webhook. The endpoint will POST the run context to
  Orchestrate and then stream back progress events.

  If the env var is NOT set, the endpoint streams a simulated resolution
  log (useful for frontend development and demo mode).
"""

import os
import json
import asyncio
import httpx
from datetime import datetime, timezone
from fastapi import APIRouter
from fastapi.responses import StreamingResponse

router = APIRouter()

ORCHESTRATE_WEBHOOK = os.environ.get("WATSONX_ORCHESTRATE_WEBHOOK_URL", "")
GITHUB_TOKEN        = os.environ.get("GITHUB_TOKEN", "")
GITHUB_OWNER        = os.environ.get("GITHUB_OWNER", "")
GITHUB_REPO         = os.environ.get("GITHUB_REPO", "quest-mlops-pipeline")

GITHUB_HEADERS = {
    "Authorization":        f"Bearer {GITHUB_TOKEN}",
    "Accept":               "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
}


def _ts() -> str:
    return datetime.now(timezone.utc).strftime("%H:%M:%S")


def _evt(status: str, message: str) -> str:
    data = json.dumps({"timestamp": _ts(), "status": status, "message": message})
    return f"data: {data}\n\n"


async def _get_run_details(run_id: int) -> dict:
    """Fetch run + failed step info from GitHub."""
    base = "https://api.github.com"
    async with httpx.AsyncClient(timeout=20) as client:
        run_resp  = await client.get(
            f"{base}/repos/{GITHUB_OWNER}/{GITHUB_REPO}/actions/runs/{run_id}",
            headers=GITHUB_HEADERS
        )
        jobs_resp = await client.get(
            f"{base}/repos/{GITHUB_OWNER}/{GITHUB_REPO}/actions/runs/{run_id}/jobs",
            headers=GITHUB_HEADERS
        )

    run  = run_resp.json()  if run_resp.status_code  == 200 else {}
    jobs = jobs_resp.json() if jobs_resp.status_code == 200 else {}

    failed_steps = []
    for job in jobs.get("jobs", []):
        for step in job.get("steps", []):
            if step.get("conclusion") == "failure":
                failed_steps.append(step["name"])

    return {
        "name":         run.get("name", "Unknown workflow"),
        "branch":       run.get("head_branch", "main"),
        "commit_sha":   run.get("head_sha", "")[:7],
        "html_url":     run.get("html_url", ""),
        "conclusion":   run.get("conclusion", ""),
        "failed_steps": failed_steps,
    }


async def _classify_failure(failed_steps: list[str]) -> str:
    """Simple heuristic classification (Orchestrate will do the real RCA)."""
    names = " ".join(failed_steps).lower()
    if "ingestion" in names or "data" in names:
        return "auth_failure"
    if "install" in names or "dependency" in names or "training" in names:
        return "dependency_error"
    if "deploy" in names or "k8s" in names or "smoke" in names:
        return "deploy_failure"
    return "unknown"


# ---------------------------------------------------------------------------
# ORCHESTRATE STREAM  — calls Watson X Orchestrate and yields progress
# ---------------------------------------------------------------------------
async def _orchestrate_stream(run_id: int, run: dict):
    """Call Watson X Orchestrate webhook and stream its SSE response."""
    payload = {
        "run_id":        run_id,
        "workflow_name": run["name"],
        "branch":        run["branch"],
        "commit_sha":    run["commit_sha"],
        "html_url":      run["html_url"],
        "failed_steps":  run["failed_steps"],
    }

    yield _evt("running", "Calling IBM Watson X Orchestrate agent...")

    try:
        async with httpx.AsyncClient(timeout=300) as client:
            async with client.stream(
                "POST",
                ORCHESTRATE_WEBHOOK,
                json=payload,
                headers={"Content-Type": "application/json", "Accept": "text/event-stream"},
            ) as resp:
                if resp.status_code != 200:
                    yield _evt("error", f"Orchestrate returned HTTP {resp.status_code}")
                    yield _evt("done",  "Resolution ended with errors")
                    return

                async for line in resp.aiter_lines():
                    line = line.strip()
                    if not line.startswith("data:"):
                        continue
                    raw = line[5:].strip()
                    if not raw or raw == "[DONE]":
                        continue
                    # Forward the event straight to the browser
                    yield f"data: {raw}\n\n"

    except Exception as e:
        yield _evt("error", f"Orchestrate connection failed: {e}")
        yield _evt("done",  "Resolution ended with errors")


# ---------------------------------------------------------------------------
# DEMO STREAM  — simulated resolution log (used when Orchestrate is not set)
# ---------------------------------------------------------------------------
async def _demo_stream(run_id: int, run: dict, failure_type: str):
    """Simulated step-by-step resolution log for demos / frontend dev."""

    name = run.get("name", "Workflow")

    yield _evt("info",    f"Webhook received — workflow run #{run_id} FAILED")
    await asyncio.sleep(0.5)

    yield _evt("running", "Fetching run details from GitHub Actions...")
    await asyncio.sleep(0.8)
    yield _evt("ok",      f"Run details fetched · {name} · branch: {run['branch']}")
    await asyncio.sleep(0.3)

    if run["failed_steps"]:
        steps_str = ", ".join(run["failed_steps"][:3])
        yield _evt("ok", f"Failed steps identified: {steps_str}")
    else:
        yield _evt("ok", "Run context loaded")
    await asyncio.sleep(0.3)

    yield _evt("running", "Sending context to IBM Watson X Orchestrate for RCA...")
    await asyncio.sleep(2.2)

    rca_map = {
        "auth_failure":     ("auth_failure",     "MyQuest API token expired — data-ingestion step returned HTTP 401"),
        "dependency_error": ("dependency_error", "scikit-learn version conflict in requirements.txt"),
        "deploy_failure":   ("deploy_failure",   "kubectl: image pull failed — registry credentials outdated"),
        "unknown":          ("unknown",           "Step failure did not match known patterns — manual review needed"),
    }
    ft, root_cause = rca_map.get(failure_type, rca_map["unknown"])
    yield _evt("ok",   f"RCA complete — failure_type: {ft} · confidence: 95%")
    yield _evt("info", f"Root cause: {root_cause}")
    await asyncio.sleep(0.4)

    yield _evt("running", "ServiceNow agent creating incident via IBM Orchestrate...")
    await asyncio.sleep(1.2)
    yield _evt("ok",      "ServiceNow INC0042187 created (Priority 2 — High)")
    await asyncio.sleep(0.3)

    # Resolution step based on failure type
    if ft == "auth_failure":
        yield _evt("running", "Rotating GitHub secret: MYQUEST_API_TOKEN via GitHub API...")
        await asyncio.sleep(1.4)
        yield _evt("ok",      "MYQUEST_API_TOKEN rotated successfully")
        await asyncio.sleep(0.3)
        yield _evt("running", f"Retriggering workflow run #{run_id}...")
        await asyncio.sleep(1.0)
        yield _evt("ok",      "Workflow retriggered — new run queued on GitHub Actions")

    elif ft == "dependency_error":
        yield _evt("running", "Creating fix branch: fix/update-dependencies...")
        await asyncio.sleep(1.0)
        yield _evt("ok",      "requirements.txt patched — scikit-learn pinned to 1.4.2")
        yield _evt("running", "Creating pull request on GitHub...")
        await asyncio.sleep(0.8)
        yield _evt("ok",      f"PR #47 created: fix/update-scikit-learn-version → View on GitHub")

    elif ft == "deploy_failure":
        yield _evt("running", "Refreshing K8s registry secret: quest-registry-credentials...")
        await asyncio.sleep(1.2)
        yield _evt("ok",      "Registry credentials updated in namespace quest-diagnostics")
        yield _evt("running", f"Retriggering deployment workflow run #{run_id}...")
        await asyncio.sleep(0.8)
        yield _evt("ok",      "Deployment retriggered")

    else:
        yield _evt("running", "Escalating to on-call team via Orchestrate...")
        await asyncio.sleep(0.8)
        yield _evt("ok",      "On-call paged — ticket INC0042187 assigned to Quest MLOps Team")

    # Poll
    await asyncio.sleep(0.5)
    yield _evt("running", "Polling GitHub Actions for new run status...")
    for i in range(1, 4):
        await asyncio.sleep(2.0)
        yield _evt("running", f"Polling attempt {i}/3 — workflow in progress...")

    yield _evt("ok",      "New workflow run PASSED · Duration: 4m 28s")
    await asyncio.sleep(0.3)
    yield _evt("ok",      "Model artifact stored in watsonx.governance fact sheet")
    await asyncio.sleep(0.3)

    yield _evt("running", "Closing ServiceNow INC0042187...")
    await asyncio.sleep(0.8)
    yield _evt("ok",      "ServiceNow incident closed — resolution notes attached")
    await asyncio.sleep(0.3)

    yield _evt("done",    f"Resolution complete · MTTR: 3m 52s · All systems nominal ✦")


# ---------------------------------------------------------------------------
# ENDPOINT
# ---------------------------------------------------------------------------
@router.post("/workflows/{run_id}/resolve")
async def resolve_workflow(run_id: int):
    """Trigger WINGS agent resolution and stream progress as SSE.

    If WATSONX_ORCHESTRATE_WEBHOOK_URL is set → forwards to Watson X Orchestrate.
    Otherwise → streams a demo simulation (safe for local development).
    """
    async def _generate():
        try:
            # Fetch run context
            yield _evt("running", "Fetching run metadata from GitHub...")
            run = await _get_run_details(run_id)
            failure_type = await _classify_failure(run["failed_steps"])

            if ORCHESTRATE_WEBHOOK:
                async for chunk in _orchestrate_stream(run_id, run):
                    yield chunk
            else:
                async for chunk in _demo_stream(run_id, run, failure_type):
                    yield chunk

        except Exception as e:
            yield _evt("error", f"Unexpected error: {e}")
            yield _evt("done",  "Resolution failed")

    return StreamingResponse(
        _generate(),
        media_type="text/event-stream",
        headers={
            "Cache-Control":     "no-cache",
            "X-Accel-Buffering": "no",
        }
    )
