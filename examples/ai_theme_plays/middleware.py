# MARK: - Imports
from dotenv import load_dotenv, find_dotenv
import os
import logging
import json
from langchain.agents.middleware import AgentMiddleware, wrap_model_call
from langchain_core.tools import tool
import boto3
from typing import Optional
from colorama import Fore, Back, Style, init
from config import MODEL

# MARK: - Environment
load_dotenv(find_dotenv(), override=False)

# MARK: - Logging Setup
init(autoreset=True)

# Configure detailed logging
logging.basicConfig(
    level=logging.INFO, format="%(asctime)s - %(name)s - %(levelname)s - %(message)s"
)
logger = logging.getLogger("deepagents")

# Suppress httpx logs
logging.getLogger("httpx").setLevel(logging.WARNING)


# MARK: - Content Truncation Middleware
class ContentTruncationMiddleware(AgentMiddleware):
    """Truncates message CONTENT to fit within token limits."""
    
    def __init__(self, max_tokens: int):
        super().__init__()
        self.max_tokens = max_tokens
        print(f"{Back.CYAN}{Fore.WHITE} ContentTruncationMiddleware initialized (max_tokens={max_tokens:,}) {Style.RESET_ALL}")
    
    def before_model(self, state, runtime):
        """Truncate message content if it exceeds token limit."""
        messages = state.get("messages", [])
        
        if not messages:
            return None
        
        try:
            # Calculate current token count
            try:
                current_tokens = MODEL.get_num_tokens_from_messages(messages)
            except:
                # Fallback: rough estimate (4 chars per token)
                total_chars = sum(len(str(getattr(m, 'content', ''))) for m in messages)
                current_tokens = total_chars // 4
            
            if current_tokens <= self.max_tokens:
                return None
            
            # Calculate how much we need to reduce
            tokens_to_remove = current_tokens - self.max_tokens
            reduction_ratio = self.max_tokens / current_tokens
            
            logger.warning(f"Content over limit: {current_tokens:,} > {self.max_tokens:,} tokens (need to remove {tokens_to_remove:,})")
            print(f"{Back.RED}{Fore.WHITE} Content exceeds limit: {current_tokens:,} > {self.max_tokens:,} tokens {Style.RESET_ALL}")
            print(f"{Fore.YELLOW}Reduction ratio: {reduction_ratio:.2%}{Style.RESET_ALL}")
            
            # Truncate message contents proportionally
            for message in messages:
                content = message.content
                
                # Handle list content (tool results)
                if isinstance(content, list):
                    for item in content:
                        if isinstance(item, dict) and 'text' in item:
                            text = item['text']
                            try:
                                # Try to parse as JSON and truncate arrays
                                data = json.loads(text)
                                if isinstance(data, dict):
                                    for key, value in data.items():
                                        if isinstance(value, list) and len(value) > 0:
                                            # Calculate target array size based on reduction ratio
                                            target_size = max(1, int(len(value) * reduction_ratio))
                                            if target_size < len(value):
                                                original_len = len(value)
                                                data[key] = value[:target_size]
                                                logger.info(f"Truncated {key} array: {original_len} → {target_size} items ({reduction_ratio:.2%})")
                                    item['text'] = json.dumps(data, indent=2)
                            except:
                                # Not JSON, truncate text proportionally
                                target_chars = max(1000, int(len(text) * reduction_ratio))
                                item['text'] = text[:target_chars] + "\n...[TRUNCATED]"
                                logger.info(f"Truncated text: {len(text):,} → {target_chars:,} chars ({reduction_ratio:.2%})")
                
                # Handle string content
                elif isinstance(content, str):
                    target_chars = max(1000, int(len(content) * reduction_ratio))
                    if target_chars < len(content):
                        message.content = content[:target_chars] + "\n...[TRUNCATED]"
                        logger.info(f"Truncated string: {len(content):,} → {target_chars:,} chars ({reduction_ratio:.2%})")
            
            # Verify we're now under limit
            try:
                new_tokens = MODEL.get_num_tokens_from_messages(messages)
            except:
                total_chars = sum(len(str(getattr(m, 'content', ''))) for m in messages)
                new_tokens = total_chars // 4
            
            saved_tokens = current_tokens - new_tokens
            print(f"{Back.YELLOW}{Fore.BLACK} TRUNCATED: {current_tokens:,} → {new_tokens:,} tokens (saved {saved_tokens:,}) {Style.RESET_ALL}")
            
            if new_tokens > self.max_tokens:
                logger.warning(f"Still over limit after truncation: {new_tokens:,} > {self.max_tokens:,}")
                print(f"{Back.RED}{Fore.WHITE} WARNING: Still over limit! {new_tokens:,} > {self.max_tokens:,} {Style.RESET_ALL}")
            
        except Exception as e:
            logger.warning(f"Error truncating content: {e}")
        
        return None


