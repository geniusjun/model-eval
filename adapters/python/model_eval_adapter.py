"""model-eval adapter helper for Python services.

One file, standard library only. Copy it next to the adapter (`model-eval init --adapter python`)
and import it before the service. Contract: specs/003-adapter-helpers/contracts/helper-api.md.
"""

from __future__ import annotations

import calendar
import hashlib
import json
import math
import re
import time
from collections.abc import Mapping
from datetime import datetime, timezone
from typing import Any, TypeAlias

HELPER_VERSION = "0.1.0"
PROTOCOL_VERSION = "1"

JsonValue: TypeAlias = "None | bool | int | float | str | list[JsonValue] | dict[str, JsonValue]"


# --- Comparing text (data-model §Comparing Text) -------------------------------------------

# The 25 Unicode White_Space code points of 001 data-model §Trial Outcomes. str.strip() also
# removes U+001C to U+001F, so the helper names them.
WHITE_SPACE = frozenset(
    chr(code_point)
    for code_point in (
        *range(0x0009, 0x000E),
        0x0020,
        0x0085,
        0x00A0,
        0x1680,
        *range(0x2000, 0x200B),
        0x2028,
        0x2029,
        0x202F,
        0x205F,
        0x3000,
    )
)


def trim_text(text: str) -> str:
    """The text without White_Space code points at either end."""
    start, end = 0, len(text)
    while start < end and text[start] in WHITE_SPACE:
        start += 1
    while end > start and text[end - 1] in WHITE_SPACE:
        end -= 1
    return text[start:end]


def is_empty_text(text: str) -> bool:
    """Nothing remains after trimming White_Space from both ends."""
    return trim_text(text) == ""


# --- Canonical JSON (001 data-model §Canonical JSON) ---------------------------------------

SHORT_ESCAPES = {
    '"': '\\"',
    "\\": "\\\\",
    "\b": "\\b",
    "\t": "\\t",
    "\n": "\\n",
    "\f": "\\f",
    "\r": "\\r",
}


def canonical_json(value: Any) -> str:
    """The canonical JSON text of a value. Raises ValueError for numbers without a canonical
    form (NaN, infinity) and TypeError for values that are not JSON."""
    if value is None:
        return "null"
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, (int, float)):
        return number_text(value)
    if isinstance(value, str):
        return string_text(value)
    if isinstance(value, (list, tuple)):
        return "[" + ",".join(canonical_json(item) for item in value) + "]"
    if isinstance(value, dict):
        return object_text(value)
    raise TypeError(f"{type(value).__name__} is not a JSON value")


def object_text(value: dict[Any, Any]) -> str:
    for key in value:
        if not isinstance(key, str):
            raise TypeError(f"object keys are strings, not {type(key).__name__}")
    keys = sorted(value, key=utf16_units)
    return "{" + ",".join(f"{string_text(key)}:{canonical_json(value[key])}" for key in keys) + "}"


def utf16_units(text: str) -> bytes:
    """Sorting by these bytes sorts by UTF-16 code units, lone surrogates included."""
    return text.encode("utf-16-be", "surrogatepass")


def string_text(text: str) -> str:
    """A JSON string written as ECMAScript JSON.stringify writes it."""
    parts = ['"']
    for char in as_utf16_chars(text):
        if char in SHORT_ESCAPES:
            parts.append(SHORT_ESCAPES[char])
        elif ord(char) < 0x20 or 0xD800 <= ord(char) <= 0xDFFF:
            parts.append(f"\\u{ord(char):04x}")
        else:
            parts.append(char)
    parts.append('"')
    return "".join(parts)


def as_utf16_chars(text: str) -> str:
    """The text with a high surrogate followed by a low one joined into one character, as a
    UTF-16 string reads them; lone surrogates stay."""
    if not any(0xD800 <= ord(char) <= 0xDFFF for char in text):
        return text
    units = utf16_units(text)
    chars, index = [], 0
    while index < len(units):
        unit = int.from_bytes(units[index : index + 2], "big")
        following = int.from_bytes(units[index + 2 : index + 4], "big")
        if 0xD800 <= unit <= 0xDBFF and 0xDC00 <= following <= 0xDFFF:
            chars.append(chr(0x10000 + ((unit - 0xD800) << 10) + (following - 0xDC00)))
            index += 4
        else:
            chars.append(chr(unit))
            index += 2
    return "".join(chars)


