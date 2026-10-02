# Google Flights (www.google.com/travel/flights)

Covers: the lowest fares for one adult from airport A to airport B on set dates, one-way or return.
Not covered: booking, flexible-date grids, multi-city.

## Build the results URL yourself

Do not type airports into the form. The search is encoded in a `tfs` parameter: a protobuf message, base64url (`-` `_`, no `=` padding). Field layout:

| Field | Type | Content |
|---|---|---|
| 2 | varint | 0 |
| 3 | message, once per leg | field 2 = date "YYYY-MM-DD"; field 13 = from {1: 1, 2: "IATA"}; field 14 = to {1: 1, 2: "IATA"} |
| 8 | varint | 1 (one adult) |
| 9 | varint | cabin class — economy=1, premium economy=2, business=3, first=4 |
| 19 | varint | 2 for one-way, 1 for return |

One way = one leg + `19=2`. Round trip = two legs (second reversed, return date) + `19=1`. A single leg without `19=2` shows round-trip prices.

Encoder for `bash` (`python3`), checked against a known value:

```python
import base64
def varint(n):
    out = bytearray()
    while True:
        b = n & 0x7F; n >>= 7
        if n: out.append(b | 0x80)
        else: out.append(b); return bytes(out)
def key(field, wt): return varint(field << 3 | wt)
def num(field, n): return key(field, 0) + varint(n)
def blob(field, data):
    if isinstance(data, str): data = data.encode()
    return key(field, 2) + varint(len(data)) + data
def place(code): return num(1, 1) + blob(2, code)
def leg(date, a, b): return blob(2, date) + blob(13, place(a)) + blob(14, place(b))
def tfs(origin, dest, depart, ret=None, cabin=1):
    msg = num(2, 0) + blob(3, leg(depart, origin, dest))
    if ret: msg += blob(3, leg(ret, dest, origin))
    msg += num(8, 1) + num(9, cabin) + num(19, 1 if ret else 2)
    return base64.urlsafe_b64encode(msg).decode().rstrip("=")
print(tfs("SFO", "JFK", "2026-07-15"))
# EAAaHhIKMjAyNi0wNy0xNWoHCAESA1NGT3IHCAESA0pGS0ABSAGYAQI
```

URL: `https://www.google.com/travel/flights/search?hl=en&curr=USD&tfs={TFS}` — always add `curr` and `hl`, or the box's locale picks currency and language. This URL is also the link to give the person.

## Reading

- After a few seconds the title should be "{Origin city} to {Destination city} | Google Flights". If it names other cities, the codes were wrong — rebuild.
- `browser_read` of the main region gives every row as text (a few KB). A row looks like: depart – arrive (`+1` = next day), airline, duration, `FROM–TO` (en dash), "Nonstop" or "N stop(s)" with the layover (e.g. "50 min PHX"), CO2, price.
- Each flight appears twice (full and condensed). Keep rows that have an airline and airport codes; dedupe on depart/arrive/airline/price.
- Default order is "Best", not cheapest — sort by price yourself.
- Times are local to each airport; durations already account for that. Round-trip prices are the full fare.
- Flight numbers only show after expanding a row ("Operated by … flight NNNN"); costs extra steps.
- No priced rows under the correct title = genuinely no flights that day.

## Notes

- No captcha or 403 seen in testing.
- No usable JSON API (`batchexecute` is obfuscated); do not dig for one.
- Do not press "Select flight".
