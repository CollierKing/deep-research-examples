"""
Utility functions for Deep Research Workflow.
"""

import json
import uuid
import httpx

# Gemini API base URLs
GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta"
GEMINI_UPLOAD_BASE = "https://generativelanguage.googleapis.com/upload/v1beta"


# MARK: - Job ID

def generate_job_id() -> str:
    """Generate a unique job ID using UUID."""
    return str(uuid.uuid4())


# MARK: - Document Formatting

def format_documents_as_text(documents: list, doc_type: str) -> str:
    """Format MongoDB documents as text for upload to FileStore."""
    lines = [f"=== {doc_type.upper()} ===\n"]

    for i, doc in enumerate(documents, 1):
        lines.append(f"\n--- Document {i} ---")
        lines.append(f"Symbol: {doc.get('symbol', 'N/A')}")
        lines.append(f"Date: {doc.get('date', 'N/A')}")

        if doc_type == "earnings_transcript":
            lines.append(f"Title: {doc.get('title', 'N/A')}")
            if doc.get('content'):
                lines.append(f"\nContent:\n{doc['content']}")
        elif doc_type == "press_release":
            lines.append(f"Title: {doc.get('pr_title', 'N/A')}")
            if doc.get('pr_link'):
                lines.append(f"Link: {doc['pr_link']}")
            if doc.get('content'):
                lines.append(f"\nContent:\n{doc['content']}")

        lines.append("\n")

    return "\n".join(lines)


# MARK: - MongoDB Helpers

async def query_mongodb(
    client: httpx.AsyncClient,
    mongodb_url: str,
    auth_token: str,
    query: dict,
    req_fields: list[str],
    sort: dict = None,
    limit: int = None
) -> list:
    """Query MongoDB via the mongodb-worker."""
    payload = {
        "dbName": "ccdb",
        "colName": "documents",
        "query": query,
        "reqFields": req_fields
    }
    if sort:
        payload["sort"] = sort
    if limit:
        payload["limit"] = limit

    response = await client.post(
        mongodb_url,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {auth_token}"
        },
        json=payload
    )
    return response.json() if response.status_code == 200 else []


# MARK: - Gemini File Upload

async def upload_file_to_gemini(
    client: httpx.AsyncClient,
    api_key: str,
    content: bytes,
    display_name: str
) -> str:
    """Upload a file to Gemini using resumable upload protocol. Returns file name."""
    upload_url = f"{GEMINI_UPLOAD_BASE}/files?key={api_key}"

    # Step 1: Initiate upload
    init_response = await client.post(
        upload_url,
        headers={
            "X-Goog-Upload-Protocol": "resumable",
            "X-Goog-Upload-Command": "start",
            "X-Goog-Upload-Header-Content-Length": str(len(content)),
            "X-Goog-Upload-Header-Content-Type": "text/plain",
            "Content-Type": "application/json"
        },
        json={"file": {"displayName": display_name}}
    )
    init_response.raise_for_status()

    # Step 2: Upload content to the returned URL
    resumable_url = init_response.headers.get("X-Goog-Upload-URL")
    upload_response = await client.post(
        resumable_url,
        headers={
            "X-Goog-Upload-Command": "upload, finalize",
            "X-Goog-Upload-Offset": "0",
            "Content-Type": "text/plain"
        },
        content=content
    )
    upload_response.raise_for_status()

    file_data = upload_response.json()
    return file_data["file"]["name"]


async def add_file_to_store(
    client: httpx.AsyncClient,
    api_key: str,
    filestore_name: str,
    file_name: str
) -> dict:
    """Add a file to a Gemini FileSearchStore using importFile endpoint.

    Returns the operation response immediately. Caller can poll operation
    if needed using poll_operation().

    Note: Gemini file search typically handles pending files gracefully,
    so polling may not be required before starting research.
    """
    import_url = f"{GEMINI_API_BASE}/{filestore_name}:importFile?key={api_key}"
    response = await client.post(import_url, json={"fileName": file_name})
    response.raise_for_status()
    return response.json()


async def get_filestore_status(
    client: httpx.AsyncClient,
    api_key: str,
    filestore_name: str
) -> dict:
    """Get FileSearchStore status including document counts.

    Returns dict with:
        - activeDocumentsCount: Files ready for retrieval
        - pendingDocumentsCount: Files being processed
        - failedDocumentsCount: Files that failed processing

    For use within Cloudflare Workflows, call this in a loop with step.sleep()
    between attempts to wait for all files to be active.
    """
    url = f"{GEMINI_API_BASE}/{filestore_name}?key={api_key}"
    response = await client.get(url)
    response.raise_for_status()
    return response.json()


async def create_filestore(
    client: httpx.AsyncClient,
    api_key: str,
    display_name: str
) -> str:
    """Create a Gemini FileSearchStore. Returns the store name."""
    create_store_url = f"{GEMINI_API_BASE}/fileSearchStores?key={api_key}"
    response = await client.post(
        create_store_url,
        json={"displayName": display_name}
    )
    response.raise_for_status()
    return response.json()["name"]


# MARK: - Cloudflare Workflows API

async def get_workflow_instance_details(
    client: httpx.AsyncClient,
    account_id: str,
    api_token: str,
    workflow_name: str,
    instance_id: str
) -> dict:
    """Fetch workflow instance details from Cloudflare REST API."""
    url = f"https://api.cloudflare.com/client/v4/accounts/{account_id}/workflows/{workflow_name}/instances/{instance_id}"
    response = await client.get(
        url,
        headers={"Authorization": f"Bearer {api_token}"}
    )
    if response.status_code == 200:
        data = response.json()
        return data.get("result", {})
    return {"error": f"Failed to fetch instance: {response.status_code}"}


# MARK: - Row to Dict Helpers

def job_status_row_to_dict(row) -> dict:
    """Convert a job status query row to a dictionary."""
    return {
        "job_id": row[0],
        "ticker": row[1],
        "earnings_date": row[2],
        "status": row[3],
        "workflow_id": row[4],
        "gemini_interaction_id": row[5],
        "transcript_count": row[6],
        "press_release_count": row[7],
        "error_message": row[8],
        "created_at": row[9],
        "updated_at": row[10],
        "completed_at": row[11]
    }


def job_result_row_to_dict(row) -> dict:
    """Convert a job result query row to a dictionary."""
    return {
        "job_id": row[0],
        "ticker": row[1],
        "earnings_date": row[2],
        "status": row[3],
        "result_text": row[4],
        "error_message": row[5]
    }


def job_list_row_to_dict(row) -> dict:
    """Convert a job list query row to a dictionary."""
    return {
        "job_id": row[0],
        "ticker": row[1],
        "earnings_date": row[2],
        "status": row[3],
        "transcript_count": row[4],
        "press_release_count": row[5],
        "created_at": row[6],
        "updated_at": row[7],
        "completed_at": row[8]
    }
