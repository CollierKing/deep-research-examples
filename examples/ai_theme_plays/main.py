from agent import agent
from config import RUN_NAME, S3_BUCKET_NAME

print("\n🚀 Starting Deep Agent Pipeline...")
print("=" * 60)
print(f"Run Name: {RUN_NAME}")
print(f"S3 Bucket: {S3_BUCKET_NAME}")
print(f"Output Path: deepagent_runs/{RUN_NAME}/")
print("=" * 60)

# Use run name as thread_id for checkpointing
config = {"configurable": {"thread_id": RUN_NAME}}

result = agent.invoke(
    {"messages": [{"role": "user", "content": "Execute the 3-step analysis pipeline"}]},
    config=config
)

print("\n" + "=" * 60)
print("✅ Pipeline Complete!")
print("=" * 60)

# Print message count
messages = result.get("messages", [])
print(f"\nTotal messages: {len(messages)}")

# Print last message (full content)
if messages:
    last_msg = messages[-1]
    print(f"\nLast message type: {type(last_msg).__name__}")
    if hasattr(last_msg, 'content'):
        content = str(last_msg.content)
        print(f"\n{'=' * 60}")
        print("FINAL RESULT:")
        print('=' * 60)
        print(content)
        print('=' * 60)
    
# Check todos
if "todos" in result:
    print(f"\nTodos completed: {len(result['todos'])}")

print(f"\n✅ Check S3 bucket at: deepagent_runs/{RUN_NAME}/")
print("   - themes_analysis.json")
print("   - matched_companies.json")
print("   - validated_results.json")

# Save final result to S3
if messages and hasattr(messages[-1], 'content'):
    from middleware import S3DataMiddleware
    s3_middleware = S3DataMiddleware(bucket_name=S3_BUCKET_NAME, run_name=RUN_NAME)
    write_to_s3 = s3_middleware.tools[1]
    
    final_content = str(messages[-1].content)
    result = write_to_s3.invoke({
        "key": "final_report.txt",
        "content": final_content
    })
    print(f"   - final_report.txt")
    print(f"\n{result}")

print("\n" + "=" * 60)