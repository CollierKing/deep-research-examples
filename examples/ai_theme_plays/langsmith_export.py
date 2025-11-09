# save as download_langsmith_runs.py
import os
import json

from dotenv import load_dotenv, find_dotenv

from langsmith import Client
from typing import Iterable


# Set LANGSMITH_API_KEY in your env, or pass it into Client(...)
# export LANGSMITH_API_KEY="ls_..."
# optionally set LANGSMITH_WORKSPACE_ID if using an org-scoped key.

def iter_runs(client: Client, project_name: str = None, **kwargs) -> Iterable[dict]:
    """
    Yield run objects returned by client.list_runs.
    The client handles pagination; we iterate through returned runs.
    Pass filters like: filter='eq(name, "my-run")', select=["inputs","outputs"], limit=100
    """
    # list_runs returns an iterable / list of run objects
    for run in client.list_runs(project_name=project_name, **kwargs):
        yield run


def download_runs_to_jsonl(out_path: str, project_name: str = None, limit: int = 1000, filter: str = None):
    api_key = os.getenv("LANGSMITH_API_KEY")
    if not api_key:
        raise RuntimeError("Please set LANGSMITH_API_KEY in your environment.")

    client = Client(api_key=api_key)

    # Example: query only runs with errors OR a name filter or date filters:
    # runs_iter = iter_runs(client, project_name="default", filter='eq(run_type,"chain")', limit=500)
    runs_iter = iter_runs(client, project_name=project_name, filter=filter, limit=limit)

    with open(out_path, "w", encoding="utf-8") as fh:
        for run in runs_iter:
            # `run` is a SDK object. You can either:
            # 1) fetch the canonical/read version by id to ensure full data:
            try:
                full = client.read_run(run.id)  # returns the run record with details
            except Exception:
                # fallback: try using the run object directly
                full = run

            # Convert to JSON-serializable structure.
            # SDK objects usually have `.dict()` or `.json()`; fallback to builtins.
            try:
                payload = full.dict()
            except Exception:
                # best-effort fallback
                payload = json.loads(json.dumps(full, default=lambda o: getattr(o, "__dict__", str(o))))

            fh.write(json.dumps(payload, default=str) + "\n")

    print(f"Wrote runs to {out_path}")


if __name__ == "__main__":
    load_dotenv(find_dotenv(), override=False)
    # writes runs.jsonl containing one JSON run per line

    thread_id = "run_2025_11_05_003821_gemini_2.5_pro"
    download_runs_to_jsonl(
        out_path="runs.jsonl",
        project_name="deepagents-ai-theme-plays",
        limit=2000,
        filter=f'eq(thread_id, "{thread_id}")'
    )
