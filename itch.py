import json
import os
import time
from datetime import datetime

RESULT_FILE = "result.json"
STATE_FILE = "itch_state.json"

DISCORD_WEBHOOK = os.getenv("DISCORD_WEBHOOK")
DISCORD_ROLE_ID = os.getenv("DISCORD_ROLE_ID")

ITCH_LOGO_URL = "https://file.garden/afbSsuts32dZ5wSl/itch.io-logo_brandlogos.net_bhtjr.png"
RONALDO_IMAGE_URL = "https://files.catbox.moe/qttqpy.png"

# Delay between normal Discord webhook requests
DISCORD_DELAY = 2

# Maximum number of retries after Discord rate-limits us
DISCORD_MAX_RETRIES = 5


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
    expires = game.get("expires")

    if not expires:
        print(f"⚠️ {title} has no expiry date.")
        return False

    payload = {
        "content": f"<@&{DISCORD_ROLE_ID}>",
        "embeds": [
            {
                "author": {
                    "name": "Itch.io - Freebie",
                    "icon_url": ITCH_LOGO_URL
                },
                "title": title,
                "url": url,
                "fields": [
                    {
                        "name": "Ends",
                        "value": discord_timestamp(expires),
                        "inline": False
                    }
                ],
                "footer": {
                    "text": "Subho's Itch.io Freebie Informer",
                    "icon_url": RONALDO_IMAGE_URL
                }
            }
        ]
    }

    image_url = game.get("image")

    if image_url:
        payload["embeds"][0]["image"] = {
            "url": image_url
        }

    data = json.dumps(payload).encode("utf-8")

    for attempt in range(1, DISCORD_MAX_RETRIES + 1):

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

            # Discord rate limit
            if error.code == 429:
                retry_after = None

                try:
                    body = error.read().decode("utf-8", errors="replace")

                    if body:
                        response_data = json.loads(body)
                        retry_after = response_data.get("retry_after")

                except Exception:
                    pass

                # Fall back to HTTP Retry-After header
                if retry_after is None:
                    header_value = error.headers.get("Retry-After")

                    if header_value:
                        try:
                            retry_after = float(header_value)
                        except ValueError:
                            retry_after = None

                # Final fallback
                if retry_after is None:
                    retry_after = 5

                print(
                    f"⏳ Discord rate limited '{title}'. "
                    f"Waiting {retry_after:.2f}s "
                    f"(attempt {attempt}/{DISCORD_MAX_RETRIES})..."
                )

                time.sleep(retry_after)
                continue

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

    print(
        f"❌ Discord notification abandoned after "
        f"{DISCORD_MAX_RETRIES} rate-limit retries: {title}"
    )

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
    previous_ids = {
        str(game_id)
        for game_id in state.get("games", [])
    }

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

    for index, game in enumerate(new_games):

        print(
            f"\n🎁 [{index + 1}/{len(new_games)}] "
            f"Sending Discord notification: "
            f"{game.get('title', 'Unknown Game')}"
        )

        if send_discord(game):
            successful_ids.add(str(game["id"]))

            # Delay before the next webhook request
            if index < len(new_games) - 1:
                print(f"⏳ Waiting {DISCORD_DELAY}s before next notification...")
                time.sleep(DISCORD_DELAY)

        else:
            print(
                "⚠️ Notification failed — "
                "game will NOT be marked as sent."
            )

    save_state(successful_ids)

    sent_count = len(successful_ids - previous_ids)
    failed_count = len(new_games) - sent_count

    print("\n========== SUMMARY ==========")
    print(f"✅ Successfully sent: {sent_count}")
    print(f"❌ Failed: {failed_count}")
    print(f"💾 State saved with {len(successful_ids)} games.")
    print("================================")


if __name__ == "__main__":
    main()
