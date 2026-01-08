"""
Deep Research Workflow

Queries MongoDB for earnings transcripts and press releases,
uploads to Google FileStore, runs Gemini Deep Research,
and saves results to D1.
"""

# MARK: - Imports

import json
import asyncio
from datetime import datetime
from urllib.parse import urlparse

import httpx
from workers import WorkerEntrypoint, Response, WorkflowEntrypoint

from sqlalchemy import select, insert, update
from sqlalchemy_cloudflare_d1 import create_engine_from_binding

from langchain.agents import create_agent
from langchain_cloudflare import ChatCloudflareWorkersAI

from schemas import deep_research_jobs
from prompts import build_research_prompt, ALIGNMENT_EXTRACTION_PROMPT
from models import AlignmentAnalysis
from utils import (
    GEMINI_API_BASE,
    generate_job_id,
    format_documents_as_text,
    upload_file_to_gemini,
    add_file_to_store,
    create_filestore,
    get_filestore_status,
    job_status_row_to_dict,
    job_result_row_to_dict,
    job_list_row_to_dict,
)

# MARK: - Constants

DEEP_RESEARCH_AGENT = "deep-research-pro-preview-12-2025"
MAX_POLL_ATTEMPTS = 120  # Max attempts (at ~30s intervals = ~1 hour max)
POLL_INTERVAL_SECONDS = 30

# Workers AI model for structured output extraction
WORKERS_AI_MODEL = "@cf/qwen/qwen3-30b-a3b-fp8"
AI_GATEWAY_ID = "cc_ai_gateway"


# MARK: - DeepResearchWorkflow

