# MARK: - Imports
from langchain_core.tools import tool
from utils import query_postgres, query_mongodb
from models import Company, PressRelease, CompanyBatchResponse, PressReleaseBatchResponse
import json


# MARK: - Sequential Batch State
class SequentialBatchState:
    """Global state to enforce sequential batch processing."""
    def __init__(self, batch_size: int):
        self.batch_size = batch_size
        self.expected_offset = 0
        self.completed = False
    
    def validate_and_update(self, requested_offset: int) -> tuple[bool, str]:
        """Validate offset and update state. Returns (is_valid, error_message)."""
        if self.completed:
            return False, "❌ ERROR: All batches already processed (has_more=false was returned)"
        
        if requested_offset != self.expected_offset:
            error = (
                f"❌ SEQUENTIAL BATCH VIOLATION ❌\n"
                f"Expected offset: {self.expected_offset}\n"
                f"Requested offset: {requested_offset}\n"
                f"You MUST process batches sequentially.\n"
                f"Next valid offset: {self.expected_offset}"
            )
            return False, error
        
        # Valid - update for next call
        self.expected_offset += self.batch_size
        return True, ""
    
    def mark_complete(self):
        """Mark sequential processing as complete."""
        self.completed = True

# Global instance - will be initialized when tool is created
_batch_state = None


# MARK: - Company Query Tools
@tool
def get_companies_from_postgres(offset: int = 0, limit: int = 100) -> str:
    """
    Query PostgreSQL for company data in chunks to avoid context overflow.
    ENFORCES sequential offset processing - you MUST start at 0 and increment by batch_size.
    
    Args:
        offset: Starting position (MUST be sequential: 0, 50, 100, 150...)
        limit: Number of companies to return (default: 100, max: 500)
    
    Returns:
        JSON with companies, total_count, offset, and has_more fields
    """
    global _batch_state
    
    # Initialize state on first call
    if _batch_state is None:
        from config import COMPANY_BATCH_SIZE
        _batch_state = SequentialBatchState(batch_size=COMPANY_BATCH_SIZE)
    
    # ENFORCE sequential processing
    is_valid, error_msg = _batch_state.validate_and_update(offset)
    if not is_valid:
        # Return error in same format but with error field
        error_response = {
            "error": error_msg,
            "companies": [],
            "total_count": 0,
            "offset": offset,
            "limit": limit,
            "returned": 0,
            "has_more": False
        }
        return json.dumps(error_response, indent=2)
    
    limit = min(limit, 500)  # Cap at 500 to prevent overflow
    
    sql = '''
    SELECT ticker, industry, company_name, company_desc
    FROM cc_ticker_company_detail
    WHERE COALESCE(no_refresh_flag, 1) <> 1
    AND sector = 'Technology'
    ORDER BY ticker
    LIMIT %s OFFSET %s
    '''
    
    # Also get total count
    count_sql = '''
    SELECT COUNT(*) as total
    FROM cc_ticker_company_detail
    WHERE COALESCE(no_refresh_flag, 1) <> 1
    AND sector = 'Technology'
    '''
    
    companies_raw = query_postgres(sql, (limit, offset))
    count_result = query_postgres(count_sql)
    total_count = count_result[0]['total'] if count_result else 0
    
    # Filter and validate companies using the Company model
    valid_companies = [
        Company(
            ticker=row["ticker"],
            company_name=row["company_name"],
            company_desc=row["company_desc"],
            industry=row.get("industry")
        )
        for row in companies_raw
        if Company.is_valid_record(row)
    ]
    
    has_more = (offset + len(valid_companies)) < total_count
    
    # Mark as complete if no more batches
    if not has_more:
        _batch_state.mark_complete()
    
    # Create response using the response model
    response = CompanyBatchResponse(
        companies=valid_companies,
        total_count=total_count,
        offset=offset,
        limit=limit,
        returned=len(valid_companies),
        has_more=has_more
    )
    
    return response.model_dump_json(indent=2)


