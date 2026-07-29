# x-listening

Polls 20 X accounts via TwitterAPI.io every 5 minutes and posts new tweets to the `#x-alerts` Slack channel.

## Run locally

```bash
npm install
npm start
```

First run seeds state (records latest tweet per account) without alerting, so you don't get a flood of historical tweets dumped into Slack. Every run after that alerts only on genuinely new tweets.

## Deploy to Railway (once you're ready to make this always-on)

1. Push this folder to a new GitHub repo (keep `.env` out of it — it's gitignored)
2. In Railway: New Project → Deploy from GitHub repo
3. Add the two environment variables from `.env` (`TWITTERAPI_IO_KEY`, `SLACK_WEBHOOK_URL`) in Railway's Variables tab
4. Set the start command to `npm start` if not auto-detected
5. Railway keeps it running continuously — no external cron needed, `setInterval` handles the 5-min loop internally

## Editing the tracked accounts

Edit `accounts.json` — no code changes needed, just the array of handles (without the `@`).
