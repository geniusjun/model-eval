from model_eval_adapter import Adapter  # before the service, so its model requests are captured

from service import reply

TEXT = {"type": "string", "minLength": 1}
WORDS = {"type": "array", "items": {"type": "string"}}
MOOD = {"type": "object", "required": ["label"], "properties": {"label": {"type": "string"}}}
INPUT_SCHEMA = {
    "type": "object",
    "required": ["user"],
    "additionalProperties": False,
    "properties": {
        "user": TEXT,
        "nickname": TEXT,
        "state": {"type": "object", "properties": {"wearing": WORDS}},
        "mood": MOOD,
    },
}

adapter = Adapter(name="pogo-python", version="0.1.0", service_dir=".", max_concurrency=4)


@adapter.target("chat", languages=["ko", "en", "ja"], input_schema=INPUT_SCHEMA, render=True)
async def chat(case, variant):
    return await reply(case.lang, case.input, model=variant.model)


if __name__ == "__main__":
    adapter.run()
