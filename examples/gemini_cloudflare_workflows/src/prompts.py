"""
Prompt templates for Deep Research Workflow.
"""


def build_research_prompt(ticker: str, earnings_date: str) -> str:
    """Build the deep research prompt for analyzing earnings and press releases."""
    return f"""
## CRITICAL CONSTRAINT - READ FIRST

You are operating in CLOSED-BOOK MODE. This means:
- You have ALREADY been given ALL the data you need in the uploaded files in your file store:
* INPUT_earnings_transcript.txt
* INPUT_press_releases.txt

- DO NOT search the web
- DO NOT use external sources or your training knowledge about this company
- DO NOT cite any URLs except those explicitly provided in the press release data
- If information is not in the provided documents, state "Not found in provided documents"
- Any claim you make MUST be traceable to a specific quote from the uploaded files

VIOLATION of these rules renders the analysis INVALID.

---

Perform a comprehensive Earnings Analysis for {ticker} based on the earnings call transcript
from {earnings_date} and subsequent press releases.

You have two datasets:
1. **Earnings Transcript:** The full transcript from the earnings call on {earnings_date}
2. **Press Releases:** All press releases issued after the earnings date

**YOUR GOAL:** Analyze how the company's announced strategy and guidance from the earnings call
has been executed through subsequent press releases and announcements.

**ANALYSIS LOGIC (CRITICAL):**
- **Date Check:** You MUST compare earnings call date vs press release dates. Only PRs AFTER the earnings date are relevant.
- **Alignment:** Did a press release explicitly deliver on something promised in earnings?
- **Divergence/Gap:** Did management commit to something in earnings that has NO matching press release?

**CITATION FORMAT (MARKDOWN):**
- DO NOT use footnotes or numbers like [1] or [cite: 1].
- **Embed the links directly in the text** using standard Markdown format: `[Link Text](URL)`.
- **Link Text:** Use a short description (e.g., "BlueBird 6 Launch PR", "Q3 Earnings Call").
- **URL:** You MUST use the exact "Link:" field from the press release data. These are businesswire.com or prnewswire.com URLs.
- For earnings transcript quotes, use format: "quote" (Earnings Transcript, {earnings_date})

**REPORT STRUCTURE:**

### 1. Key Earnings Highlights
- Main financial metrics discussed
- Forward guidance provided
- Strategic initiatives announced
- *Evidence:* Include direct quotes from the earnings transcript.

### 2. Management Commentary Analysis
- Key themes from management
- Risks or challenges acknowledged
- Opportunities highlighted

### 3. Press Release Follow-Through
For each press release, analyze its connection to earnings guidance:
- *Evidence:* "Management stated X in earnings, and [PR Title](https://www.businesswire.com/...) confirmed X was delivered."

### 4. Alignment Analysis

#### ✅ Confirmed Execution (They Delivered)
- List guidance from earnings that was confirmed by subsequent press releases.
- *Evidence:* "Management promised X (Earnings Transcript), and [PR Title](https://www.businesswire.com/...) announced X."

#### ❌ Unaddressed Guidance (The Gaps)
- List commitments from earnings that have NO matching press release confirmation.
- *Evidence:* "Management stated they would do Y (Earnings Transcript), but no press releases address this."

#### 🚀 New Developments (Beyond Guidance)
- List press release announcements NOT previewed in earnings.
- *Evidence:* "[PR Title](https://www.businesswire.com/...) announced Z, which was not discussed in earnings."

### 5. Key Takeaways
- Top 3-5 actionable insights for investors
- Notable gaps between guidance and execution
- Overall assessment of management credibility

---
IMPORTANT: DO NOT USE LINKS FROM EXTERNAL/WEB SOURCES.  ONLY USE THE DATA THAT HAS BEEN PROVIDED IN YOUR FILE STORE:
* INPUT_earnings_transcript.txt
* INPUT_press_releases.txt

"""


# MARK: - Alignment Extraction Prompt

ALIGNMENT_EXTRACTION_PROMPT = """You are an expert at extracting structured data from financial analysis reports.

Your task is to extract the "Alignment Analysis" section from the provided deep research report and convert it into structured JSON.

The alignment analysis section typically has three categories:
1. **Confirmed Execution (They Delivered)** - marked with checkmarks (✅) - map to "confirmed"
2. **Unaddressed Guidance (The Gaps)** - marked with X (❌) - map to "unaddressed"
3. **New Developments (Beyond Guidance)** - marked with rocket (🚀) - map to "new_developments"

For each bullet point item in these sections:
1. Extract the `status_category` based on which section it belongs to
2. Extract the `item` text - IMPORTANT: Strip out any markdown links and replace with just the link text
   - Example: "[AST SpaceMobile Expands...](https://businesswire.com/...)" becomes "AST SpaceMobile Expands..."
3. Extract the `item_link` - the URL from any markdown link in the item (if present)
   - Example: From "[Title](https://businesswire.com/news/...)" extract "https://businesswire.com/news/..."

If there is no Alignment Analysis section, return an empty items array.

Return ONLY valid JSON matching the AlignmentAnalysis schema.

Report text to analyze:
{report_text}
"""
