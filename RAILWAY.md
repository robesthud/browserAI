# Deploy to Railway

## Quick start

1. Create a new **Web Service** from this repo.
2. Railway is forced to use **Nixpacks** by `railway.toml`; `nixpacks.toml` contains the Node/build commands.
3. Add a **Volume** and mount it to:

```text
/data
```

4. Deploy.

## What Railway will run

- install: `npm ci`
- build: `npm run build`
- start: `npm start`

## Persistent paths

When `/data` exists, BrowserAI automatically stores runtime data there:

- database: `/data/browserai.db`
- workspace: `/data/workspace`

So on Railway the volume preserves:
- saved API keys
- vault metadata
- workspace files
- file history

## Notes

- `PORT` is taken from Railway automatically.
- If you deploy **without** a mounted volume, the app still runs, but data is ephemeral.
- For public deployment, put the app behind auth / private access if you store sensitive keys.
