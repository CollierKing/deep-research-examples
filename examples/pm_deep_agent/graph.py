from typing import Dict, Any

# MARK: - Imports/Dependencies
from langgraph.graph.state import CompiledStateGraph

from deepagents import create_deep_agent
from tools import query_tool
from utils import comprehensive_logging_hook

# MARK: - Constants/Configuration
GRAPH_NAME = "pm_deep_agent"
GRAPH_DESCRIPTION = (
    "Research agent that compares marketing personas/use-cases vs social media personas/use-cases"
)

# MARK: - Prompts
RESEARCH_INSTRUCTIONS = """
You are an overseeing research agent. Your goal is to determine whether the use-cases and customer personas in a company's marketing content for a given product align with those expressed by users on social media.

Important Context:
- The target product will be explicitly provided in the user's prompt. Extract it and use it to focus all research. Do not invent or assume a product.

Process:
1) Extract the target product (and any scope constraints) from the user's prompt.
2) Use the marketing_sub_agent to extract use-cases and personas from official company content.
3) Use the social_media_sub_agent to extract use-cases and personas from user-generated social media content.
4) Compare the two outputs to find overlaps and differences. Highlight gaps, discrepancies, and opportunities to better align marketing with what users say.

Output:
- A clear comparison that lists:
  - Overlapping use-cases and personas
  - Marketing-only use-cases/personas
  - Social-only use-cases/personas
  - Notable pain points and opportunities
- Provide actionable recommendations for improving marketing alignment.

Important:
- The subagents are responsible for data gathering via `query_tool` (with `src` set to "marketing_content" or "social_media").
- As the overseeing agent, prefer orchestrating subagents (via tasks) rather than calling `query_tool` directly.
- Keep your final answer well-structured in markdown.
""".strip()

MARKETING_SUB_PROMPT = """
You are a marketing content analyst. Your task is to extract use-cases and user/customer personas strictly from first-party marketing materials created by the company that builds the product.

Requirements:
- The target product will be provided in the user's prompt. Extract it and use it to focus your analysis. Do not invent or assume a product.
- Use the `query_tool(src="marketing_content", product_name=...)` to fetch relevant first-party content. Keep queries focused on the target product.
- Focus ONLY on company-created content (e.g., product pages, documentation, official blog posts, case studies, landing pages).
- Extract and list use-cases and user personas. For personas, include role/title, industry, team/function, and company size if implied.
- Provide short evidence snippets or references when possible.
- Keep results structured and concise.
""".strip()

SOCIAL_MEDIA_SUB_PROMPT = """
You are a social media content analyst. Your task is to extract use-cases and user/customer personas strictly from user-generated social media content about the product.

Requirements:
- The target product will be provided in the user's prompt. Extract it and use it to focus your analysis. Do not invent or assume a product.
- Use the `query_tool(src="social_media", product_name=...)` to fetch relevant social posts for the target product.
- Focus ONLY on user-generated content (e.g., X/Twitter, Reddit, Hacker News, forums, YouTube comments).
- Extract and list use-cases and user personas. For personas, include role/title, industry, team/function, and company size if implied.
- Note pain points, unmet needs, and emergent usages discovered in the wild.
- Provide short evidence snippets or references when possible.
- Keep results structured and concise.
""".strip()

# MARK: - Sub Agents
SubAgent = Dict[str, Any]

# MARK: - Sub Agent Definitions
marketing_sub_agent: SubAgent = {
    "name": "marketing_sub_agent",
    "description": "Extract use-cases and personas from official marketing/company content for the product.",
    "prompt": MARKETING_SUB_PROMPT,
    "tools": ["query_tool", "write_file", "write_todos", "read_file"],
}

social_media_sub_agent: SubAgent = {
    "name": "social_media_sub_agent",
    "description": "Extract use-cases and personas from user-generated social media content about the product.",
    "prompt": SOCIAL_MEDIA_SUB_PROMPT,
    "tools": ["query_tool", "write_file", "write_todos", "read_file"],
}


# MARK: - Create Graph
def create_graph(
        model: str,
        client,
        mcp_servers: Dict[str, Any]
) -> CompiledStateGraph:
    """
    Create and return a deep agent graph that orchestrates two subagents:
    - marketing_sub_agent
    - social_media_sub_agent
    """

    # MARK: - Tools
    local_tools = [query_tool]

    # MARK: - Agent
    agent = create_deep_agent(
        model=model,
        tools=local_tools,
        instructions=RESEARCH_INSTRUCTIONS,
        subagents=[marketing_sub_agent, social_media_sub_agent],
        post_model_hook=comprehensive_logging_hook
    ).with_config({"recursion_limit": 1000})

    return agent
