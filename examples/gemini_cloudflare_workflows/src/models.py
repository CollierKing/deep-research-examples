"""
Pydantic models for extracting structured alignment analysis from deep research output.
"""

import re
from typing import List, Optional, Literal
from pydantic import BaseModel, Field, field_validator


# MARK: - Pydantic Models

class AlignmentItem(BaseModel):
    """A single item from the alignment analysis section."""

    status_category: Literal["confirmed", "unaddressed", "new_developments"] = Field(
        ...,
        description="Category of alignment status: confirmed (delivered), unaddressed (gaps), or new_developments (beyond guidance)"
    )
    item: str = Field(
        ...,
        description="Description of the alignment item with markdown link text stripped out (plain text only)"
    )
    item_link: Optional[str] = Field(
        None,
        description="URL extracted from the markdown link in the item, if present (e.g., https://www.businesswire.com/...)"
    )

    @field_validator("item", mode="before")
    @classmethod
    def strip_links_from_item(cls, v: str) -> str:
        """Strip markdown links and URLs from item text, keeping only plain text."""
        if not isinstance(v, str):
            return v
        # Replace markdown links [text](url) with just the text
        v = re.sub(r'\[([^\]]+)\]\([^)]+\)', r'\1', v)
        # Remove any remaining raw URLs
        v = re.sub(r'https?://\S+', '', v)
        # Clean up extra whitespace
        v = re.sub(r'\s+', ' ', v).strip()
        return v

    @field_validator("item_link", mode="before")
    @classmethod
    def normalize_item_link(cls, v: Optional[str]) -> Optional[str]:
        """Normalize item_link to https:// or None if invalid."""
        if v is None or not isinstance(v, str):
            return None
        v = v.strip()
        if not v:
            return None
        # Upgrade http to https
        if v.startswith("http://"):
            v = "https://" + v[7:]
        # If still not https://, return None
        if not v.startswith("https://"):
            return None
        return v


class AlignmentAnalysis(BaseModel):
    """Container for extracted alignment analysis items."""

    items: List[AlignmentItem] = Field(
        default_factory=list,
        description="Array of extracted alignment items from the analysis"
    )
