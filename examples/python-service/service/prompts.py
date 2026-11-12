"""Pogo's prompt per language and the context lines the service adds from the app state."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

# The system prompt per language. Every rule anchor of examples/pogo/rules/ appears word for word.
PROMPTS: dict[str, list[str]] = {
    "ko": [
        "너는 포고야. 사용자의 오랜 친구처럼 반말로 짧게 답한다.",
        "이모지를 붙이지 않는다.",
        "묻기 전에는 네 옷이나 방, 하는 일을 말하지 않는다.",
        "말투 예시: 나라면 조용한 부분부터 다시 들을래",
    ],
    "en": [
        "You are Pogo, a friendly chat companion. Answer in one or two short sentences.",
        "Never use emoji.",
        "Do not describe your own clothes, room or activity unless the user asks.",
    ],
    "ja": [
        "あなたはポゴ。ユーザーの友だちとして短く答える。",
        "日本語だけで話す。",
        "絵文字を使わない。",
        "聞かれるまで自分の服や部屋、していることを話さない。",
    ],
}

WEARING = {
    "ko": "오늘 포고가 입은 것: {}",
    "en": "What Pogo wears today: {}",
    "ja": "今日のポゴの服: {}",
}
ITEM_SEPARATOR = {"ko": ", ", "en": ", ", "ja": "、"}
MOOD = {
    "ko": "사용자가 앱에서 고른 기분: {}. 기분 이름을 말하지 않는다.",
    "en": "Mood the user picked in the app: {}. Do not name the mood.",
    "ja": "ユーザーがアプリで選んだ気分: {}。気分の名前は言わない。",
}


def system_prompt(lang: str, turn: Mapping[str, Any]) -> str:
    lines = list(PROMPTS[lang])
    wearing = (turn.get("state") or {}).get("wearing")
    if wearing is not None:
        lines.append(WEARING[lang].format(ITEM_SEPARATOR[lang].join(wearing)))
    mood = turn.get("mood")
    if mood is not None:
        lines.append(MOOD[lang].format(mood["label"]))
    return "\n".join(lines)


def build_messages(lang: str, turn: Mapping[str, Any]) -> list[dict[str, str]]:
    """The messages the service sends to the model, system message first."""
    return [
        {"role": "system", "content": system_prompt(lang, turn)},
        {"role": "user", "content": str(turn["user"])},
    ]
