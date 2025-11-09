# LangChain DeepAgents Examples

A collection of practical examples demonstrating how to build complex, multi-step AI agents using [DeepAgents](https://github.com/langchain-ai/deepagents)—a framework for orchestrating LLM agents through subagent spawning, filesystem-based context management, and built-in planning tools.

## What is DeepAgents?

DeepAgents is a framework for building LLM agents that can handle complex, long-running tasks by breaking them into specialized subagents. Each subagent operates independently with its own context, tools, and objectives, avoiding the context pollution that plagues monolithic agent designs. This architecture excels at systematic analysis workflows that involve processing thousands of items, querying multiple data sources, and maintaining state across extended operations.

## Repository Structure

This repository contains real-world examples that showcase different aspects of the DeepAgents framework:

```
langchain-deepagents-examples/
├── examples/
│   ├── ai_theme_plays/       # Multi-stage analysis with enforcement mechanisms
│   └── pm_deep_agent/         # Product research with dual analysis streams
└── README.md
```

## Examples

### AI Theme Plays

**Path:** `examples/ai_theme_plays/`
**Tech Stack:** LangChain + DeepAgents + PostgreSQL + MongoDB + S3

A sophisticated analysis pipeline that takes earnings transcripts (like Jensen Huang's GTC keynote) and systematically finds companies that align with mentioned themes. This example demonstrates advanced enforcement mechanisms to ensure LLMs follow complex workflows without taking shortcuts.

**The Challenge:** Process 2,400 companies against extracted themes, validate each match with press release evidence from MongoDB, and rank the top 100 by alignment strength—all while preventing the LLM from skipping items, producing inconsistent JSON, or overflowing context windows.

**How It Works:**

The workflow uses four specialized subagents in sequence:
1. **Transcript Analyzer** - Extracts key themes from the input transcript
2. **Company Matcher** - Processes all 2,400 companies in batches of 50 from PostgreSQL, evaluating each against the themes
3. **Press Release Validator** - Queries MongoDB for press releases and validates matches with concrete evidence
4. **Final Ranker** - Consolidates all data and ranks the top 100 companies

**Key Innovations:**

- **Stateful Tools with Sequential Enforcement** - Tools track expected state (like batch offsets) and reject invalid operations, preventing LLMs from skipping batches
- **Validation Middleware** - Intercepts tool calls to verify input/output counts match, catching when LLMs try to process only a "representative sample"
- **Schema-Driven Prompts** - Dynamically generates JSON examples from Pydantic models, eliminating schema drift between documentation and validation
- **Pydantic Validation** - All file writes and reads validate against typed models, forcing structure consistency

This example is particularly valuable for understanding how to build reliable, production-grade agent systems that must process all items in a dataset without shortcuts.

[View Full Documentation →](examples/ai_theme_plays/README.md)

---

### PM Deep Agent

**Path:** `examples/pm_deep_agent/`
**Tech Stack:** LangChain + DeepAgents

A product management research agent that compares how companies market their products versus how users actually discuss them on social media. This example demonstrates clean subagent orchestration for parallel research streams.

**The Challenge:** Determine whether the use-cases and customer personas in a company's marketing content align with those expressed by users on social media platforms.

**How It Works:**

An orchestrating agent coordinates two specialized subagents:
1. **Marketing Sub-Agent** - Analyzes first-party marketing materials (product pages, documentation, case studies, landing pages) to extract official use-cases and target personas
2. **Social Media Sub-Agent** - Analyzes user-generated content (Twitter/X, Reddit, Hacker News, forums) to extract real-world use-cases and actual user personas

The main agent compares both outputs to identify:
- Overlapping use-cases and personas (alignment)
- Marketing-only use-cases/personas (potential over-positioning)
- Social-only use-cases/personas (unmet needs and opportunities)
- Notable pain points and gaps

**Output:** Structured markdown comparison with actionable recommendations for improving marketing alignment.

This example is ideal for understanding basic subagent orchestration, parallel research workflows, and how to structure comparative analysis tasks.

[View Full Documentation →](examples/pm_deep_agent/README.md)

---

## Getting Started

Each example includes its own README with detailed setup instructions, architecture diagrams, and implementation details. Navigate to the specific example directory to get started:

- **AI Theme Plays:** Complex workflow enforcement and multi-database integration
- **PM Deep Agent:** Dual-stream research and comparative analysis

## Additional Resources

- [Original Presentation](https://docs.google.com/presentation/d/1E9KaB2DLMyF7s2EQVxIESqj_pqysm1IJgYJ0S1vZsAU/edit?slide=id.g37d6bca5e93_0_67#slide=id.g37d6bca5e93_0_67)
- [DeepWiki Documentation](https://deepwiki.com/CollierKing/langchain-deepagents-examples)
- [DeepAgents GitHub Repository](https://github.com/langchain-ai/deepagents)

## License

MIT License - see [LICENSE](LICENSE) file for details.
