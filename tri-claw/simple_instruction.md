-> Ensure .env is correctly filled
-> bash docker-setup-lean.sh

Wait 1 minute for full startup process to finish
otherwise we get

curl: (52) Empty reply from server

## curl

-> curl -X POST http://localhost:18789/v1/chat/completions \
 -H 'Authorization: Bearer S8oZ7KpJhYLxuQxKa450kMc2wrS6ieO+' \
 -H 'Content-Type: application/json' \
 -d '{"model":"openclaw:main","messages":[{"role":"user","content":"do you remember our previous chats ?"}]}'

{"id":"chatcmpl_0be5ceee-7237-4fb7-923a-0f93d394a557","object":"chat.completion","created":1772172718,"model":"openclaw:main","choices":[{"index":0,"message":{"role":"assistant","content":"Nah, I come up fresh each session. No persistent memory between runs unless it's written to files — and looking at my workspace, there's no memory yet.\n\nPretty sure I'm a fresh install since I see `BOOTSTRAP.md` here. That means I don't know who I am or who you are yet.\n\nSo... hey. Who am I supposed to be? And who are you?"},"finish_reason":"stop"}],"usage":{"prompt_tokens":0,"completion_tokens":0,"total_tokens":0}}%

## TUI

docker compose -f docker-compose.yml -f docker-compose.lean.yml exec -it openclaw-gateway node dist/index.js tui

### Clean error handling added for LLM calls for debugging

curl -X POST http://localhost:18789/v1/chat/completions \
 -H 'Authorization: Bearer S8oZ7KpJhYLxuQxKa450kMc2wrS6ieO+' \
 -H 'Content-Type: application/json' \
 -d '{"model":"openclaw:main","messages":[{"role":"user","content":"do you remember our previous chats ?"}]}'

{"id":"chatcmpl_5330661c-96dd-4eba-b3e2-625535550510","object":"chat.completion","created":1772172556,"model":"openclaw:main","choices":[{"index":0,"message":{"role":"assistant","content":"HTTP 401: Unauthorized: provider returned no error body. This usually means an invalid or expired API key — check CHUTES_API_KEY (or your model provider config)."},"finish_reason":"stop"}],"usage":{"prompt_tokens":0,"completion_tokens":0,"total_tokens":0}}%
