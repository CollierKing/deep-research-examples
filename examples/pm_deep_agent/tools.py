# MARK: - Imports/Dependencies
import os
from typing import List
from sqlalchemy import text
from langchain_core.messages import SystemMessage, HumanMessage
from langchain_openai import ChatOpenAI
from langchain_cloudflare import ChatCloudflareWorkersAI
from langchain_google_genai import ChatGoogleGenerativeAI

from utils import create_d1_engine

# MARK: - PARAMS
OPENAI_MODEL_SMALL = os.getenv("OPENAI_MODEL_SMALL", "gpt-4o-mini")
OPENAI_MODEL = os.getenv("OPENAI_MODEL_SMALL", "gpt-4o")

WORKERSAI_MODEL_FAST = os.getenv(
    "WORKERSAI_MODEL", "@cf/meta/llama-3.3-70b-instruct-fp8-fast"
)

GEMINI_MODEL_FAST = os.getenv("GEMINI_MODEL", "gemini-2.5-flash")
GEMINI_MODEL = os.getenv("GEMINI_MODEL", "gemini-2.5-pro")

# MARK: - CLIENTS
engine = create_d1_engine()


# MARK: - LLM
def _init_llm(model: str):
    """Pick a fast available model based on environment. Keep it simple and quick."""
    provider = os.getenv("RUN_PROVIDER") or os.getenv("SUMMARY_PROVIDER") or "openai"
    try:
        match provider:
            case "cloudflare":
                return ChatCloudflareWorkersAI(
                    model=model,
                    temperature=0.0,
                )
            case "gemini":
                return ChatGoogleGenerativeAI(
                    model=model,
                    temperature=0.0,
                )
            case _:
                # Default to OpenAI if available; relies on OPENAI_API_KEY
                return ChatOpenAI(
                    model=model,
                    temperature=0.0,
                )
    except Exception:
        return ChatOpenAI(model=model, temperature=0.0)


# _FAST_LLM = _init_llm(model=OPENAI_MODEL_SMALL)
# _SLOW_LLM = _init_llm(model=OPENAI_MODEL)
_FAST_LLM = _init_llm(model=GEMINI_MODEL_FAST)
_SLOW_LLM = _init_llm(model=GEMINI_MODEL)


# MARK: - Summarize
def _summarize_texts(product_name: str, src: str, texts: List[str], llm_fast: bool = False) -> str:
    """Single-pass concise summary of use-cases, personas, and problems."""
    if not texts:
        return "No content found to summarize."

        # Keep fast: sample and truncate
    # MAX_ROWS = 30    # MAX_CHARS_PER_TEXT = 400    # sample = [t[:MAX_CHARS_PER_TEXT] for t in texts[:MAX_ROWS]]
    joined = "\n\n---\n\n".join(texts)

    system = SystemMessage(
        content=(
            "You are a fast product-analysis summarizer. Extract succinct insights."
        )
    )
    human = HumanMessage(
        content=(
            f"Product: {product_name}\n"
            f"Source: {src}\n\n"
            "Given the short excerpts below, produce a concise markdown summary with three sections:\n"
            "## Use-cases\n- bullet list\n\n"
            "## User personas\n- bullet list (role/title, industry, team/function, company size if implied)\n\n"
            "## Problems solved\n- bullet list\n\n"
            "Be brief and high-signal.\n\n"
            f"Excerpts:\n{joined}"
        )
    )

    if llm_fast:
        llm = _FAST_LLM
    else:
        llm = _SLOW_LLM

    try:
        resp = llm.invoke([system, human])
        return getattr(resp, "content", str(resp))
    except Exception as e:
        print(str(e))
        # If LLM fails, return a minimal fallback summary
        head = "\n\n".join(texts[:5])
        return (
            "LLM summarization unavailable. Here are raw excerpts for reference:\n\n"
            f"{head}"
        )


# MARK: - Query Tool
def query_tool(src: str, product_name: str):
    """Fetch product-related texts and return a concise summary.

    Args:
        src: "marketing_content" | "social_media" (controls which table to query)
    product_name: Target product to filter on (substring match)
    Returns:
        dict with:
        - records: list of {text: str}
        - summary: markdown summary (use-cases, personas, problems)
        """
    match src:
        case "marketing_content":
            sql = f"""  
                SELECT summary as text                
                FROM content_summaries                
                WHERE product like '%{product_name.lower()}%'  
                """
        case "social_media":
            sql = f"""  
                SELECT text                
                FROM posts                
                WHERE products like '%{product_name.lower()}%'  
                ORDER BY RANDOM()                
                LIMIT 500                
                """

    with engine.connect() as conn:
        rows = conn.execute(text(sql)).fetchall()
        records = [dict(r._mapping) for r in rows]

    texts = [r.get("text", "") for r in records if r.get("text")]

    # Summarize query results
    summary = _summarize_texts(product_name=product_name, src=src, texts=texts, llm_fast=False)
    return {"summary": summary}
