from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from routes import webhook, workflows, resolve, openscale

app = FastAPI(title="WINGS Backend", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(webhook.router,   prefix="/webhook", tags=["Webhooks"])
app.include_router(workflows.router, prefix="/api",     tags=["Workflows"])
app.include_router(resolve.router,   prefix="/api",     tags=["Resolve"])
app.include_router(openscale.router, prefix="/api",     tags=["OpenScale"])

@app.get("/health")
def health():
    return {"status": "ok", "service": "wings-backend"}

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000, reload=True)