def number_text(number: int | float) -> str:
    """The number as an IEEE 754 double in ECMAScript Number::toString notation."""
    try:
        value = float(number)
    except OverflowError:
        raise ValueError(f"{number} does not fit in a double") from None
    if not math.isfinite(value):
        raise ValueError(f"{value} has no canonical JSON form")
    if value == 0:
        return "0"
    if value < 0:
        return "-" + number_text(-value)
    digits, point = shortest_digits(value)
    return ecmascript_layout(digits, point)


def shortest_digits(value: float) -> tuple[str, int]:
    """The shortest digits that read back as `value`, and `point` with value = 0.digits × 10^point.
    repr() gives the shortest round-trip digits, the same digits ECMAScript chooses."""
    mantissa, _, exponent = repr(value).partition("e")
    whole, _, fraction = mantissa.partition(".")
    digits = whole + fraction
    point = len(whole) + int(exponent or "0")
    stripped = digits.lstrip("0")
    point -= len(digits) - len(stripped)
    return stripped.rstrip("0"), point


def ecmascript_layout(digits: str, point: int) -> str:
    """Number::toString steps for a positive value 0.digits × 10^point."""
    count = len(digits)
    if count <= point <= 21:
        return digits + "0" * (point - count)
    if 0 < point <= 21:
        return digits[:point] + "." + digits[point:]
    if -6 < point <= 0:
        return "0." + "0" * -point + digits
    exponent = point - 1
    sign = "+" if exponent >= 0 else "-"
    mantissa = digits if count == 1 else digits[0] + "." + digits[1:]
    return f"{mantissa}e{sign}{abs(exponent)}"


def read_json(text: str) -> JsonValue:
    """Reads JSON text by the reading rules: NaN, Infinity and numbers too large for a double make
    it not JSON (ValueError); duplicate names keep the last value."""
    value: JsonValue = json.loads(
        text, parse_constant=refuse_constant, parse_float=read_float, parse_int=read_int
    )
    return value


def refuse_constant(name: str) -> float:
    raise ValueError(f"{name} is not JSON")


def read_float(text: str) -> float:
    value = float(text)
    if not math.isfinite(value):
        raise ValueError(f"{text} does not fit in a double")
    return value


def read_int(text: str) -> int:
    value = int(text)
    try:
        float(value)
    except OverflowError:
        raise ValueError(f"{text} does not fit in a double") from None
    return value


def sha256_of_text(text: str) -> str:
    """`sha256:` and the hex digest of the text's UTF-8 bytes. The texts hashed are canonical JSON,
    where lone surrogates are already escaped; any other lone surrogate is hashed as U+FFFD, as
    the UTF-8 encoding of a UTF-16 string writes it."""
    well_formed = utf16_units(text).decode("utf-16-be", "replace")
    return "sha256:" + hashlib.sha256(well_formed.encode("utf-8")).hexdigest()


# --- Discard reason (data-model §Outcome Decision, row 8) ----------------------------------

DISCARD_REASON_LIMIT = 200


def discard_reason(error: BaseException) -> str:
    """`<class name>: <message>`, or the class name alone when the message is empty (data-model
    §Comparing Text), cut to its first 200 code points."""
    name, message = type(error).__name__, str(error)
    text = name if is_empty_text(message) else f"{name}: {message}"
    return text[:DISCARD_REASON_LIMIT]


# --- retry-after (helper-api §retryAfterMs) ------------------------------------------------

