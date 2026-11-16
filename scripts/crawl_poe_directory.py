"""Crawl the POE address directory (branch -> settlement -> street [-> building]).

Source: https://www.poe.pl.ua/customs/search-disconnection-cabinet.php, the endpoint behind
https://www.poe.pl.ua/disconnection/poshuk-vidkliuchennia-za-osobovym-rakhunkom/
Requests are sequential with a delay, to stay polite to the utility's server.

Usage: python -X utf8 scripts/crawl_poe_directory.py OUT.json [--buildings] [--compact poe_directory.json]

--compact also writes the app snapshot: settlements deduplicated by their global id (a settlement may
belong to several branches), junk rows such as "село _" dropped, streets as [id, name] pairs. Copy it to
public/ and android/app/src/main/assets/ (npm test checks the copies).
"""
import json
import sys
import time
import urllib.parse
import urllib.request

URL = "https://www.poe.pl.ua/customs/search-disconnection-cabinet.php"
UA = "Mozilla/5.0 (Linux; Android 14) PoltavaBlackoutPreWarning-directory"
DELAY = 0.4
BRANCHES = {
    102: "Великокохнівська дільниця", 103: "Гадяцька дільниця", 104: "Глобинська дільниця",
    112: "Горішньоплавнівська дільниця", 105: "Гребінківська дільниця", 106: "Диканська дільниця",
    108: "Зіньківська дільниця", 109: "Карлівська дільниця", 110: "Кобеляцька дільниця",
    111: "Козельщинська дільниця", 113: "Котелевська дільниця", 114: "Красногорівська дільниця",
    115: "Кременчуцька об'єднана філія", 116: "Лохвицька дільниця", 117: "Лубенська об'єднана філія",
    118: "Машівська дільниця", 119: "Миргородська об'єднана філія", 120: "Новосанжарська дільниця",
    121: "Оржицька дільниця", 122: "Пирятинська дільниця", 131: "Полтавська дільниця районних електромереж",
    123: "Полтавська об'єднана філія", 124: "Решетилівська дільниця", 125: "Семенівська дільниця",
    126: "Хорольська дільниця", 127: "Чорнухинська дільниця", 128: "Чутівська дільниця",
    129: "Шишацька дільниця",
}


def query(op, filial, city="", street="", tries=3):
    body = urllib.parse.urlencode({"disconn": json.dumps(
        {"operation_type": op, "filial_id": str(filial), "city_id": str(city), "street_id": str(street)})}).encode()
    for attempt in range(tries):
        try:
            req = urllib.request.Request(URL, data=body, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=30) as r:
                data = json.loads(r.read().decode("utf-8"))
            time.sleep(DELAY)
            return data if isinstance(data, list) else []
        except Exception as e:  # noqa: BLE001
            print(f"  retry {attempt + 1} {op} {filial}/{city}/{street}: {e}", file=sys.stderr)
            time.sleep(2 * (attempt + 1))
    return None


def main():
    out_path = sys.argv[1]
    with_buildings = "--buildings" in sys.argv
    result = {"source": URL, "crawledAt": time.strftime("%Y-%m-%dT%H:%M:%S"), "branches": []}
    failures = 0
    for fid, fname in BRANCHES.items():
        cities = query("city", fid) or []
        print(f"{fid} {fname}: {len(cities)} settlements", file=sys.stderr)
        branch = {"cabinetId": fid, "registryId": fid - 100, "name": fname, "settlements": []}
        for c in cities:
            streets = query("street", fid, c["instance_id"])
            if streets is None:
                failures += 1
                streets = []
            s_out = []
            for s in streets:
                item = {"id": s["instance_id"], "name": s["instance_name"]}
                if with_buildings:
                    b = query("building", fid, c["instance_id"], s["instance_id"])
                    if b is None:
                        failures += 1
                    item["houses"] = [x["instance_name"] for x in (b or [])]
                s_out.append(item)
            branch["settlements"].append({"id": c["instance_id"], "name": c["instance_name"], "streets": s_out})
        result["branches"].append(branch)
        with open(out_path, "w", encoding="utf-8") as f:  # checkpoint after each branch
            json.dump(result, f, ensure_ascii=False, indent=1)
    result["failedRequests"] = failures
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=1)
    print(f"done, failed requests: {failures}", file=sys.stderr)
    if "--compact" in sys.argv:
        path = sys.argv[sys.argv.index("--compact") + 1]
        with open(path, "w", encoding="utf-8", newline="\n") as f:
            json.dump(compact(result), f, ensure_ascii=False, separators=(",", ":"))
        print(f"wrote {path}", file=sys.stderr)
    if failures:
        sys.exit(1)


def is_junk(name):
    parts = name.strip().split(None, 1)
    rest = (parts[1] if len(parts) == 2 else (parts[0] if parts else "")).strip()
    return not rest or set(rest) <= {"_", "-"}


def compact(result):
    merged = {}
    for b in result["branches"]:
        for s in b["settlements"]:
            if is_junk(s["name"]):
                continue
            e = merged.setdefault(s["id"], {"id": s["id"], "name": s["name"], "branches": [], "streets": [[x["id"], x["name"]] for x in s["streets"]]})
            e["branches"].append(b["cabinetId"])
    return {
        "source": result["source"],
        "crawledAt": result["crawledAt"],
        "branches": [{"cabinetId": b["cabinetId"], "registryId": b["registryId"], "name": b["name"]} for b in result["branches"]],
        "settlements": sorted(merged.values(), key=lambda e: e["name"]),
    }


if __name__ == "__main__":
    main()
