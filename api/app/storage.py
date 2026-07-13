import json


def load_json(path: str) -> dict:
    with open(path) as f:
        return json.load(f)


def save_json(path: str, data: dict) -> None:
    with open(path, "w") as f:
        json.dump(data, f, indent=2)
