# Miner CLI Tool

Command-line interface for miners to interact with the Platform API.

## Installation

Ensure you have the required dependencies:

```bash
pip install -r requirements.txt
```

## Usage

### Upload Agent

Upload your agent text file (.txt) to the platform:

```bash
python -m miner upload \
    --agent-file ../../examples/agent.txt \
    --coldkey ckorintest1 \
    --hotkey hk1 \
    --name "My AlignNet Agent" \
    --api-url http://localhost:8000
```

### Options

**Required:**

- `--agent-file PATH` - Path to your agent text file (.txt)
- `--hotkey HOTKEY` - Your miner's hotkey (hot wallet name)
- `--coldkey COLDKEY` - Your miner's coldkey (cold wallet name)
- `--name NAME` - Human-readable name for your agent

**Optional:**

- `--api-url URL` - Platform API URL (default: http://localhost:8000)
- `--no-verify-ssl` - Disable SSL verification (not recommended for production)

## Examples

### Basic Upload (Development)

```bash
python -m miner upload \
    --agent-file ../../examples/agent.txt \
    --coldkey ckorintest1 \
    --hotkey hk1 \
    --name "My AlignNet Agent" \
    --api-url http://localhost:8000
```

### Upload to Production API

```bash
python -m miner upload \
    --agent-file ../../examples/agent.txt \
    --coldkey ckorintest1 \
    --hotkey hk1 \
    --name "My AlignNet Agent" \
    --api-url https://platform-api.alignnet.io
```

### Upload with Development/Testing Options

```bash
python -m miner upload \
    --agent-file ../../examples/agent.txt \
    --coldkey ckorintest1 \
    --hotkey hk1 \
    --name "My AlignNet Agent" \
    --api-url http://localhost:8000
```

## Agent File Requirements

Your agent file must:

1. Be a `.txt` text file
2. Not be empty
3. Contain the agent code/content