# MARK: - Sequential Company State
class SequentialCompanyState:
    """Global state to enforce one-company-at-a-time processing."""
    def __init__(self):
        self.processed_companies = set()
    
    def validate_and_update(self, symbols: str, skip: int) -> tuple[bool, str]:
        """Validate company query. Returns (is_valid, error_message)."""
        symbol_list = [s.strip() for s in symbols.split(",") if s.strip()]
        
        # Must process ONE company at a time
        if len(symbol_list) != 1:
            error = (
                f"❌ COMPANY VALIDATION VIOLATION ❌\n"
                f"You must process ONE company at a time.\n"
                f"Requested symbols: {symbols}\n"
                f"Split into separate calls, one symbol each."
            )
            return False, error
        
        symbol = symbol_list[0]
        
        # No duplicates
        if symbol in self.processed_companies:
            error = (
                f"❌ DUPLICATE COMPANY PROCESSING ❌\n"
                f"Company {symbol} has already been processed.\n"
                f"Do not query the same company multiple times."
            )
            return False, error
        
        # No pagination (must use skip=0)
        if skip != 0:
            error = (
                f"❌ PAGINATION VIOLATION ❌\n"
                f"Do not paginate press releases (skip must be 0).\n"
                f"Requested skip: {skip}\n"
                f"Fetch all needed releases in a single call."
            )
            return False, error
        
        # Valid - mark as processed
        self.processed_companies.add(symbol)
        return True, ""

# Global instance
_company_state = SequentialCompanyState()


# MARK: - Press Release Query Tools
@tool
def get_press_releases_from_mongodb(symbols: str, skip: int = 0, limit: int = 50) -> str:
    """
    Query MongoDB for press releases filtered by ticker symbols.
    ENFORCES one company at a time, no duplicates, no pagination (skip must be 0).
    
    Args:
        symbols: Single ticker symbol (e.g., "NVDA") - only ONE at a time
        skip: MUST be 0 (no pagination allowed)
        limit: Number of releases to return (default: 50, max: 200)
    
    Returns:
        JSON with press releases, total_count, skip, and has_more fields
    """
    global _company_state
    
    # ENFORCE sequential company processing
    is_valid, error_msg = _company_state.validate_and_update(symbols, skip)
    if not is_valid:
        # Return error in same format but with error field
        error_response = {
            "error": error_msg,
            "press_releases": [],
            "total_count": 0,
            "skip": skip,
            "limit": limit,
            "returned": 0,
            "has_more": False
        }
        return json.dumps(error_response, indent=2)
    
    limit = min(limit, 200)  # Cap at 200 to prevent overflow
    
    # Parse comma-separated symbols
    symbol_list = [s.strip() for s in symbols.split(",") if s.strip()]
    
    query = {
        "doc_type": "press_release",
        "symbol": {"$in": symbol_list},
        "announcements": {"$exists": True, "$ne": None}
    }
    projection = {
        "_id": 0,
        "symbol": 1,
        "date": 1,
        "pr_title": 1,
        "content": 1,
        "pr_link": 1
    }
    
    # Get total count
    from pymongo import MongoClient
    import os
    client = MongoClient(os.getenv("MONGODB_URI"))
    db = client[os.getenv("MONGODB_DATABASE")]
    total_count = db["documents"].count_documents(query)
    client.close()
    
    # Get paginated results
    releases_raw = query_mongodb(
        collection_name="documents",
        query=query,
        projection=projection,
        limit=limit + skip  # Get all up to skip+limit, then slice
    )
    
    # Skip and limit
    releases_raw = releases_raw[skip:skip+limit]
    
    # Filter and validate press releases using the PressRelease model
    valid_releases = [
        PressRelease(
            symbol=row.get("symbol"),
            date=row.get("date"),
            pr_title=row.get("pr_title"),
            content=row.get("content"),
            pr_link=row.get("pr_link")
        )
        for row in releases_raw
        if PressRelease.is_valid_record(row)
    ]
    
    has_more = (skip + len(valid_releases)) < total_count
    
    # Create response using the response model
    response = PressReleaseBatchResponse(
        press_releases=valid_releases,
        total_count=total_count,
        skip=skip,
        limit=limit,
        returned=len(valid_releases),
        has_more=has_more
    )
    
    return response.model_dump_json(indent=2)

