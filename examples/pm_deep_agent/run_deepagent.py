# MARK: - Imports
from datetime import datetime
import time
import os
from colorama import Fore

from dotenv import load_dotenv

# Load env vars first
load_dotenv(".env")

from graph import create_graph

# MARK: - Params
question = "Get me research on the 'workers ai' product"

# MARK: - Graph
# Create the agent graph
config = {"configurable": {"thread_id": f"pmda-{int(time.time())}"}}

agent = create_graph(
    model="claude-sonnet-4-20250514",
    client=None,
    mcp_servers={}
)

print("\n=== Question ===")
print(question)

# MARK: - Invoke
tstart = datetime.now()
result = agent.invoke(
    {"messages": [{"role": "user", "content": question}]},
    config=config
)
tend = datetime.now()
print(f"Time elapsed: {tend - tstart}")

print(Fore.LIGHTYELLOW_EX + "\n=== Answer ===")
last_msg = result["messages"][-1]
print(last_msg.content)

sav_dir = f"results/claude_results_{datetime.now().strftime('%Y%m%d_%H%M%S')}.txt"
with open(sav_dir, "w") as f:
    f.write(last_msg.content)
