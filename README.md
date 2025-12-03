# Deep Research Examples

A collection of practical examples demonstrating how to build complex, multi-step AI research workflows. These examples showcase different approaches to orchestrating LLM agents for systematic analysis tasks.

## What is Deep Research?

Deep research refers to AI workflows that go beyond simple prompting—systematically processing large datasets, querying multiple data sources, and maintaining state across extended operations. These workflows break complex tasks into specialized steps, each with its own context, tools, and objectives.

## Repository Structure

```
deep-research-examples/
├── examples/
│   ├── ai_theme_plays/           # DeepAgents: Multi-stage analysis with enforcement
│   ├── pm_deep_agent/            # DeepAgents: Product research with dual streams
│   └── stagehand_company_news/   # Stagehand: Browser automation for news discovery
└── README.md
```

## Approaches

This repository demonstrates two different approaches to deep research:

| Approach | Best For | Examples |
|----------|----------|----------|
| **DeepAgents** | Database queries, batch processing, multi-source analysis | AI Theme Plays, PM Deep Agent |
| **Stagehand** | Browser automation, web scraping, dynamic content | Company News Discovery |

---

## Examples

### Company News Discovery (Stagehand)

**Path:** [`examples/stagehand_company_news/`](examples/stagehand_company_news/)

**Tech Stack:** Stagehand + Multi-Provider LLMs (OpenAI, Anthropic, Google, Ollama) + S3

Automated discovery of company news and press release pages using browser automation and LLM verification. Given a company domain, finds the official press release listing page.

**The Challenge:** News pages have no standard location (`/news`, `/newsroom`, `/press`, `/media`), links are often hidden in dropdown menus, and search engines return individual articles instead of listing pages.

**How It Works:**

A 3-step discovery flow with LLM verification at each step:
1. **Search** - Query DuckDuckGo for `site:{domain} news OR press` and verify candidates
2. **Homepage** - Extract nav/header/footer links, expand dropdowns, verify candidates
3. **Site Search** - Use the site's own search bar as a last resort

**Key Features:**

- **Multi-provider LLM support** - Compare accuracy across OpenAI, Anthropic, Google, and Ollama
- **S3 persistence** - All session data (results, metrics, logs) flushed after each company
- **Stealth browser automation** - Handles bot detection with non-headless mode
- **Incremental caching** - Skip LLM inference on repeated runs

[View Full Documentation →](examples/stagehand_company_news/README.md)

---

### AI Theme Plays (DeepAgents)

**Path:** [`examples/ai_theme_plays/`](examples/ai_theme_plays/)

**Tech Stack:** LangChain + DeepAgents + PostgreSQL + MongoDB + S3

A sophisticated analysis pipeline that takes earnings transcripts (like Jensen Huang's GTC keynote) and systematically finds companies that align with mentioned themes.

**The Challenge:** Process 2,400 companies against extracted themes, validate each match with press release evidence from MongoDB, and rank the top 100 by alignment strength—all while preventing the LLM from skipping items or producing inconsistent output.

**How It Works:**

Four specialized subagents in sequence:
1. **Transcript Analyzer** - Extracts key themes from the input transcript
2. **Company Matcher** - Processes all 2,400 companies in batches of 50 from PostgreSQL
3. **Press Release Validator** - Queries MongoDB for press releases and validates matches
4. **Final Ranker** - Consolidates all data and ranks the top 100 companies

**Key Innovations:**

- **Stateful Tools with Sequential Enforcement** - Tools track expected state and reject invalid operations
- **Validation Middleware** - Intercepts tool calls to verify input/output counts match
- **Schema-Driven Prompts** - Dynamically generates JSON examples from Pydantic models
- **Pydantic Validation** - All file writes/reads validate against typed models

[View Full Documentation →](examples/ai_theme_plays/README.md)

---

### PM Deep Agent (DeepAgents)

**Path:** [`examples/pm_deep_agent/`](examples/pm_deep_agent/)

**Tech Stack:** LangChain + DeepAgents

A product management research agent that compares how companies market their products versus how users actually discuss them on social media.

**The Challenge:** Determine whether marketing use-cases and personas align with those expressed by real users on social platforms.

**How It Works:**

An orchestrating agent coordinates two specialized subagents:
1. **Marketing Sub-Agent** - Analyzes first-party marketing materials (product pages, docs, case studies)
2. **Social Media Sub-Agent** - Analyzes user-generated content (Twitter/X, Reddit, Hacker News)

The main agent compares both outputs to identify alignment, over-positioning, and unmet opportunities.

[View Full Documentation →](examples/pm_deep_agent/README.md)

---

## Getting Started

Each example includes its own README with detailed setup instructions, architecture diagrams, and implementation details:

| Example | Focus |
|---------|-------|
| [Company News Discovery](examples/stagehand_company_news/) | Browser automation, multi-provider LLMs, web scraping |
| [AI Theme Plays](examples/ai_theme_plays/) | Workflow enforcement, multi-database integration, batch processing |
| [PM Deep Agent](examples/pm_deep_agent/) | Dual-stream research, comparative analysis |

## Additional Resources

- [Stagehand Documentation](https://docs.stagehand.dev)
- [DeepAgents GitHub Repository](https://github.com/langchain-ai/deepagents)
- [Original Presentation](https://docs.google.com/presentation/d/1E9KaB2DLMyF7s2EQVxIESqj_pqysm1IJgYJ0S1vZsAU/edit?slide=id.g37d6bca5e93_0_67#slide=id.g37d6bca5e93_0_67)
- [DeepWiki Documentation](https://deepwiki.com/CollierKing/langchain-deepagents-examples)

## License

MIT License - see [LICENSE](LICENSE) file for details.