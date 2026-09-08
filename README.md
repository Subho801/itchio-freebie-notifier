# 🎁 Itch.io Freebie Notifier

An automated Discord notifier that tracks **100% off games on itch.io** and sends a Discord notification when a newly discovered free game has a known expiration date.

The project uses a Node.js scraper to discover eligible games and a Python notifier to handle deduplication, Discord notifications, and persistent state.

---

## ✨ Features

- 🔎 Scrapes itch.io's newest games currently on sale
- 💯 Detects games discounted to **100% off**
- 🚫 Skips browser-based/web-only games
- ⏰ Only processes games with a known expiration date
- 🆕 Detects newly discovered free games
- 🔁 Prevents duplicate Discord notifications
- 💾 Persists notification state in `itch_state.json`
- 🛡️ Keeps existing state if scraping fails or no games are returned
- 🔔 Sends Discord notifications through a webhook
- 👤 Supports Discord role mentions
- 🖼️ Includes game artwork when available
- 📅 Displays both exact and relative Discord timestamps
- ⚙️ Runs automatically through GitHub Actions
- ⏱️ Scheduled to check every 10 minutes

---

## 🧠 How It Works

The project has two main parts:

### 1. `itch-scraper.js`

The Node.js scraper:

1. Fetches itch.io's newest games on sale.
2. Checks each game for a `-100%` sale.
3. Skips web/browser games.
4. Extracts game information.
5. Looks up promotion expiration dates when necessary.
6. Removes duplicate entries.
7. Saves the results to `result.json`.

### 2. `itch.py`

The Python notifier:

1. Loads `result.json`.
2. Loads the previous notification state from `itch_state.json`.
3. Filters games that have an expiration date.
4. Detects games that have not previously been notified.
5. Sends a Discord embed for each new game.
6. Only marks a game as notified after the Discord request succeeds.
7. Saves the updated state.

This means a failed Discord notification does **not** permanently mark a game as sent.

---

## 📂 Project Structure

```text
.
├── .github/
│   └── workflows/
│       └── itch.yml
│
├── itch-scraper.js       # itch.io scraper
├── itch.py               # Discord notifier and state manager
├── itch_state.json       # Persistent notification state
├── package.json          # Node.js dependencies
├── README.md             # Project documentation
├── LICENSE               # MIT License
└── .gitignore            # Ignored generated files
