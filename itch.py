import json
import urllib.request
from html.parser import HTMLParser

URL = "https://itch.io/games/newest/on-sale"


class GameParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.games = []
        self.current = None
        self.in_title = False

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)

        classes = attrs.get("class", "").split()

        if tag == "div" and "game_cell" in classes:
            self.current = {
                "id": attrs.get("data-game_id"),
                "title": None,
                "url": None,
            }

        if self.current and tag == "a" and "title" in classes:
            self.in_title = True
            self.current["url"] = attrs.get("href")

    def handle_data(self, data):
        if self.current and self.in_title:
            title = data.strip()
            if title:
                self.current["title"] = title

    def handle_endtag(self, tag):
        if tag == "a":
            self.in_title = False

        if tag == "div" and self.current:
            if self.current["title"]:
                self.games.append(self.current)
            self.current = None


def main():
    request = urllib.request.Request(
        URL,
        headers={
            "User-Agent": "Mozilla/5.0"
        }
    )

    with urllib.request.urlopen(request, timeout=20) as response:
        html = response.read().decode("utf-8")

    parser = GameParser()
    parser.feed(html)

    print(f"Found {len(parser.games)} games")

    for game in parser.games[:10]:
        print(game)


if __name__ == "__main__":
    main()
