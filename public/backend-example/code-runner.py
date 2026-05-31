"""
============================================
AI CODE STUDIO - CODE RUNNER (FastAPI + Docker)
Safe code execution in isolated containers
============================================
"""

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from typing import Optional
import docker
import asyncio
import uuid
import os
import tempfile
import shutil

app = FastAPI(title="AI Code Studio - Code Runner")
client = docker.from_env()

# Language configurations
LANGUAGES = {
    "python": {
        "image": "python:3.11-slim",
        "extension": ".py",
        "command": ["python", "/code/main.py"],
    },
    "javascript": {
        "image": "node:20-slim",
        "extension": ".js",
        "command": ["node", "/code/main.js"],
    },
    "typescript": {
        "image": "node:20-slim",
        "extension": ".ts",
        "command": ["npx", "ts-node", "/code/main.ts"],
        "setup": ["npm", "install", "-g", "typescript", "ts-node"],
    },
    "go": {
        "image": "golang:1.21-alpine",
        "extension": ".go",
        "command": ["go", "run", "/code/main.go"],
    },
    "rust": {
        "image": "rust:1.73-slim",
        "extension": ".rs",
        "command": ["sh", "-c", "rustc /code/main.rs -o /tmp/main && /tmp/main"],
    },
}


class RunRequest(BaseModel):
    language: str
    code: str
    stdin: Optional[str] = ""
    timeout: Optional[int] = 10
    memory_limit: Optional[int] = 256


class RunResponse(BaseModel):
    stdout: str
    stderr: str
    exit_code: int
    execution_time_ms: int


@app.post("/run", response_model=RunResponse)
async def run_code(request: RunRequest):
    """Execute code in an isolated Docker container."""
    
    if request.language not in LANGUAGES:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported language: {request.language}. Supported: {list(LANGUAGES.keys())}"
        )
    
    config = LANGUAGES[request.language]
    run_id = str(uuid.uuid4())[:8]
    
    # Create temporary directory for code
    temp_dir = tempfile.mkdtemp(prefix=f"runner_{run_id}_")
    
    try:
        # Write code to file
        code_file = os.path.join(temp_dir, f"main{config['extension']}")
        with open(code_file, "w") as f:
            f.write(request.code)
        
        # Write stdin if provided
        stdin_file = os.path.join(temp_dir, "stdin.txt")
        with open(stdin_file, "w") as f:
            f.write(request.stdin or "")
        
        # Run in container
        container = None
        start_time = asyncio.get_event_loop().time()
        
        try:
            # Create container with resource limits
            container = client.containers.create(
                image=config["image"],
                command=config["command"],
                volumes={
                    temp_dir: {"bind": "/code", "mode": "ro"}
                },
                stdin_open=bool(request.stdin),
                mem_limit=f"{request.memory_limit}m",
                nano_cpus=int(0.5 * 1e9),  # 0.5 CPU
                network_disabled=True,
                read_only=True,
                tmpfs={"/tmp": "size=100M"},
                user="nobody",
            )
            
            # Start and wait
            container.start()
            
            # Attach and send stdin if needed
            if request.stdin:
                socket = container.attach_socket(params={"stdin": 1, "stream": 1})
                socket._sock.sendall(request.stdin.encode())
                socket._sock.shutdown(1)
            
            # Wait with timeout
            result = container.wait(timeout=request.timeout)
            
            # Get output
            stdout = container.logs(stdout=True, stderr=False).decode("utf-8")
            stderr = container.logs(stdout=False, stderr=True).decode("utf-8")
            exit_code = result.get("StatusCode", 1)
            
        except docker.errors.APIError as e:
            if "timeout" in str(e).lower():
                stdout = ""
                stderr = f"Execution timeout after {request.timeout} seconds"
                exit_code = 124
            else:
                raise
        
        finally:
            # Cleanup container
            if container:
                try:
                    container.remove(force=True)
                except:
                    pass
        
        end_time = asyncio.get_event_loop().time()
        execution_time_ms = int((end_time - start_time) * 1000)
        
        return RunResponse(
            stdout=stdout,
            stderr=stderr,
            exit_code=exit_code,
            execution_time_ms=execution_time_ms,
        )
    
    finally:
        # Cleanup temp directory
        shutil.rmtree(temp_dir, ignore_errors=True)


@app.get("/languages")
async def get_languages():
    """Get list of supported languages."""
    return {
        "languages": list(LANGUAGES.keys()),
        "details": {
            lang: {"image": config["image"], "extension": config["extension"]}
            for lang, config in LANGUAGES.items()
        }
    }


@app.get("/health")
async def health_check():
    """Health check endpoint."""
    try:
        client.ping()
        return {"status": "healthy", "docker": "connected"}
    except:
        return {"status": "unhealthy", "docker": "disconnected"}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
