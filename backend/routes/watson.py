"""
IBM Watson X Orchestrate — streaming chat route
POST /api/investigate  { message, thread_id, agent_id }
"""

import os
import json
import logging
import httpx

from fastapi import APIRouter
from fastapi.responses import StreamingResponse

router = APIRouter()
logger = logging.getLogger(__name__)

IBM_API_KEY = os.environ.get("IBM_API_KEY", "7jzzR17TwFlvVlTn5_y_AuV_mrGYvyi8C0FKa-Sg3Iu3")
INSTANCE_ID = os.environ.get("WXO_INSTANCE_ID", "df327b39-2104-4b00-a1c2-4746cdf1767e")
BASE_URL    = f"https://api.us-south.watson-orchestrate.cloud.ibm.com/instances/{INSTANCE_ID}/v1"
DEFAULT_AGENT_ID = "2747d3ab-754e-4d03-85c2-1a023019ec6e"


async def _get_ibm_token() -> str:
    async with httpx.AsyncClient(timeout=15) as client:
        resp = await client.post(
            "https://iam.cloud.ibm.com/identity/token",
            headers={"Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json"},
            data={"grant_type": "urn:ibm:params:oauth:grant-type:apikey", "apikey": IBM_API_KEY},
        )
        resp.raise_for_status()
        return resp.json()["access_token"]


async def _watson_stream(user_text: str, thread_id: str | None, agent_id: str):
    try:
        token = await _get_ibm_token()
    except Exception as e:
        logger.error(f"IBM IAM token error: {e}")
        yield f"data: {json.dumps({'text': f'Error: IBM auth failed — {e}', 'thread_id': None})}\n\n"
        return

    payload: dict = {
        "message":  {"role": "user", "content": user_text},
        "agent_id": agent_id,
    }
    if thread_id:
        payload["thread_id"] = thread_id

    logger.info(f"WXO → agent={agent_id} thread={thread_id} msg={user_text[:80]!r}")

    try:
        async with httpx.AsyncClient(timeout=300) as client:
            async with client.stream(
                "POST",
                f"{BASE_URL}/orchestrate/runs/stream",
                headers={
                    "Authorization": f"Bearer {token}",
                    "Content-Type":  "application/json",
                    "Accept":        "application/json",
                },
                json=payload,
            ) as resp:
                if resp.status_code != 200:
                    err = await resp.aread()
                    logger.error(f"WXO HTTP {resp.status_code}: {err[:200]}")
                    yield f"data: {json.dumps({'text': f'Error from IBM: HTTP {resp.status_code}', 'thread_id': None})}\n\n"
                    return

                captured_thread = thread_id

                async for raw in resp.aiter_lines():
                    line = raw.strip()
                    if not line:
                        continue
                    logger.debug(f"RAW: {line}")

                    if line.startswith("data:"):
                        line = line[5:].strip()
                    if not line or line == "[DONE]":
                        continue

                    try:
                        obj = json.loads(line)
                    except json.JSONDecodeError:
                        continue

                    event    = obj.get("event", "")
                    obj_data = obj.get("data", {})

                    tid = obj_data.get("thread_id") or obj.get("thread_id")
                    if tid:
                        captured_thread = tid

                    text_chunk = ""
                    if event == "message.delta":
                        for part in obj_data.get("delta", {}).get("content", []):
                            if isinstance(part, dict) and part.get("response_type") == "text":
                                text_chunk += part.get("text", "")

                    if text_chunk or tid:
                        yield f"data: {json.dumps({'text': text_chunk, 'thread_id': captured_thread or ''})}\n\n"

                    if event in ("run.completed", "done"):
                        yield f"data: {json.dumps({'text': '', 'thread_id': captured_thread or '', 'done': True})}\n\n"
                        return

    except Exception as e:
        logger.error(f"WXO stream error: {e}")
        yield f"data: {json.dumps({'text': f'Error: {e}', 'thread_id': None})}\n\n"


@router.post("/investigate")
async def investigate(body: dict):
    user_text = body.get("message", "")
    thread_id = body.get("thread_id") or None
    agent_id  = body.get("agent_id") or DEFAULT_AGENT_ID

    return StreamingResponse(
        _watson_stream(user_text, thread_id, agent_id),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
