import json
import os
from datetime import datetime

RESULT_FILE = "result.json"
STATE_FILE = "itch_state.json"

DISCORD_WEBHOOK = os.getenv("DISCORD_WEBHOOK")
DISCORD_ROLE_ID = os.getenv("DISCORD_ROLE_ID")

ITCH_LOGO_URL = "https://file.garden/afbSsuts32dZ5wSl/itch.io-logo_brandlogos.net_bhtjr.png"
RONALDO_IMAGE_URL = "https://files.catbox.moe/qttqpy.png"


def load_json(filename, default):
    try:
        with open(filename, "r", encoding="utf-8") as file:
            return json.load(file)
    except (FileNotFoundError, json.JSONDecodeError):
        return default


def save_state(game_ids):
    with open(STATE_FILE, "w", encoding="utf-8") as file:
        json.dump({"games": sorted(game_ids)}, file, indent=2)


def discord_timestamp(iso_date):
    if not iso_date:
        return "Unknown"

    try:
        dt = datetime.fromisoformat(iso_date.replace("Z", "+00:00"))
        timestamp = int(dt.timestamp())
        return f"<t:{timestamp}:F> (<t:{timestamp}:R>)"
    except Exception:
        return iso_date


def send_discord(game):
    if not DISCORD_WEBHOOK:
        print("❌ DISCORD_WEBHOOK is not configured.")
        return False

    import urllib.request
    import urllib.error

    title = game.get("title", "Unknown Game")
    url = game.get("url", "")
    expires = game.get("expires", "Unknown")

    payload = {
        "content": f"<@&{DISCORD_ROLE_ID}>",
        "embeds": [
            {
                "author": {
                    "name": "Itch.io - Freebie",
                    "icon_url": "https://file.garden/afbSsuts32dZ5wSl/itch.io-logo_brandlogos.net_bhtjr.png"
                },
                "title": title,
                "url": url,
                "fields": [
                    {
                        "name": "Ends",
                        "value": f"{expires}\n<t:{discord_timestamp(expires)}:R>",
                        "inline": False
                    }
                ],
                "footer": {
                    "text": "Subho's Itch.io Freebie Informer",
                    "icon_url": "https://files.catbox.moe/qttqpy.png"
                }
            }
        ]
    }

    if game.get("image"):
        payload["embeds"][0]["image"] = {
            "url": game["image"]
        }

    data = json.dumps(payload).encode("utf-8")

    request = urllib.request.Request(
        DISCORD_WEBHOOK,
        data=data,
        headers={
            "Content-Type": "application/json",
            "User-Agent": "Subho-Itch-Notifier/1.0"
        },
        method="POST"
    )

    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            print(f"✅ Discord notification sent: {title}")
            return True

    except urllib.error.HTTPError as error:
        print(f"❌ Discord notification failed: HTTP {error.code}")

        try:
            body = error.read().decode("utf-8", errors="replace")
            print(f"📩 Discord response: {body}")
        except Exception:
            pass

        return False

    except Exception as error:
        print(f"❌ Discord notification failed: {error}")
        return False
def main():
    print("[1] Loading scraped games...")

    result = load_json(RESULT_FILE, {})
    games = result.get("games", [])

    if not games:
        print("❌ No games found in result.json.")
        print("⚠️ State will NOT be changed.")
        return

    print(f"✅ Found {len(games)} scraped games.")

    state = load_json(STATE_FILE, {"games": []})
    previous_ids = set(state.get("games", []))

    eligible_games = [
        game
        for game in games
        if game.get("expires") and game.get("id")
    ]

    current_ids = {
        str(game["id"])
        for game in eligible_games
    }

    new_games = [
        game
        for game in eligible_games
        if str(game["id"]) not in previous_ids
    ]

    print(f"✅ {len(eligible_games)} games have expiry dates.")
    print(f"🆕 {len(new_games)} newly discovered games.")

    if not new_games:
        print("ℹ️ No new games — nothing to notify.")
        return

    successful_ids = set(previous_ids)

    print("\n========== NEW GAMES ==========")

    for game in new_games:
    print(f"🎁 Sending Discord notification: {game.get('title', 'Unknown Game')}")

    if send_discord(game):
        successful_ids.add(str(game["id"]))
    else:
        print("⚠️ Notification failed — game will NOT be marked as sent.")
        
    save_state(successful_ids)

    print("✅ State updated.")


if __name__ == "__main__":
    main()