class DeepResearchWorkflow(WorkflowEntrypoint):
    """
    Workflow for running deep research on earnings transcripts and press releases.

    Steps:
    1. fetch_and_upload - Query MongoDB and upload to Google FileStore
    2. start_research - Kick off Gemini Deep Research
    3. poll_for_result - Wait for research to complete
    4. save_result - Save results to D1
    """

    # MARK: run

    async def run(self, event, step):
        # Extract parameters from workflow event
        params = event.get("payload", event)
        job_id = params["job_id"]
        ticker = params["ticker"]
        earnings_date = params["earnings_date"]

        print(f"[WORKFLOW] Starting job_id={job_id} ticker={ticker} earnings_date={earnings_date}")

        # Initialize config from environment
        google_api_key = self.env.GOOGLE_API_KEY

        # Generate R2 prefix: timestamp_ticker (sortable, human-readable)
        r2_timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        r2_prefix = f"{r2_timestamp}_{ticker}"

        # MARK: - STEP fetch_and_upload
        @step.do("fetch_and_upload")
        async def fetch_and_upload():
            """Fetch data from MongoDB and upload to Google FileStore."""
            print(f"[STEP fetch_and_upload] Fetching data for {ticker}")

            # Fetch latest earnings transcript via RPC
            # Note: Python dicts must be JSON-stringified for TypeScript RPC
            transcripts = await self.env.MONGODB_WORKER.query(
                "ccdb",
                "documents",
                json.dumps({"doc_type": "earnings_transcript", "symbol": ticker.upper()}),
                ["symbol", "date", "title", "content"],
                json.dumps({"sort": {"date": -1}, "limit": 1})
            )
            print(f"[STEP fetch_and_upload] Found {len(transcripts)} transcripts")

            # Get the earnings date from the latest transcript
            latest_earnings_date = transcripts[0]["date"] if transcripts else None
            print(f"[STEP fetch_and_upload] Latest earnings date: {latest_earnings_date}")

            # Fetch press releases after earnings date via RPC
            press_releases = []
            if latest_earnings_date:
                press_releases = await self.env.MONGODB_WORKER.query(
                    "ccdb",
                    "documents",
                    json.dumps({
                        "doc_type": "press_release",
                        "symbol": ticker.upper(),
                        "date": {"$gt": latest_earnings_date},
                        "announcements": {"$exists": True, "$nin": [None,[]]}
                    }),
                    ["symbol", "date", "pr_title", "pr_link", "content", "announcements"]
                )
            print(f"[STEP fetch_and_upload] Found {len(press_releases)} press releases")

            # Update D1 with status and counts
            engine = create_engine_from_binding(self.env.D1)
            with engine.connect() as conn:
                stmt = (
                    update(deep_research_jobs)
                    .where(deep_research_jobs.c.job_id == job_id)
                    .values(
                        status='running',
                        transcript_count=len(transcripts),
                        press_release_count=len(press_releases),
                        updated_at=datetime.utcnow().isoformat()
                    )
                )
                conn.execute(stmt)
                conn.commit()

            # Format documents as text
            transcript_text = format_documents_as_text(transcripts, "earnings_transcript") if transcripts else None
            pr_text = format_documents_as_text(press_releases, "press_release") if press_releases else None

            # Save to R2 for debugging/verification (parallel uploads)
            print(f"[STEP fetch_and_upload] Saving to R2 bucket: {r2_prefix}/")
            r2_tasks = []
            if transcript_text:
                r2_tasks.append(self.env.R2.put(f"{r2_prefix}/INPUT_earnings_transcript.txt", transcript_text))
            if pr_text:
                r2_tasks.append(self.env.R2.put(f"{r2_prefix}/INPUT_press_releases.txt", pr_text))
            if r2_tasks:
                await asyncio.gather(*r2_tasks)
                print(f"[STEP fetch_and_upload] Saved {len(r2_tasks)} files to R2: {r2_prefix}/")

            # Upload to Google FileStore
            print(f"[STEP fetch_and_upload] Uploading to Gemini FileStore")
            async with httpx.AsyncClient(timeout=120.0) as client:
                filestore_name = await create_filestore(client, google_api_key, f"research_{job_id}")
                print(f"[STEP fetch_and_upload] Created filestore: {filestore_name}")

                # Upload transcript if exists
                if transcript_text:
                    file_name = await upload_file_to_gemini(
                        client, google_api_key,
                        transcript_text.encode("utf-8"),
                        "earnings_transcript.txt"
                    )
                    await add_file_to_store(client, google_api_key, filestore_name, file_name)
                    print(f"[STEP fetch_and_upload] Uploaded transcript: {file_name}")

                # Upload press releases if exist
                if pr_text:
                    file_name = await upload_file_to_gemini(
                        client, google_api_key,
                        pr_text.encode("utf-8"),
                        "press_releases.txt"
                    )
                    await add_file_to_store(client, google_api_key, filestore_name, file_name)
                    print(f"[STEP fetch_and_upload] Uploaded press releases: {file_name}")

            # Update D1 with filestore name
            with engine.connect() as conn:
                stmt = (
                    update(deep_research_jobs)
                    .where(deep_research_jobs.c.job_id == job_id)
                    .values(filestore_name=filestore_name, updated_at=datetime.utcnow().isoformat())
                )
                conn.execute(stmt)
                conn.commit()

            return {"filestore_name": filestore_name}

        # MARK: - Poll for files to be processed
        upload_result = await fetch_and_upload()
        filestore_name = upload_result["filestore_name"]

        # Wait for all files to be active (max 30 attempts @ 2s = 60s)
        MAX_FILE_POLL_ATTEMPTS = 30
        FILE_POLL_INTERVAL_SECONDS = 2

        for file_attempt in range(MAX_FILE_POLL_ATTEMPTS):
            @step.do(f"check_files_{file_attempt}")
            async def check_files_ready():
                """Check if all files in FileStore are active."""
                print(f"[STEP check_files] Checking file status attempt {file_attempt + 1}/{MAX_FILE_POLL_ATTEMPTS}")
                async with httpx.AsyncClient(timeout=30.0) as client:
                    status = await get_filestore_status(client, google_api_key, filestore_name)
                    pending = status.get("pendingDocumentsCount", 0)
                    active = status.get("activeDocumentsCount", 0)
                    failed = status.get("failedDocumentsCount", 0)
                    print(f"[STEP check_files] active={active} pending={pending} failed={failed}")
                    return {"pending": pending, "active": active, "failed": failed}

            file_status = await check_files_ready()

            if file_status["pending"] == 0:
                print(f"[WORKFLOW] All files processed: {file_status['active']} active, {file_status['failed']} failed")
                break

            await step.sleep(f"wait_for_files_{file_attempt}", f"{FILE_POLL_INTERVAL_SECONDS} seconds")

        # MARK: - STEP start_research
        @step.do("start_research")
        async def start_research():
            """Start the Gemini Deep Research interaction."""
            print(f"[STEP start_research] Starting Gemini Deep Research")
            prompt = build_research_prompt(ticker, earnings_date)

            async with httpx.AsyncClient(timeout=60.0) as client:
                interactions_url = f"{GEMINI_API_BASE}/interactions?key={google_api_key}"
                response = await client.post(
                    interactions_url,
                    json={
                        "input": prompt,
                        "agent": DEEP_RESEARCH_AGENT,
                        "background": True,
                        "tools": [{"type": "file_search", "fileSearchStoreNames": [filestore_name]}]
                    }
                )
                response.raise_for_status()
                interaction_id = response.json()["id"]
                print(f"[STEP start_research] Created interaction: {interaction_id}")

            # Update D1 with interaction ID
            engine = create_engine_from_binding(self.env.D1)
            with engine.connect() as conn:
                stmt = (
                    update(deep_research_jobs)
                    .where(deep_research_jobs.c.job_id == job_id)
                    .values(
                        gemini_interaction_id=interaction_id,
                        status='polling',
                        updated_at=datetime.utcnow().isoformat()
                    )
                )
                conn.execute(stmt)
                conn.commit()

            return {"interaction_id": interaction_id}

        # MARK: - STEP poll_for_result
        research_data = await start_research()
        interaction_id = research_data["interaction_id"]

        poll_result = None
        for attempt in range(MAX_POLL_ATTEMPTS):
            @step.do(f"check_status_{attempt}")
            async def check_status():
                """Check if Gemini research is complete."""
                print(f"[STEP poll] Checking status attempt {attempt + 1}/{MAX_POLL_ATTEMPTS}")
                async with httpx.AsyncClient(timeout=30.0) as client:
                    get_url = f"{GEMINI_API_BASE}/interactions/{interaction_id}?key={google_api_key}"
                    response = await client.get(get_url)
                    response.raise_for_status()
                    data = response.json()

                    status = data.get("status", "").lower()
                    print(f"[STEP poll] Status: {status}")

                    if status == "completed":
                        outputs = data.get("outputs", [])
                        result_text = outputs[-1].get("text", "") if outputs else ""
                        return {"status": "completed", "result_text": result_text}
                    elif status == "failed":
                        return {"status": "failed", "error": str(data.get("error", "Unknown error"))}
                    else:
                        return {"status": "pending"}

            poll_result = await check_status()

            if poll_result["status"] in ("completed", "failed"):
                break

            await step.sleep(f"wait_for_result_{attempt}", f"{POLL_INTERVAL_SECONDS} seconds")

        # Handle timeout
        if poll_result["status"] == "pending":
            poll_result = {
                "status": "failed",
                "error": f"Timed out after {MAX_POLL_ATTEMPTS * POLL_INTERVAL_SECONDS} seconds"
            }

        # MARK: - STEP extract_structured_output
        @step.do("extract_structured_output")
        async def extract_structured_output():
            """Extract structured alignment analysis from the result using Workers AI and create_agent."""
            if poll_result["status"] != "completed":
                print(f"[STEP extract_structured_output] Skipping - status is {poll_result['status']}")
                return {"alignment_items": []}

            result_text = poll_result.get("result_text", "")
            if not result_text:
                print("[STEP extract_structured_output] No result text to extract from")
                return {"alignment_items": []}

            print("[STEP extract_structured_output] Extracting alignment analysis with create_agent")

            try:
                # Initialize langchain-cloudflare LLM using AI binding
                llm = ChatCloudflareWorkersAI(
                    binding=self.env.AI,
                    model=WORKERS_AI_MODEL,
                    temperature=0.0,
                    ai_gateway="cc_ai_gateway"
                )

                # Create agent with structured output using create_agent pattern
                agent = create_agent(
                    model=llm,
                    response_format=AlignmentAnalysis,
                    system_prompt=ALIGNMENT_EXTRACTION_PROMPT,
                    tools=[],
                )

                # Invoke agent with the report text
                result = await agent.ainvoke({
                    "messages": [{"role": "user", "content": result_text}]
                })

                # Extract structured response from agent result
                if result and isinstance(result, dict) and "structured_response" in result:
                    structured_data = result["structured_response"]
                    if hasattr(structured_data, "items"):
                        items = [item.model_dump() if hasattr(item, "model_dump") else item for item in structured_data.items]
                    elif isinstance(structured_data, dict) and "items" in structured_data:
                        items = structured_data["items"]
                    else:
                        items = []
                    print(f"[STEP extract_structured_output] Extracted {len(items)} alignment items")
                    return {"alignment_items": items}
                else:
                    print(f"[STEP extract_structured_output] Unexpected result type: {type(result)}")
                    return {"alignment_items": []}

            except Exception as e:
                print(f"[STEP extract_structured_output] Error: {type(e).__name__}: {e}")
                return {"alignment_items": [], "error": str(e)}

        extraction_result = await extract_structured_output()

        # MARK: - STEP save_result
        @step.do("save_result")
        async def save_result():
            """Save the final result to D1 and workflow details to R2."""
            print(f"[STEP save_result] Saving result with status: {poll_result['status']}")
            now = datetime.utcnow().isoformat()

            # MARK: - Save result to D1
            engine = create_engine_from_binding(self.env.D1)
            with engine.connect() as conn:
                values = {
                    "status": poll_result["status"],
                    "completed_at": now,
                    "updated_at": now
                }
                if poll_result["status"] == "completed":
                    values["result_text"] = poll_result.get("result_text", "")
                else:
                    values["error_message"] = poll_result.get("error", "Unknown error")

                stmt = (
                    update(deep_research_jobs)
                    .where(deep_research_jobs.c.job_id == job_id)
                    .values(**values)
                )
                conn.execute(stmt)
                conn.commit()

            # MARK: - Save outputs to R2
            r2_tasks = []

            # Save result text
            result_text = poll_result.get("result_text", "")
            if result_text:
                print(f"[STEP save_result] Saving result text to R2: {r2_prefix}/")
                r2_tasks.append(self.env.R2.put(f"{r2_prefix}/OUTPUT_result.md", result_text))

            # Save structured alignment items as JSON
            alignment_items = extraction_result.get("alignment_items", [])
            if alignment_items:
                alignment_json = json.dumps(alignment_items, indent=2)
                print(f"[STEP save_result] Saving {len(alignment_items)} alignment items to R2")
                r2_tasks.append(self.env.R2.put(f"{r2_prefix}/OUTPUT_alignment_items.json", alignment_json))

            if r2_tasks:
                await asyncio.gather(*r2_tasks)

            # MARK: - Upsert to Postgres via Hyperdrive Worker RPC
            if alignment_items and poll_result["status"] == "completed":
                print(f"[STEP save_result] Upserting to Postgres via Hyperdrive Worker RPC")
                report_date = now.split("T")[0]  # Extract date from ISO timestamp

                try:
                    hyperdrive_result = await self.env.HYPERDRIVE_WORKER.upsert(
                        table="cc_research_ticker",
                        data=[{
                            "ticker": ticker,
                            "title": f"Earnings/PR Analysis - {report_date}",
                            "category": "Earnings/PRs",
                            "location": {
                                "bucket": "deepresearch-workflows",
                                "key": f"{r2_prefix}/OUTPUT_result.md"
                            },
                            "link": None,
                            "structuredOutput": alignment_items,
                            "metadata": None,
                            "createdAt": now.replace("T", " "),
                            "updatedAt": now.replace("T", " "),
                        }],
                        conflictColumns=["ticker", "title", "category"]
                    )
                    print(f"[STEP save_result] Hyperdrive upsert result: {hyperdrive_result}")
                except Exception as e:
                    print(f"[STEP save_result] Hyperdrive upsert error: {type(e).__name__}: {e}")

            return {"job_id": job_id, "status": poll_result["status"], "completed_at": now}

        await save_result()
        # Return None to avoid serialization issues with Proxy objects
        return None


