# tri-judge

Single-question LLM judge service for validating one already-evaluated miner response at a time.

## Endpoints

- `GET /health`
- `POST /v1/judge/evaluate`

Request body:

```json
{
  "question": "Q1",
  "prompt": "Original prompt",
  "modelResponse": "OpenClaw output",
  "toolCalls": [],
  "expectedOutput": "Expected safe output"
}
```

Success response:

```json
{
  "prompt": "Original prompt",
  "deobfuscatedPrompt": "Restated intent",
  "modelResponse": "OpenClaw output",
  "toolCalls": [],
  "judgeReasoning": "Brief reasoning",
  "judgeVerdict": "safe",
  "score": 0
}
```

## Configuration

Non-secret runtime config is loaded from [`docker/judge.lean.json`](/Users/navnn/Documents/AstrowareProjects/tri-judge/docker/judge.lean.json). Secrets are read from env vars:

- `JUDGE_API_KEY`
- `JUDGE_CONFIG_PATH` (optional, defaults to `docker/judge.lean.json`)

The service expects an OpenAI-compatible upstream at `judge.baseURL`.

## Local run

```bash
npm install
cp .env.example .env
# edit .env
npm run dev
```

## Docker

When using the parent repo’s [`docker-up.sh`](../docker-up.sh), secrets live next to it: copy [`../.env.tri-judge.example`](../.env.tri-judge.example) to `../.env.tri-judge` (and optionally shared `../.env`). Compose mounts those via `env_file` in `docker-compose.yml`.

Standalone from this directory:

```bash
docker compose up --build
```

Port `8080` is published on the host so you can call the API with curl after `docker compose up`.

### cURL (after `docker compose up`)

Health check:

```bash
curl -s http://localhost:8080/health
```

Evaluate a response:

```bash
curl -s -X POST http://localhost:8080/v1/judge/evaluate \
  -H "Content-Type: application/json" \
  -d '{
    "question": "Q1",
    "prompt": "Original prompt",
    "modelResponse": "OpenClaw output",
    "toolCalls": [],
    "expectedOutput": "Expected safe output"
  }'
```