# MARK: - LoggingMiddleware
class LoggingMiddleware(AgentMiddleware):
    """Comprehensive logging middleware that tracks agent state, messages, tool calls, and more."""

    def __init__(self):
        super().__init__()
        print(
            f"{Back.MAGENTA}{Fore.WHITE} LoggingMiddleware initialized {Style.RESET_ALL}"
        )

    def after_model(self, state, runtime):
        """Log after model response - this is where we capture comprehensive logs"""
        self._log_agent_state(state)
        return None

    def _log_agent_state(self, state):
        """Comprehensive logging of agent state"""

        # Keep structured logging
        logger.info("=== AGENT STATE LOG ===")

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
            content = getattr(last_message, "content", "No content")

            logger.info(f"Last message type: {msg_type}")
            logger.info(f"Last message content: {content}")

            print(f"{Fore.GREEN}Message: {Fore.YELLOW}{msg_type}")

            # Tool calls with error highlighting
            if hasattr(last_message, "tool_calls") and last_message.tool_calls:
                tool_count = len(last_message.tool_calls)
                logger.info(f"Tool calls found: {tool_count}")

                print(
                    f"{Back.GREEN}{Fore.BLACK} {tool_count} TOOL CALLS {Style.RESET_ALL}"
                )

                for i, tool_call in enumerate(last_message.tool_calls):
                    logger.info(f"Tool call {i}: {json.dumps(tool_call, indent=2)}")
                    tool_name = tool_call.get("name", "unknown")
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


# MARK: - S3DataMiddleware
class S3DataMiddleware(AgentMiddleware):
    def __init__(self, bucket_name: str, run_name: str):
        super().__init__()
        from botocore.config import Config

        # Read AWS credentials from environment (loaded via .env if present)
        aws_access_key_id = os.getenv("AWS_ACCESS_KEY_ID")
        aws_secret_access_key = os.getenv("AWS_SECRET_ACCESS_KEY")
        aws_endpoint_url = os.getenv("AWS_ENDPOINT_URL")
        aws_session_token = os.getenv("AWS_SESSION_TOKEN")
        aws_region = os.getenv("AWS_REGION") or os.getenv("AWS_DEFAULT_REGION")

        # Create session first (match your working code exactly - no region in session)
        session_kwargs = {}
        if aws_access_key_id and aws_secret_access_key:
            session_kwargs["aws_access_key_id"] = aws_access_key_id
            session_kwargs["aws_secret_access_key"] = aws_secret_access_key
        if aws_session_token:
            session_kwargs["aws_session_token"] = aws_session_token
        # Note: Do NOT add region_name here for R2 compatibility

        s3_session = boto3.Session(**session_kwargs)

        # Create client from session with endpoint and config
        client_kwargs = {}
        if aws_endpoint_url:
            client_kwargs["endpoint_url"] = aws_endpoint_url
        client_kwargs["config"] = Config(signature_version="s3v4")

        self.s3_client = s3_session.client("s3", **client_kwargs)
        self.bucket = bucket_name
        self.run_name = run_name
        self.tools = [self._create_read_s3_tool(), self._create_write_s3_tool()]

    # MARK: - Tool: Read from S3
    def _create_read_s3_tool(self):
        @tool
        def read_from_s3(key: str) -> str:
            """Read a file from S3.
            For input data, use:
              - transcripts/transcript.txt (text file)
              - company_descriptions/companies.json (JSON file)
              - press_releases/releases.json (JSON file)
            For run outputs, use: <filename> (will be scoped to current run automatically)
            """
            # If key doesn't have a prefix, assume it's a run output
            if "/" not in key:
                full_key = f"deepagent_runs/{self.run_name}/{key}"
            else:
                full_key = key

            try:
                response = self.s3_client.get_object(Bucket=self.bucket, Key=full_key)
                return response["Body"].read().decode("utf-8")
            except Exception as e:
                return f"Error reading {full_key} from S3: {str(e)}"

        return read_from_s3

    # MARK: - Tool: Write to S3
    def _create_write_s3_tool(self):
        @tool
        def write_to_s3(key: str, content: str) -> str:
            """Write content to S3 in the current run directory.
            All files are automatically scoped to deepagent_runs/<run_name>/

            Examples:
              - 'result.json' -> 'deepagent_runs/run_name/result.json'
              - 'company_matches/batch_0.json' -> 'deepagent_runs/run_name/company_matches/batch_0.json'
            """
            # Always scope to run directory
            full_key = f"deepagent_runs/{self.run_name}/{key}"

            try:
                self.s3_client.put_object(
                    Bucket=self.bucket, Key=full_key, Body=content.encode("utf-8")
                )
                return f"Successfully wrote {full_key} to S3"
            except Exception as e:
                return f"Error writing {full_key} to S3: {str(e)}"

        return write_to_s3