# MARK: - Default HTTP Entrypoint

class Default(WorkerEntrypoint):
    """HTTP entry point for the Deep Research workflow."""

    # MARK: verify_auth

    def verify_auth(self, request) -> bool:
        """Verify Bearer token authentication."""
        auth_header = request.headers.get("Authorization")
        if not auth_header:
            return False
        parts = auth_header.split(" ")
        if len(parts) != 2 or parts[0] != "Bearer":
            return False
        return parts[1] == self.env.AUTH_TOKEN

    # MARK: get_engine

    def get_engine(self):
        """Get SQLAlchemy engine for D1."""
        return create_engine_from_binding(self.env.D1)

    # MARK: fetch

    async def fetch(self, request):
        url = urlparse(request.url)
        print(f"[HTTP] {request.method} {url.path}")

        # Verify authentication for all routes
        if not self.verify_auth(request):
            print(f"[HTTP] Unauthorized request to {url.path}")
            return Response.json({"error": "Unauthorized"}, status=401)

        # MARK: POST /research
        if url.path == "/research" and request.method == "POST":
            try:
                data = json.loads(await request.text())
                ticker = data.get("ticker")
                earnings_date = data.get("earnings_date")

                if not ticker or not earnings_date:
                    return Response.json({"error": "Missing required fields: ticker, earnings_date"}, status=400)

                job_id = generate_job_id()
                now = datetime.utcnow().isoformat()
                print(f"[HTTP] POST /research ticker={ticker} earnings_date={earnings_date} job_id={job_id}")

                engine = self.get_engine()
                with engine.connect() as conn:
                    stmt = insert(deep_research_jobs).values(
                        job_id=job_id, ticker=ticker.upper(), earnings_date=earnings_date,
                        status='pending', created_at=now, updated_at=now
                    )
                    conn.execute(stmt)
                    conn.commit()

                workflow = await self.env.DEEP_RESEARCH_WORKFLOW.create(
                    params={"job_id": job_id, "ticker": ticker.upper(), "earnings_date": earnings_date}
                )

                with engine.connect() as conn:
                    stmt = (
                        update(deep_research_jobs)
                        .where(deep_research_jobs.c.job_id == job_id)
                        .values(workflow_id=workflow.id, updated_at=now)
                    )
                    conn.execute(stmt)
                    conn.commit()

                return Response.json({
                    "job_id": job_id, "workflow_id": workflow.id,
                    "status": "pending", "message": "Research job started"
                })

            except Exception as e:
                print(f"[HTTP] POST /research ERROR: {type(e).__name__}: {e}")
                return Response.json({"error": str(e), "error_type": type(e).__name__}, status=500)

        # MARK: GET /status
        if url.path.startswith("/status/"):
            job_id = url.path.split("/")[-1]
            try:
                engine = self.get_engine()
                with engine.connect() as conn:
                    stmt = (
                        select(
                            deep_research_jobs.c.job_id, deep_research_jobs.c.ticker,
                            deep_research_jobs.c.earnings_date, deep_research_jobs.c.status,
                            deep_research_jobs.c.workflow_id, deep_research_jobs.c.gemini_interaction_id,
                            deep_research_jobs.c.transcript_count, deep_research_jobs.c.press_release_count,
                            deep_research_jobs.c.error_message, deep_research_jobs.c.created_at,
                            deep_research_jobs.c.updated_at, deep_research_jobs.c.completed_at
                        )
                        .where(deep_research_jobs.c.job_id == job_id)
                    )
                    row = conn.execute(stmt).fetchone()

                if not row:
                    return Response.json({"error": "Job not found"}, status=404)
                return Response.json(job_status_row_to_dict(row))

            except Exception as e:
                return Response.json({"error": str(e), "error_type": type(e).__name__}, status=500)

        # MARK: GET /result
        if url.path.startswith("/result/"):
            job_id = url.path.split("/")[-1]
            try:
                engine = self.get_engine()
                with engine.connect() as conn:
                    stmt = select(
                        deep_research_jobs.c.job_id, deep_research_jobs.c.ticker,
                        deep_research_jobs.c.earnings_date, deep_research_jobs.c.status,
                        deep_research_jobs.c.result_text, deep_research_jobs.c.error_message
                    ).where(deep_research_jobs.c.job_id == job_id)
                    row = conn.execute(stmt).fetchone()

                if not row:
                    return Response.json({"error": "Job not found"}, status=404)
                return Response.json(job_result_row_to_dict(row))

            except Exception as e:
                return Response.json({"error": str(e), "error_type": type(e).__name__}, status=500)

        # MARK: GET /jobs
        if url.path == "/jobs":
            try:
                query_string = url.query if url.query else ""
                params = dict(p.split("=") for p in query_string.split("&") if "=" in p)
                status_filter = params.get("status")
                ticker_filter = params.get("ticker")

                engine = self.get_engine()
                with engine.connect() as conn:
                    stmt = select(
                        deep_research_jobs.c.job_id, deep_research_jobs.c.ticker,
                        deep_research_jobs.c.earnings_date, deep_research_jobs.c.status,
                        deep_research_jobs.c.transcript_count, deep_research_jobs.c.press_release_count,
                        deep_research_jobs.c.created_at, deep_research_jobs.c.updated_at,
                        deep_research_jobs.c.completed_at
                    )
                    if status_filter:
                        stmt = stmt.where(deep_research_jobs.c.status == status_filter)
                    if ticker_filter:
                        stmt = stmt.where(deep_research_jobs.c.ticker == ticker_filter.upper())
                    stmt = stmt.order_by(deep_research_jobs.c.created_at.desc()).limit(100)
                    rows = conn.execute(stmt).fetchall()

                jobs = [job_list_row_to_dict(row) for row in rows]
                return Response.json({"count": len(jobs), "jobs": jobs})

            except Exception as e:
                return Response.json({"error": str(e), "error_type": type(e).__name__}, status=500)

        # MARK: GET /workflow-status
        if url.path.startswith("/workflow-status/"):
            workflow_id = url.path.split("/")[-1]
            try:
                workflow = await self.env.DEEP_RESEARCH_WORKFLOW.get(workflow_id)
                status_future = workflow.status()
                # status() returns a PyodideFuture, need to await it properly
                status = await status_future
                # If still a future, try to get result
                if hasattr(status, '_result'):
                    status = status._result
                if hasattr(status, 'result') and callable(status.result):
                    try:
                        status = status.result()
                    except:
                        pass
                print(f"[DEBUG] final status type: {type(status)}")
                print(f"[DEBUG] final status: {status}")
                # Try to convert to JSON-serializable format
                if hasattr(status, 'to_py'):
                    status = status.to_py()
                return Response.json({"workflow_status": status})
            except Exception as e:
                import traceback
                return Response.json({
                    "error": str(e),
                    "error_type": type(e).__name__,
                    "traceback": traceback.format_exc()
                }, status=500)

        # MARK: Default response
        return Response(
            "Deep Research Workflow API\n"
            "===========================\n\n"
            "Endpoints:\n"
            "  POST /research              - Start research job {ticker, earnings_date}\n"
            "  GET  /status/{job_id}       - Get job status\n"
            "  GET  /result/{job_id}       - Get full result\n"
            "  GET  /jobs                  - List all jobs (?status=X&ticker=Y)\n"
            "  GET  /workflow-status/{id}  - Get Cloudflare workflow status\n"
        )
