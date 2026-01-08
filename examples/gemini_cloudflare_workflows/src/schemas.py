"""
Database schemas for Deep Research Workflow.
"""

from sqlalchemy import MetaData, Table, Column, String, Integer, Text


metadata = MetaData()

deep_research_jobs = Table(
    'deep_research_jobs',
    metadata,
    Column('job_id', String, primary_key=True),
    Column('ticker', String),
    Column('earnings_date', String),
    Column('status', String),
    Column('workflow_id', String),
    Column('gemini_interaction_id', String),
    Column('filestore_name', String),
    Column('transcript_count', Integer),
    Column('press_release_count', Integer),
    Column('result_text', Text),
    Column('error_message', Text),
    Column('created_at', String),
    Column('updated_at', String),
    Column('completed_at', String),
)