DECIMAL = re.compile(r"[0-9]+(?:\.[0-9]+)?")
MONTHS = ("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")
MONTH = "(" + "|".join(MONTHS) + ")"
TIME = r"([0-9]{2}):([0-9]{2}):([0-9]{2})"
# RFC 9110 §5.6.7: IMF-fixdate, the obsolete RFC 850 form and the asctime form, all in GMT.
IMF_FIXDATE = re.compile(
    rf"(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), ([0-9]{{2}}) {MONTH} ([0-9]{{4}}) {TIME} GMT"
)
DAY_NAME = "(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)"
RFC_850_DATE = re.compile(rf"{DAY_NAME}, ([0-9]{{2}})-{MONTH}-([0-9]{{2}}) {TIME} GMT")
ASCTIME_DATE = re.compile(
    rf"(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) {MONTH} ([0-9 ][0-9]) {TIME} ([0-9]{{4}})"
)


def retry_after_ms(headers: Mapping[str, str], now_ms: float | None = None) -> int | None:
    """The wait a response asks for, in ms: `retry-after-ms` when readable, else `retry-after`
    as seconds or as an HTTP date; None when neither is readable."""
    now = time.time() * 1000 if now_ms is None else now_ms
    lowered = {name.lower(): value for name, value in headers.items()}
    if "retry-after-ms" in lowered:
        waited = read_number(lowered["retry-after-ms"], 1)
        if waited is not None:
            return waited
    if "retry-after" not in lowered:
        return None
    value = lowered["retry-after"]
    seconds = read_number(value, 1000)
    if seconds is not None:
        return seconds
    date_ms = http_date_ms(trim_header(value), now)
    return None if date_ms is None else max(0, rounded(date_ms - now))


def read_number(value: str, scale: int) -> int | None:
    """A non-negative decimal times `scale`, rounded half up; None for any other text."""
    text = trim_header(value)
    if DECIMAL.fullmatch(text) is None:
        return None
    scaled = float(text) * scale
    return rounded(scaled) if math.isfinite(scaled) else None


def trim_header(value: str) -> str:
    """The value without SP and HTAB at either end, the optional whitespace of RFC 9110."""
    return value.strip(" \t")


def rounded(value: float) -> int:
    """floor(x + 0.5): halves round up in both helpers, where round() would round half to even."""
    return math.floor(value + 0.5)


def http_date_ms(text: str, now_ms: float) -> int | None:
    """The time an HTTP date names, in ms since the epoch, read as GMT in all three forms."""
    match = IMF_FIXDATE.fullmatch(text)
    if match is not None:
        day, month, year, hour, minute, second = match.groups()
        return utc_ms(int(year), month, day, hour, minute, second)
    match = RFC_850_DATE.fullmatch(text)
    if match is not None:
        day, month, short_year, hour, minute, second = match.groups()
        return rfc_850_ms(int(short_year), (month, day, hour, minute, second), now_ms)
    match = ASCTIME_DATE.fullmatch(text)
    if match is not None:
        month, day, hour, minute, second, year = match.groups()
        return utc_ms(int(year), month, day.strip(), hour, minute, second)
    return None


def rfc_850_ms(short_year: int, rest: tuple[str, str, str, str, str], now_ms: float) -> int | None:
    """RFC 9110 §5.6.7: the date in the year with these last two digits that lies more than 50
    years before now and at most 50 years after it, compared by instant."""
    earliest, latest = years_from(now_ms, -50), years_from(now_ms, 50)
    century = time.gmtime(now_ms / 1000).tm_year // 100 * 100
    for year in (century - 100 + short_year, century + short_year, century + 100 + short_year):
        moment = utc_ms(year, *rest)
        if moment is not None and earliest < moment <= latest:
            return moment
    return None


def years_from(now_ms: float, years: int) -> float:
    """The instant `years` calendar years from now; 29 February moves to 28 February."""
    now = datetime.fromtimestamp(now_ms / 1000, timezone.utc)
    try:
        shifted = now.replace(year=now.year + years)
    except ValueError:
        shifted = now.replace(year=now.year + years, day=28)
    return shifted.timestamp() * 1000


def utc_ms(year: int, month: str, day: str, hour: str, minute: str, second: str) -> int | None:
    """Milliseconds since the epoch, or None for a date that does not exist."""
    try:
        moment = datetime(
            year,
            MONTHS.index(month) + 1,
            int(day),
            int(hour),
            int(minute),
            int(second),
            tzinfo=timezone.utc,
        )
    except ValueError:
        return None
    return calendar.timegm(moment.timetuple()) * 1000
