from fastapi import APIRouter, Request
import json

router = APIRouter()

# In-memory store: run_id (str) -> failure metadata
# In production replace with Redis or a DB.
active_failures: dict[str, dict] = {}


@router.post("/github")
async def github_webhook(request: Request):
    """Receive GitHub Actions webhook events.

    Set up in GitHub repo → Settings → Webhooks:
      Payload URL : http://<your-server>:8000/webhook/github
      Content type: application/json
      Events      : Workflow runs
    """
    payload = await request.json()
    event   = request.headers.get("X-GitHub-Event", "")

    if event == "workflow_run" and payload.get("action") == "completed":
        run = payload["workflow_run"]
        if run["conclusion"] == "failure":
            run_id = str(run["id"])
            active_failures[run_id] = {
                "run_id":        run["id"],
                "workflow_name": run["name"],
                "branch":        run["head_branch"],
                "commit_sha":    run["head_sha"][:7],
                "created_at":    run["created_at"],
                "html_url":      run["html_url"],
                "status":        "failed",
            }
            print(f"[webhook] Failure recorded — run #{run_id} · {run['name']}")

    return {"received": True}


@router.get("/github/failures")
def list_failures():
    """Return all currently tracked failures (for debugging)."""
    return list(active_failures.values())
