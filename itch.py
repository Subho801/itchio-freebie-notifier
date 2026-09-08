import json
import os

RESULT_FILE = "result.json"
STATE_FILE = "itch_state.json"


def load_json(filename, default):
    try:
        with open(filename, "r", encoding="utf-8") as file:
            return json.load(file)
    except (FileNotFoundError, json.JSONDecodeError):
        return default


def save_state(game_ids):
    with open(STATE_FILE, "w", encoding="utf-8") as file:
        json.dump({"games": sorted(game_ids)}, file, indent=2)


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

    # Only games with an expiry date are eligible for notification.
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

    if new_games:
        print("\n========== NEW GAMES ==========")

        for game in new_games:
            print(f"Title:   {game.get('title')}")
            print(f"ID:      {game.get('id')}")
            print(f"Expiry:  {game.get('expires')}")
            print(f"URL:     {game.get('url')}")
            print("--------------------------------")

    # Save only after successful processing.
    save_state(current_ids)

    print("✅ State updated.")


if __name__ == "__main__":
    main()
