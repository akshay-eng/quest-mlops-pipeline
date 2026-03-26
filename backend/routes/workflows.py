import os
import httpx
from fastapi import APIRouter, HTTPException, Query

router = APIRouter()

GITHUB_TOKEN = os.environ.get("GITHUB_TOKEN", "")
GITHUB_OWNER = os.environ.get("GITHUB_OWNER", "")
GITHUB_REPO  = os.environ.get("GITHUB_REPO", "quest-mlops-pipeline")

HEADERS = {
    "Authorization":        f"Bearer {GITHUB_TOKEN}",
    "Accept":               "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
}
BASE = "https://api.github.com"


def _run_to_summary(r: dict) -> dict:
    return {
        "id":          r["id"],
        "name":        r["name"],
        "status":      r["status"],
        "conclusion":  r["conclusion"],
        "branch":      r["head_branch"],
        "commit_sha":  r["head_sha"][:7],
        "created_at":  r["created_at"],
        "updated_at":  r["updated_at"],
        "html_url":    r["html_url"],
        "workflow_id": r["workflow_id"],
    }


@router.get("/workflows")
async def list_workflows(per_page: int = Query(20, le=100)):
    """List recent GitHub Actions workflow runs."""
    if not GITHUB_TOKEN or not GITHUB_OWNER:
        raise HTTPException(
            status_code=503,
            detail="GITHUB_TOKEN and GITHUB_OWNER env vars are not set"
        )

    url = f"{BASE}/repos/{GITHUB_OWNER}/{GITHUB_REPO}/actions/runs?per_page={per_page}"
    async with httpx.AsyncClient(timeout=20) as client:
        resp = await client.get(url, headers=HEADERS)

    if resp.status_code != 200:
        raise HTTPException(status_code=resp.status_code, detail=resp.text)

    runs = resp.json().get("workflow_runs", [])
    return [_run_to_summary(r) for r in runs]


@router.get("/workflows/{run_id}")
async def get_workflow(run_id: int):
    """Get details for a single workflow run including step statuses."""
    if not GITHUB_TOKEN or not GITHUB_OWNER:
        raise HTTPException(status_code=503, detail="GitHub credentials not configured")

    async with httpx.AsyncClient(timeout=20) as client:
        run_resp  = await client.get(
            f"{BASE}/repos/{GITHUB_OWNER}/{GITHUB_REPO}/actions/runs/{run_id}",
            headers=HEADERS
        )
        jobs_resp = await client.get(
            f"{BASE}/repos/{GITHUB_OWNER}/{GITHUB_REPO}/actions/runs/{run_id}/jobs",
            headers=HEADERS
        )

    if run_resp.status_code != 200:
        raise HTTPException(status_code=run_resp.status_code, detail=run_resp.text)

    run  = run_resp.json()
    jobs = jobs_resp.json() if jobs_resp.status_code == 200 else {}

    steps = []
    for job in jobs.get("jobs", []):
        for step in job.get("steps", []):
            steps.append({
                "name":         step["name"],
                "status":       step["status"],
                "conclusion":   step.get("conclusion"),
                "number":       step["number"],
                "started_at":   step.get("started_at"),
                "completed_at": step.get("completed_at"),
            })

    summary = _run_to_summary(run)
    summary["steps"] = steps
    return summary
