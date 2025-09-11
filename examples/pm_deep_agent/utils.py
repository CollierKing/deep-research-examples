from typing import List, Optional, Dict, Tuple
import os
import re
from pydantic import BaseModel, Field
from langchain_core.prompts import ChatPromptTemplate
from sqlalchemy import create_engine
from sqlalchemy.engine import Engine

import logging
import json
from colorama import Fore, Back, Style, init


# MARK: - General Utilities
def create_d1_engine() -> Engine:
    connection_string = (
        f"cloudflare_d1://{os.environ['CF_ACCOUNT_ID']}:{os.environ['CF_D1_API_TOKEN']}@{os.environ['CF_D1_DATABASE_ID']}"
    )
    return create_engine(connection_string, echo=False)


# MARK: - Logging
init(autoreset=True)

# Configure detailed logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger("deepagents")

# Suppress httpx logs
logging.getLogger("httpx").setLevel(logging.WARNING)


def comprehensive_logging_hook(state):
    """Log everything: messages, tool calls, state changes, errors"""

    # Keep structured logging
    logger.info("=== POST-MODEL HOOK TRIGGERED ===")

    # Add colored console output for visual debugging
    print(f"\n{Back.BLUE}{Fore.WHITE} DEEP AGENT LOG {Style.RESET_ALL}")

    # Log current state keys
    state_keys = list(state.keys())
    logger.info(f"State keys: {state_keys}")
    print(f"{Fore.CYAN}State: {Fore.WHITE}{state_keys}")

    # Log messages
    messages = state.get("messages", [])
    logger.info(f"Total messages: {len(messages)}")

    if messages:
        last_message = messages[-1]
        msg_type = type(last_message).__name__
        content = getattr(last_message, 'content', 'No content')

        logger.info(f"Last message type: {msg_type}")
        logger.info(f"Last message content: {content}")

        print(f"{Fore.GREEN}Message: {Fore.YELLOW}{msg_type}")

        # Tool calls with error highlighting
        if hasattr(last_message, 'tool_calls') and last_message.tool_calls:
            tool_count = len(last_message.tool_calls)
            logger.info(f"Tool calls found: {tool_count}")

            print(f"{Back.GREEN}{Fore.BLACK} {tool_count} TOOL CALLS {Style.RESET_ALL}")

            for i, tool_call in enumerate(last_message.tool_calls):
                logger.info(f"Tool call {i}: {json.dumps(tool_call, indent=2)}")
                tool_name = tool_call.get('name', 'unknown')
                print(f"  {Fore.MAGENTA}▶ {tool_name}")
        else:
            logger.info("No tool calls in last message")
            print(f"{Back.RED}{Fore.WHITE} NO TOOL CALLS {Style.RESET_ALL}")

            # File system and todos with visual indicators
    files = state.get("files", {})
    todos = state.get("todos", [])

    logger.info(f"Files in state: {list(files.keys())}")
    logger.info(f"Todos count: {len(todos)}")

    print(f"{Fore.BLUE}Files: {len(files)} | Todos: {len(todos)}")
    print(f"{Fore.CYAN}{'─' * 40}{Style.RESET_ALL}\n")

    return state
