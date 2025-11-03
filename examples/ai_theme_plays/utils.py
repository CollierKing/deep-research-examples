# MARK: - Imports
import os
from typing import List, Dict, Any, Optional
from dotenv import load_dotenv, find_dotenv
import psycopg2
from psycopg2.extras import RealDictCursor
from pymongo import MongoClient

# MARK: - Environment
load_dotenv(find_dotenv(), override=False)


# MARK: - PostgreSQL Utilities
def query_postgres(sql: str, params: Optional[tuple] = None) -> List[Dict[str, Any]]:
    """
    Execute a SQL query against PostgreSQL and return results as list of dictionaries.
    
    Args:
        sql: SQL query string (use %s for parameters)
        params: Optional tuple of parameters for parameterized queries
        
    Returns:
        List of dictionaries where each dict represents a row
        
    Example:
        results = query_postgres("SELECT * FROM companies WHERE industry = %s", ("AI",))
        
    Environment Variables Required:
        - POSTGRES_HOST
        - POSTGRES_PORT (default: 5432)
        - POSTGRES_DB
        - POSTGRES_USER
        - POSTGRES_PASSWORD
    """
    conn = None
    cursor = None
    
    try:
        # Get connection details from environment
        host = os.getenv("POSTGRES_HOST")
        port = os.getenv("POSTGRES_PORT", "5432")
        database = os.getenv("POSTGRES_DB")
        user = os.getenv("POSTGRES_USER")
        password = os.getenv("POSTGRES_PASSWORD")
        
        # Validate required variables
        if not all([host, database, user, password]):
            missing = []
            if not host: missing.append("POSTGRES_HOST")
            if not database: missing.append("POSTGRES_DB")
            if not user: missing.append("POSTGRES_USER")
            if not password: missing.append("POSTGRES_PASSWORD")
            raise ValueError(f"Missing required environment variables: {', '.join(missing)}")
        
        # Build connection string for remote database (forces TCP/IP, not Unix socket)
        connection_params = {
            "host": host,
            "port": int(port),
            "dbname": database,
            "user": user,
            "password": password,
            "connect_timeout": 10,
            "sslmode": "prefer"  # Prefer SSL for remote connections
        }
        
        # Connect to remote database
        conn = psycopg2.connect(**connection_params)
        
        # Use RealDictCursor to get results as dictionaries
        cursor = conn.cursor(cursor_factory=RealDictCursor)
        cursor.execute(sql, params)
        
        # Fetch all results
        results = cursor.fetchall()
        
        # Convert RealDictRow to regular dicts
        return [dict(row) for row in results]
        
    except Exception as e:
        raise Exception(f"PostgreSQL query failed: {str(e)}")
        
    finally:
        if cursor:
            cursor.close()
        if conn:
            conn.close()


# MARK: - MongoDB Utilities
def query_mongodb(
    collection_name: str,
    query: Dict[str, Any],
    projection: Optional[Dict[str, Any]] = None,
    limit: Optional[int] = None
) -> List[Dict[str, Any]]:
    """
    Execute a query against MongoDB and return results as list of dictionaries.
    
    Args:
        collection_name: Name of the MongoDB collection to query
        query: MongoDB query filter (e.g., {"industry": "AI"})
        projection: Optional fields to include/exclude (e.g., {"_id": 0, "name": 1})
        limit: Optional limit on number of results
        
    Returns:
        List of dictionaries where each dict represents a document
        
    Example:
        results = query_mongodb(
            "companies",
            {"industry": "AI"},
            {"_id": 0, "name": 1, "description": 1},
            limit=10
        )
        
    Environment Variables Required:
        - MONGODB_URI (full connection string, e.g., mongodb://localhost:27017/)
        - MONGODB_DATABASE
    """
    client = None
    
    try:
        # Get connection details from environment
        mongodb_uri = os.getenv("MONGODB_URI")
        mongodb_database = os.getenv("MONGODB_DATABASE")
        
        if not mongodb_uri or not mongodb_database:
            raise ValueError("MONGODB_URI and MONGODB_DATABASE must be set in environment")
        
        # Connect to MongoDB
        client = MongoClient(mongodb_uri)
        db = client[mongodb_database]
        collection = db[collection_name]
        
        # Build query
        cursor = collection.find(query, projection)
        
        # Apply limit if specified
        if limit:
            cursor = cursor.limit(limit)
        
        # Convert cursor to list of dicts
        results = list(cursor)
        
        # Convert ObjectId to string for JSON serialization
        for result in results:
            if "_id" in result:
                result["_id"] = str(result["_id"])
        
        return results
        
    except Exception as e:
        raise Exception(f"MongoDB query failed: {str(e)}")
        
    finally:
        if client:
            client.close()

