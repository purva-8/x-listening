import 'dotenv/config';
import fetch from 'node-fetch';
import fs from 'fs/promises';
import accounts from './accounts.json' with { type: 'json' };
import keywords from './keywords.json' with { type: 'json' };

const API_KEY = process.env.TWITTERAPIS_KEY;
const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL;
const ACCOUNT_POLL_INTERVAL_MS = Number(process.env.ACCOUNT_POLL_INTERVAL_MS ?? 600000); // 10 min
const KEYWORD_POLL_INTERVAL_MS = Number(process.env.KEYWORD_POLL_INTERVAL_MS ?? 1200000); // 20 min (0 = disabled/paused)
const NEGATIVE_FILTER_TERMS = ['hiring', 'hire', 'job', 'jobs', 'recruiting', 'recruiter', 'we\'re hiring'];
const STATE_FILE = new URL('./state.json', import.meta.url);

if (!API_KEY || !SLACK_WEBHOOK_URL) {
  throw new Error('Missing TWITTERAPIS_KEY or SLACK_WEBHOOK_URL in .env');
}

async function loadState() {
  try {
    return JSON.parse(await fs.readFile(STATE_FILE, 'utf8'));
  } catch {
    return {};
  }
}

async function saveState(state) {
  await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2));
}

async function fetchLatestTweets(username) {
  const res = await fetch(
    `https://api.twitterapis.com/twitter/tweet/advanced_search?query=${encodeURIComponent(`from:${username}`)}`,
    { headers: { Authorization: `Bearer ${API_KEY}` } }
  );
  if (!res.ok) {
    throw new Error(`TwitterAPIs.com error for @${username}: ${res.status} ${await res.text()}`);
  }
  const data = await res.json();
  return data?.tweets ?? [];
}

async function postToSlack(username, tweet) {
  const text = tweet.text ?? tweet.full_text ?? '';
  const tweetId = tweet.id ?? tweet.id_str;
  const url = `https://x.com/${username}/status/${tweetId}`;
  const body = {
    text: `*New tweet from @${username}*\n${text}\n${url}`,
  };
  await sendToSlack(body);
}

function isNegativeMatch(text) {
  const lower = (text ?? '').toLowerCase();
  return NEGATIVE_FILTER_TERMS.some((term) => lower.includes(term));
}

async function fetchLatestForKeyword(keyword) {
  const exclusions = NEGATIVE_FILTER_TERMS.map((t) => `-${t.includes(' ') ? `"${t}"` : t}`).join(' ');
  const query = `${keyword} ${exclusions}`;
  const res = await fetch(
    `https://api.twitterapis.com/twitter/tweet/advanced_search?query=${encodeURIComponent(query)}`,
    { headers: { Authorization: `Bearer ${API_KEY}` } }
  );
  if (!res.ok) {
    throw new Error(`TwitterAPIs.com error for keyword "${keyword}": ${res.status} ${await res.text()}`);
  }
  const data = await res.json();
  const tweets = data?.tweets ?? [];
  // client-side safety net in case the search-operator exclusion isn't honored server-side
  return tweets.filter((t) => !isNegativeMatch(t.text ?? t.full_text));
}

async function postKeywordMatchToSlack(keyword, tweet) {
  const text = tweet.text ?? tweet.full_text ?? '';
  const tweetId = tweet.id ?? tweet.id_str;
  const author = tweet.author?.userName ?? tweet.author?.screen_name ?? 'unknown';
  const url = `https://x.com/${author}/status/${tweetId}`;
  const body = {
    text: `*Keyword match: "${keyword}"* (from @${author})\n${text}\n${url}`,
  };
  await sendToSlack(body);
}

async function sendToSlack(body) {
  const res = await fetch(SLACK_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    console.error(`Slack post failed: ${res.status} ${await res.text()}`);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pollOnce(state) {
  for (const username of accounts) {
    try {
      await sleep(1200); // small pacing gap between calls
      const tweets = await fetchLatestTweets(username);
      if (!tweets.length) continue;

      const lastSeenId = state[username];
      const newTweets = lastSeenId
        ? tweets.filter((t) => {
            const id = t.id ?? t.id_str;
            return BigInt(id) > BigInt(lastSeenId);
          })
        : [tweets[0]]; // first run: just record latest, don't spam-alert on history

      if (lastSeenId) {
        for (const tweet of newTweets.reverse()) {
          await postToSlack(username, tweet);
        }
      }

      state[username] = String(tweets[0].id ?? tweets[0].id_str);
    } catch (err) {
      console.error(`[${new Date().toISOString()}] Error polling @${username}:`, err.message);
    }
  }
  await saveState(state);
}

async function pollKeywordsOnce(state) {
  for (const keyword of keywords) {
    try {
      await sleep(1200);
      const tweets = await fetchLatestForKeyword(keyword);
      if (!tweets.length) continue;

      const stateKey = `keyword:${keyword}`;
      const lastSeenId = state[stateKey];
      const newTweets = lastSeenId
        ? tweets.filter((t) => {
            const id = t.id ?? t.id_str;
            return BigInt(id) > BigInt(lastSeenId);
          })
        : [tweets[0]]; // first run: seed only, don't alert on history

      if (lastSeenId) {
        for (const tweet of newTweets.reverse()) {
          await postKeywordMatchToSlack(keyword, tweet);
        }
      }

      state[stateKey] = String(tweets[0].id ?? tweets[0].id_str);
    } catch (err) {
      console.error(`[${new Date().toISOString()}] Error polling keyword "${keyword}":`, err.message);
    }
  }
  await saveState(state);
}

async function main() {
  if (process.env.PAUSED === 'true') {
    console.log('x-listening is PAUSED (PAUSED=true). No API calls will be made. Set PAUSED=false or remove the variable to resume.');
    return;
  }

  const keywordStatus = KEYWORD_POLL_INTERVAL_MS > 0
    ? `every ${KEYWORD_POLL_INTERVAL_MS / 1000}s`
    : 'PAUSED';
  console.log(`Starting x-listening. Tracking ${accounts.length} accounts (every ${ACCOUNT_POLL_INTERVAL_MS / 1000}s) + ${keywords.length} keywords (${keywordStatus}).`);
  let state = await loadState();
  await pollOnce(state); // seed state on first run so we don't dump history into Slack
  setInterval(() => pollOnce(state), ACCOUNT_POLL_INTERVAL_MS);

  if (KEYWORD_POLL_INTERVAL_MS > 0) {
    await pollKeywordsOnce(state);
    setInterval(() => pollKeywordsOnce(state), KEYWORD_POLL_INTERVAL_MS);
  } else {
    console.log('Keyword sweep is paused (KEYWORD_POLL_INTERVAL_MS not set).');
  }
}

main();
