"""Writes spec/vectors/poe_api.json and spec/vectors/outage_engine_poe.json.

Inputs are the live POE samples of 2026-11-16 in spec/fixtures/poe/ plus constructed edge cases;
expected values follow spec/POE_API.md section 8 and spec/OUTAGE_ENGINE.md section 3.5.
Run from anywhere: python -X utf8 scripts/gen_poe_vectors.py <repository root>
"""
import json
import sys

ROOT = sys.argv[1]


def fx(k):
    return json.load(open(f'{ROOT}/spec/fixtures/poe/poe_result_{k}.json', encoding='utf-8'))[0]


ZUIVTSI_ROW = "<tr><td>16.11.2026 08:59:00</td><td>16.11.2026 15:59</td><td><b>с.Зуївці</b><br><b>вул.Дружби</b> (б. 1, 9, 15, 17, 26, 28),<br><b>вул.Зелена</b> (б. 2, 13, 23, 27),<br><b>вул.Молодіжна</b> (б. 28)<br></td><td>Аварійна перерва</td><tr>"
POLTAVA_ROW = "<tr><td>16.11.2026 09:25:00</td><td>16.11.2026 16:00</td><td><b>м.Полтава</b><br><b>вул.Олександра Бідного</b> (б. 1а)<br><br><b>м.Полтава</b><br>Полтава, вул. Української Повстанської  Армії, 35,<br><b>вул.Олександра Бідного</b> (б. 1, 1-1а, 1а, 5)<br></td><td>Планова перерва</td><tr>"
MIRROR_ROW = "<tr><td>16.11.2026 12:00:00</td><td>16.11.2026 15:00</td><td><b>м.Полтава</b><br><b>вул.Героїв ОУН</b> (б. 37а)<br></td><td>Застосування графіків обмеження споживачів (ГПВ 3-1)</td><tr>"
EMPTY_REASON_ROW = "<tr><td>15.11.2026 22:00:00</td><td>16.11.2026 00:30</td><td><b>смт.Диканька</b><br><b>вул.Садова</b> (б. 2, 6б)<br></td><td></td><tr>"
ENTITY_ROW = "<tr><td>16.11.2026 10:00:00</td><td></td><td><b>с.Нижні Млини</b><br><b>вул.Дем&#39;яна Бідного</b> (б. 4)<br><b>вул.Шевченка</b><br></td><td>Аварійна перерва</td><tr>"

zuivtsi_places = [{"settlement": "с.Зуївці", "streets": [
    {"street": "вул.Дружби", "houses": ["1", "9", "15", "17", "26", "28"]},
    {"street": "вул.Зелена", "houses": ["2", "13", "23", "27"]},
    {"street": "вул.Молодіжна", "houses": ["28"]}], "freeText": []}]
poltava_places = [
    {"settlement": "м.Полтава", "streets": [{"street": "вул.Олександра Бідного", "houses": ["1а"]}], "freeText": []},
    {"settlement": "м.Полтава", "streets": [
        {"street": "вул. Української Повстанської  Армії", "houses": ["35"]},
        {"street": "вул.Олександра Бідного", "houses": ["1", "1-1а", "1а", "5"]}],
     "freeText": ["Полтава, вул. Української Повстанської  Армії, 35"]}]

R = "Планові роботи"
E3 = "Аварійна перерва"
EX = "Перерва в електропостачанні"
zu_em = {"id": "poe_3462256", "start": "2026-11-16T08:59", "estimatedEnd": "2026-11-16T15:59", "label": E3}

poe = {
    "_doc": "Golden vectors for the POE mapping (spec/POE_API.md section 8, PoeMapper). Inputs are live answers of www.poe.pl.ua captured on 2026-11-16 (spec/fixtures/poe/) or reduced copies of them; constructed edge cases say so in their name. Times are Kyiv wall clock, text form yyyy-MM-ddTHH:mm.",
    "times": [
        {"in": "16.11.2026 08:59", "out": "2026-11-16T08:59"},
        {"in": "16.11.2026 09:25:00", "out": "2026-11-16T09:25"},
        {"in": " 6.1.2027 7:05", "out": "2027-01-06T07:05"},
        {"in": "31.11.2026 10:00", "out": None},
        {"in": "29.02.2027 10:00", "out": None},
        {"in": "16.11.2026 24:00", "out": None},
        {"in": "16.11.2026 10:60", "out": None},
        {"in": "2026-11-16T08:59", "out": None},
        {"in": "16.11.2026", "out": None},
        {"in": "", "out": None},
    ],
    "eta": [
        {"name": "live emergency (Зуївці)", "in": fx('type3_emergency_noqueue')['fn_accident_message'], "out": "2026-11-16T15:59"},
        {"name": "live repair works (Сухорабівка)", "in": fx('type2_planned')['fn_accident_message'], "out": "2026-11-16T17:00"},
        {"name": "live: nothing registered", "in": fx('type0_none')['fn_accident_message'], "out": None},
        {"name": "constructed: 24:00 is midnight of the next day", "in": "зареєстрована аварійна перерва в електропостачанні 16.11.2026 р. з 20 годин(и) 10 хвилин(и). Очікуваний час закінчення перерви в електропостачанні: 16.11.2026 р. о 24 годин(и) 00 хвилин(и).", "out": "2026-11-17T00:00"},
        {"name": "constructed: no word 'закінчення', other spelling of годин", "in": "відновлення орієнтовно 17.11.2026 р. о 6 години 5 хвилин", "out": "2026-11-17T06:05"},
        {"name": "constructed: impossible date", "in": "Очікуваний час закінчення перерви в електропостачанні: 31.11.2026 р. о 10 годин(и) 00 хвилин(и).", "out": None},
        {"name": "constructed: empty", "in": "", "out": None},
    ],
    "plannedList": [
        {"name": "live: four days of works (Сухорабівка)", "in": fx('type2_planned')['planned_message'], "out": [
            {"start": "2026-11-17T08:00", "end": "2026-11-17T17:00"},
            {"start": "2026-11-18T08:00", "end": "2026-11-18T17:00"},
            {"start": "2026-11-19T08:00", "end": "2026-11-19T17:00"},
            {"start": "2026-11-20T08:00", "end": "2026-11-20T17:00"}]},
        {"name": "live: POE repeats an entry, duplicates are removed (Зуївці)", "in": fx('type3_emergency_noqueue')['planned_message'], "out": [
            {"start": "2026-11-20T08:00", "end": "2026-11-20T20:00"}]},
        {"name": "constructed: minutes, 24-ї, an inverted pair dropped, <br/> separators", "in": "- роботи 21.11.2026 р. з 08:30 до 17:00 години.<br/>- роботи 22.11.2026 р. з 20-ї до 24-ї години.<BR />- роботи 23.11.2026 р. з 17-ї до 08-ї години.", "out": [
            {"start": "2026-11-21T08:30", "end": "2026-11-21T17:00"},
            {"start": "2026-11-22T20:00", "end": "2026-11-23T00:00"}]},
        {"name": "constructed: no entries", "in": "", "out": []},
        {"name": "constructed: null", "in": None, "out": []},
    ],
    "queue": [
        {"in": ["4", "2"], "out": "4.2"},
        {"in": ["1", " 1 "], "out": "1.1"},
        {"in": ["", ""], "out": None},
        {"in": [None, None], "out": None},
        {"in": ["7", "1"], "out": None},
        {"in": ["1", "3"], "out": None},
        {"in": ["a", "1"], "out": None},
        {"in": ["6", "2"], "out": "6.2"},
    ],
    "addressStatus": [
        {"name": "live: nothing registered, queue 1.1 (Полтава, вул. Соборності 1)", "today": "2026-11-16", "in": fx('type0_none'),
         "expect": {"messageType": 0, "queue": "1.1", "emergency": None, "repairs": [], "scheduleMirror": False, "unparsed": False}},
        {"name": "live: repair works now and planned works; days after tomorrow dropped (Сухорабівка, вул. Миру 77)", "today": "2026-11-16", "in": fx('type2_planned'),
         "expect": {"messageType": 2, "queue": "4.2", "emergency": None, "repairs": [
             {"id": "repair_2026-11-16T09:34", "start": "2026-11-16T09:34", "end": "2026-11-16T17:00", "label": R},
             {"id": "repair_2026-11-17T08:00", "start": "2026-11-17T08:00", "end": "2026-11-17T17:00", "label": R}], "scheduleMirror": False, "unparsed": False}},
        {"name": "live: пошкодження = emergency, house in no queue (Зуївці, вул. Дружби 9)", "today": "2026-11-16", "in": fx('type3_emergency_noqueue'),
         "expect": {"messageType": 3, "queue": None, "emergency": zu_em, "repairs": [], "scheduleMirror": False, "unparsed": False}},
        {"name": "constructed: planned works of tomorrow are kept on the day before (Зуївці sample read on 19.11)", "today": "2026-11-19", "in": fx('type3_emergency_noqueue'),
         "expect": {"messageType": 3, "queue": None, "emergency": zu_em, "repairs": [
             {"id": "repair_2026-11-20T08:00", "start": "2026-11-20T08:00", "end": "2026-11-20T20:00", "label": R}], "scheduleMirror": False, "unparsed": False}},
        {"name": "constructed: emergency whose start can not be read is unparsed, never 'no outage'", "today": "2026-11-16",
         "in": {"fn_accident_message": "зареєстрована аварійна перерва", "message_type": 3, "accident_str": "сьогодні", "accident_id": 5, "gp_qnum_1": "2", "gp_qnum_2": "1", "planned_message": None},
         "expect": {"messageType": 3, "queue": "2.1", "emergency": None, "repairs": [], "scheduleMirror": False, "unparsed": True}},
        {"name": "constructed: unknown message type is an emergency; no accident_id, no estimate", "today": "2026-11-16",
         "in": {"fn_accident_message": "перерва в електропостачанні", "message_type": 5, "accident_str": "16.11.2026 10:00", "accident_id": None, "gp_qnum_1": "3", "gp_qnum_2": "2", "planned_message": ""},
         "expect": {"messageType": 5, "queue": "3.2", "emergency": {"id": "poe_2026-11-16T10:00", "start": "2026-11-16T10:00", "estimatedEnd": None, "label": EX}, "repairs": [], "scheduleMirror": False, "unparsed": False}},
        {"name": "constructed: repair works now without an end are unparsed", "today": "2026-11-16",
         "in": {"fn_accident_message": "проводяться планові ремонтні роботи", "message_type": 2, "accident_str": "16.11.2026 09:00", "accident_id": 7, "gp_qnum_1": "5", "gp_qnum_2": "1", "planned_message": None},
         "expect": {"messageType": 2, "queue": "5.1", "emergency": None, "repairs": [], "scheduleMirror": False, "unparsed": True}},
        {"name": "constructed: an estimate not after the start is dropped", "today": "2026-11-16",
         "in": {"fn_accident_message": "Очікуваний час закінчення перерви в електропостачанні: 16.11.2026 р. о 08 годин(и) 00 хвилин(и).", "message_type": 3, "accident_str": "16.11.2026 09:00", "accident_id": 8, "gp_qnum_1": "", "gp_qnum_2": "", "planned_message": None},
         "expect": {"messageType": 3, "queue": None, "emergency": {"id": "poe_8", "start": "2026-11-16T09:00", "estimatedEnd": None, "label": E3}, "repairs": [], "scheduleMirror": False, "unparsed": False}},
        {"name": "live (16.11 18:06): type 4 = off by the hourly schedule (ГПВ), a mirror of the table, not an emergency (Полтава, вул. Соборності 1)", "today": "2026-11-16", "in": fx('type4_schedule_mirror'),
         "expect": {"messageType": 4, "queue": "1.1", "emergency": None, "repairs": [], "scheduleMirror": True, "unparsed": False}},
        {"name": "constructed: type 4 for a ГАВ cut is not a schedule mirror and stays an emergency", "today": "2026-11-16",
         "in": {"fn_accident_message": "зареєстрована перерва в електропостачанні внаслідок застосування графіку аварійних відключень (ГАВ) 16.11.2026 р. з 18 годин(и) 10 хвилин(и).", "message_type": 4, "accident_str": "16.11.2026 18:10", "accident_id": 77, "gp_qnum_1": "1", "gp_qnum_2": "1", "planned_message": None},
         "expect": {"messageType": 4, "queue": "1.1", "emergency": {"id": "poe_77", "start": "2026-11-16T18:10", "estimatedEnd": None, "label": EX}, "repairs": [], "scheduleMirror": False, "unparsed": False}},
        {"name": "constructed: missing message_type reads as -1 and is treated as an emergency", "today": "2026-11-16",
         "in": {"accident_str": "16.11.2026 11:00", "accident_id": 9},
         "expect": {"messageType": -1, "queue": None, "emergency": {"id": "poe_9", "start": "2026-11-16T11:00", "estimatedEnd": None, "label": EX}, "repairs": [], "scheduleMirror": False, "unparsed": False}},
    ],
    "registryReason": [
        {"in": "Аварійна перерва", "out": "EMERGENCY"},
        {"in": "Планова перерва", "out": "REPAIR"},
        {"in": "Застосування графіків обмеження споживачів (ГПВ 3-1)", "out": "MIRROR"},
        {"in": "", "out": "REPAIR"},
        {"in": "  АВАРІЙНА ПЕРЕРВА ", "out": "EMERGENCY"},
        {"in": "Інша причина", "out": "REPAIR"},
    ],
    "registryRows": [
        {"name": "live emergency row (Зуївці, filial 19)", "in": ZUIVTSI_ROW, "expect": {"id": "poe_reg_2026-11-16T08:59", "start": "2026-11-16T08:59", "end": "2026-11-16T15:59", "reason": E3, "kind": "EMERGENCY", "places": zuivtsi_places}},
        {"name": "live planned row with a free-text line (Полтава, filial 23)", "in": POLTAVA_ROW, "expect": {"id": "poe_reg_2026-11-16T09:25", "start": "2026-11-16T09:25", "end": "2026-11-16T16:00", "reason": "Планова перерва", "kind": "REPAIR", "places": poltava_places}},
        {"name": "live schedule mirror row (filial 23)", "in": MIRROR_ROW, "expect": {"id": "poe_reg_2026-11-16T12:00", "start": "2026-11-16T12:00", "end": "2026-11-16T15:00", "reason": "Застосування графіків обмеження споживачів (ГПВ 3-1)", "kind": "MIRROR", "places": [{"settlement": "м.Полтава", "streets": [{"street": "вул.Героїв ОУН", "houses": ["37а"]}], "freeText": []}]}},
        {"name": "reduced copy: empty reason reads as repair (Диканька, filial 6)", "in": EMPTY_REASON_ROW, "expect": {"id": "poe_reg_2026-11-15T22:00", "start": "2026-11-15T22:00", "end": "2026-11-16T00:30", "reason": "", "kind": "REPAIR", "places": [{"settlement": "смт.Диканька", "streets": [{"street": "вул.Садова", "houses": ["2", "6б"]}], "freeText": []}]}},
        {"name": "constructed: entities decoded, no end, a whole street without a house list", "in": ENTITY_ROW, "expect": {"id": "poe_reg_2026-11-16T10:00", "start": "2026-11-16T10:00", "end": None, "reason": E3, "kind": "EMERGENCY", "places": [{"settlement": "с.Нижні Млини", "streets": [{"street": "вул.Дем'яна Бідного", "houses": ["4"]}, {"street": "вул.Шевченка", "houses": []}], "freeText": []}]}},
        {"name": "constructed: not a row", "in": "<tr><td>bad</td></tr>", "expect": None},
    ],
    "registryMatch": [
        {"name": "live: listed house is confirmed", "row": ZUIVTSI_ROW, "settlement": "село Зуївці", "street": "вул. Дружби", "house": "9", "out": "CONFIRMED"},
        {"name": "live: house 3 is off per E4 but missing in the registry list, so only the street matches", "row": ZUIVTSI_ROW, "settlement": "село Зуївці", "street": "вул. Дружби", "house": "3", "out": "STREET"},
        {"name": "live: other street of the settlement", "row": ZUIVTSI_ROW, "settlement": "село Зуївці", "street": "вул. Садова", "house": "2", "out": "NONE"},
        {"name": "live: same street name in another settlement", "row": ZUIVTSI_ROW, "settlement": "село Хомутець", "street": "вул. Дружби", "house": "9", "out": "NONE"},
        {"name": "live: free-text line, double space and an old name in brackets", "row": POLTAVA_ROW, "settlement": "місто Полтава", "street": "вул. Української Повстанської Армії (Ватутіна)", "house": "35", "out": "CONFIRMED"},
        {"name": "live: house list of the second group of the same settlement", "row": POLTAVA_ROW, "settlement": "місто Полтава", "street": "вул. Олександра Бідного ", "house": "5", "out": "CONFIRMED"},
        {"name": "live: street listed, house not", "row": POLTAVA_ROW, "settlement": "місто Полтава", "street": "вул. Олександра Бідного", "house": "3", "out": "STREET"},
        {"name": "constructed: apostrophe variant and a whole street", "row": ENTITY_ROW, "settlement": "село Нижні Млини", "street": "вул. Дем’яна Бідного", "house": "4", "out": "CONFIRMED"},
        {"name": "constructed: a street without a house list matches only the street", "row": ENTITY_ROW, "settlement": "село Нижні Млини", "street": "вул. Шевченка", "house": "10", "out": "STREET"},
    ],
    "nearby": [
        {"name": "live Полтава rows at 12:00: the mirror row is dropped, two groups of one street merge, the user's house is listed",
         "rows": [POLTAVA_ROW, MIRROR_ROW, ZUIVTSI_ROW], "settlement": "місто Полтава", "street": "вул. Олександра Бідного", "house": "5", "now": "2026-11-16T12:00",
         "expect": [{"id": "poe_reg_2026-11-16T09:25", "kind": "REPAIR", "start": "2026-11-16T09:25", "end": "2026-11-16T16:00", "reason": "Планова перерва", "status": "ACTIVE",
                     "streets": [{"name": "вул.Олександра Бідного", "houses": ["1а", "1", "1-1а", "5"], "mine": True},
                                 {"name": "вул. Української Повстанської Армії", "houses": ["35"], "mine": False}],
                     "match": "CONFIRMED"}]},
        {"name": "live Зуївці row: house 3 is off per E4 but the registry omits it, so only the street matches; the same row from two branches is one item",
         "rows": [ZUIVTSI_ROW, ZUIVTSI_ROW], "settlement": "село Зуївці", "street": "вул. Дружби", "house": "3", "now": "2026-11-16T10:30",
         "expect": [{"id": "poe_reg_2026-11-16T08:59", "kind": "EMERGENCY", "start": "2026-11-16T08:59", "end": "2026-11-16T15:59", "reason": E3, "status": "ACTIVE",
                     "streets": [{"name": "вул.Дружби", "houses": ["1", "9", "15", "17", "26", "28"], "mine": True},
                                 {"name": "вул.Зелена", "houses": ["2", "13", "23", "27"], "mine": False},
                                 {"name": "вул.Молодіжна", "houses": ["28"], "mine": False}],
                     "match": "STREET"}]},
        {"name": "order: active, then upcoming, then finished; a row without the user's street is dropped (owner: same settlement and street)",
         "rows": [ZUIVTSI_ROW, "<tr><td>16.11.2026 18:00:00</td><td>16.11.2026 19:00</td><td><b>с.Зуївці</b><br><b>вул.Садова</b><br></td><td>Планова перерва</td><tr>",
                  "<tr><td>16.11.2026 07:00:00</td><td>16.11.2026 08:00</td><td><b>с.Зуївці</b><br><b>вул.Садова</b> (б. 2)<br></td><td>Аварійна перерва</td><tr>",
                  "<tr><td>16.11.2026 11:00:00</td><td>16.11.2026 13:00</td><td><b>с.Зуївці</b><br><b>вул.Садова</b> (б. 5)<br><b>вул.Зелена</b> (б. 1)<br></td><td>Аварійна перерва</td><tr>"],
         "settlement": "Зуївці", "street": "вул. Садова", "house": "2", "now": "2026-11-16T12:00",
         "expect": [
             {"id": "poe_reg_2026-11-16T11:00", "kind": "EMERGENCY", "start": "2026-11-16T11:00", "end": "2026-11-16T13:00", "reason": E3, "status": "ACTIVE",
              "streets": [{"name": "вул.Садова", "houses": ["5"], "mine": True}, {"name": "вул.Зелена", "houses": ["1"], "mine": False}], "match": "STREET"},
             {"id": "poe_reg_2026-11-16T18:00", "kind": "REPAIR", "start": "2026-11-16T18:00", "end": "2026-11-16T19:00", "reason": "Планова перерва", "status": "UPCOMING",
              "streets": [{"name": "вул.Садова", "houses": [], "mine": True}], "match": "STREET"},
             {"id": "poe_reg_2026-11-16T07:00", "kind": "EMERGENCY", "start": "2026-11-16T07:00", "end": "2026-11-16T08:00", "reason": E3, "status": "FINISHED",
              "streets": [{"name": "вул.Садова", "houses": ["2"], "mine": True}], "match": "CONFIRMED"}]},
        {"name": "queue-only subscription (no street, no house): nothing is shown",
         "rows": [ZUIVTSI_ROW], "settlement": "Зуївці", "street": "", "house": "", "now": "2026-11-16T12:00", "expect": []},
        {"name": "constructed: no end is active; a whole-street entry makes the merged street whole; an empty reason reads as repair",
         "rows": [ENTITY_ROW, "<tr><td>16.11.2026 11:00:00</td><td>16.11.2026 12:00</td><td><b>с.Нижні Млини</b><br><b>вул.Шевченка</b> (б. 1, 3)<br><br><b>с.Нижні Млини</b><br><b>вул. Шевченка</b><br></td><td></td><tr>"],
         "settlement": "село Нижні Млини", "street": "вул. Шевченка", "house": "10", "now": "2026-11-16T11:30",
         "expect": [
             {"id": "poe_reg_2026-11-16T10:00", "kind": "EMERGENCY", "start": "2026-11-16T10:00", "end": None, "reason": E3, "status": "ACTIVE",
              "streets": [{"name": "вул.Дем'яна Бідного", "houses": ["4"], "mine": False}, {"name": "вул.Шевченка", "houses": [], "mine": True}], "match": "STREET"},
             {"id": "poe_reg_2026-11-16T11:00", "kind": "REPAIR", "start": "2026-11-16T11:00", "end": "2026-11-16T12:00", "reason": "", "status": "ACTIVE",
              "streets": [{"name": "вул.Шевченка", "houses": [], "mine": True}], "match": "STREET"}]},
        {"name": "constructed: another settlement, a mirror only and nothing at all give no items",
         "rows": [MIRROR_ROW, ZUIVTSI_ROW], "settlement": "село Хомутець", "street": "вул. Дружби", "house": "9", "now": "2026-11-16T12:00", "expect": []},
    ],
    # Registry rows naming the house become its REPAIR outages (owner, 2026-11-17; spec/POE_API.md 8.10a)
    "registryRepairs": [
        {"name": "live: the listed house gets the planned row as repair works",
         "rows": [POLTAVA_ROW, MIRROR_ROW], "settlement": "місто Полтава", "street": "вул. Олександра Бідного", "house": "5",
         "expect": [{"id": "registry_2026-11-16T09:25_2026-11-16T16:00", "start": "2026-11-16T09:25", "end": "2026-11-16T16:00"}]},
        {"name": "live: an emergency row naming the house is a repair outage too; the same row from two branches is one",
         "rows": [ZUIVTSI_ROW, ZUIVTSI_ROW], "settlement": "село Зуївці", "street": "вул. Дружби", "house": "9",
         "expect": [{"id": "registry_2026-11-16T08:59_2026-11-16T15:59", "start": "2026-11-16T08:59", "end": "2026-11-16T15:59"}]},
        {"name": "live: street listed but not the house gives nothing (registry lists are incomplete)",
         "rows": [ZUIVTSI_ROW], "settlement": "село Зуївці", "street": "вул. Дружби", "house": "3", "expect": []},
        {"name": "live: a schedule mirror row naming the house gives nothing",
         "rows": [MIRROR_ROW], "settlement": "місто Полтава", "street": "вул. Героїв ОУН", "house": "37а", "expect": []},
        {"name": "constructed: a row without an end gives nothing",
         "rows": [ENTITY_ROW], "settlement": "село Нижні Млини", "street": "вул. Дем'яна Бідного", "house": "4", "expect": []},
        {"name": "queue-only subscription (no street, no house): nothing",
         "rows": [POLTAVA_ROW], "settlement": "місто Полтава", "street": "", "house": "", "expect": []},
    ],
}

# ---------------------------------------------------------------- outage_engine_poe.json
Q11 = {"off": ["04:00-07:00", "10:00-13:00", "16:00-19:00", "22:00-24:00"], "switching": ["00:00-00:30", "07:00-07:30", "13:00-13:30", "19:00-19:30"]}
Q62 = {"off": ["02:30-06:30", "09:30-12:30", "15:30-18:30", "21:30-23:30"], "switching": ["06:30-07:00", "12:30-13:00", "18:30-19:00", "23:30-24:00"]}
D = "2026-11-16"
spans11 = [
    {"start": f"{D}T04:00", "end": f"{D}T07:00", "mayContinue": False},
    {"start": f"{D}T10:00", "end": f"{D}T13:00", "mayContinue": False},
    {"start": f"{D}T16:00", "end": f"{D}T19:00", "mayContinue": False},
    {"start": f"{D}T22:00", "end": "2026-11-17T00:00", "mayContinue": True},
]
a16 = {"key": f"planned_{D}T16:00", "fireAt": f"{D}T15:45", "spanEnd": f"{D}T19:00", "mayContinue": False, "durationMinutes": 180}
a22 = {"key": f"planned_{D}T22:00", "fireAt": f"{D}T21:45", "spanEnd": "2026-11-17T00:00", "mayContinue": True, "durationMinutes": 120}
day16 = {"plannedCells": Q11["off"], "switchingCells": Q11["switching"], "emergencyCells": [], "totalOffMinutes": 660}

engine = {
    "_doc": "Golden cases for POE day tables with the switching half-hour (spec/OUTAGE_ENGINE.md section 3.5). 'cells' gives each known day as cell ranges per state ('off' = gpv-s2, 'switching' = gpv-s3, everything else on); a missing or null day is unknown. Queue 1.1 and 6.2 are the live POE table of 2026-11-16 (spec/fixtures/poe/poe_newgpv_2026-11-16.html). 'repair' and 'emergencies' as in outage_engine.json. Expected 'spans' are spans of all non-stale outages in the window; 'days' compare plannedCells, switchingCells, emergencyCells and totalOffMinutes.",
    "cases": [
        {"name": "live 1.1 at 15:29, tomorrow not published: next block 16:00-19:00, power back 19:00-19:30",
         "today": D, "now": f"{D}T15:29", "advanceMinutes": 15, "cells": {"today": Q11},
         "expect": {"status": {"isOffNow": False, "countdownText": "00:31:00", "nextSlotTime": "16:00 – 19:00", "restoreUntil": f"{D}T19:30"},
                    "spans": spans11, "alerts": [a16, a22], "days": {D: day16}}},
        {"name": "live 1.1 at 17:00, during the block: countdown to the OFF end, restore window after it",
         "today": D, "now": f"{D}T17:00", "advanceMinutes": 15, "cells": {"today": Q11},
         "expect": {"status": {"isOffNow": True, "countdownText": "02:00:00", "nextSlotTime": "16:00 – 19:00", "restoreUntil": f"{D}T19:30"},
                    "alerts": [a22], "days": {D: day16}}},
        {"name": "live 1.1 at 19:10, inside the switching half-hour: not off; the next block runs to midnight with tomorrow unknown, so no restore window",
         "today": D, "now": f"{D}T19:10", "advanceMinutes": 15, "cells": {"today": Q11},
         "expect": {"status": {"isOffNow": False, "countdownText": "02:50:00", "nextSlotTime": "22:00 – 24:00", "restoreUntil": None},
                    "alerts": [a22]}},
        {"name": "1.1 at 23:00 with tomorrow published (constructed tomorrow): the block closes at midnight because tomorrow starts with switching",
         "today": D, "now": f"{D}T23:00", "advanceMinutes": 15,
         "cells": {"today": Q11, "tomorrow": {"off": ["04:00-07:00"], "switching": ["00:00-00:30", "07:00-07:30"]}},
         "expect": {"status": {"isOffNow": True, "countdownText": "01:00:00", "nextSlotTime": "22:00 – 24:00", "restoreUntil": "2026-11-17T00:30"},
                    "spans": spans11[:3] + [
                        {"start": f"{D}T22:00", "end": "2026-11-17T00:00", "mayContinue": False},
                        {"start": "2026-11-17T04:00", "end": "2026-11-17T07:00", "mayContinue": False}],
                    "alerts": [{"key": "planned_2026-11-17T04:00", "fireAt": "2026-11-17T03:45", "spanEnd": "2026-11-17T07:00", "mayContinue": False, "durationMinutes": 180}],
                    "days": {"2026-11-17": {"plannedCells": ["04:00-07:00"], "switchingCells": ["00:00-00:30", "07:00-07:30"], "emergencyCells": [], "totalOffMinutes": 180}}}},
        {"name": "live 6.2 at 22:00: the switching half-hour at 23:30 ends with the last known day",
         "today": D, "now": f"{D}T22:00", "advanceMinutes": 15, "cells": {"today": Q62},
         "expect": {"status": {"isOffNow": True, "countdownText": "01:30:00", "nextSlotTime": "21:30 – 23:30", "restoreUntil": "2026-11-17T00:00"},
                    "alerts": [],
                    "days": {D: {"plannedCells": Q62["off"], "switchingCells": Q62["switching"], "emergencyCells": [], "totalOffMinutes": 720}}}},
        {"name": "repair over a switching cell wins; an emergency on a switching cell shows both and moves the span end, so no restore window",
         "today": D, "now": f"{D}T12:00", "advanceMinutes": 15, "cells": {"today": Q11},
         "repair": [{"id": f"repair_{D}T07:00", "start": f"{D}T07:00", "end": f"{D}T08:00"}],
         "emergencies": [{"id": "poe_3462256", "start": f"{D}T13:00", "estimatedEnd": f"{D}T13:20", "label": "Аварійна перерва"}],
         "expect": {"status": {"isOffNow": True, "countdownText": "01:20:00", "nextSlotTime": "10:00 – 13:20", "restoreUntil": None},
                    "spans": [
                        {"start": f"{D}T04:00", "end": f"{D}T08:00", "mayContinue": False},
                        {"start": f"{D}T10:00", "end": f"{D}T13:20", "mayContinue": False},
                        {"start": f"{D}T16:00", "end": f"{D}T19:00", "mayContinue": False},
                        {"start": f"{D}T22:00", "end": "2026-11-17T00:00", "mayContinue": True}],
                    "alerts": [a16, a22],
                    # repair works are drawn like emergencies (owner, 2026-11-17), so 07:00-08:00 is an emergency cell
                    "days": {D: {"plannedCells": ["04:00-07:00", "10:00-13:00", "16:00-19:00", "22:00-24:00"],
                                 "switchingCells": ["00:00-00:30", "13:00-13:30", "19:00-19:30"],
                                 "emergencyCells": ["07:00-08:00", "13:00-13:30"], "totalOffMinutes": 740}}}},
        {"name": "no table known: no outages, no switching",
         "today": D, "now": f"{D}T12:00", "advanceMinutes": 15, "cells": {"today": None, "tomorrow": None},
         "expect": {"status": {"isOffNow": False, "countdownText": "--:--:--", "nextSlotTime": "Відключень немає", "restoreUntil": None},
                    "spans": [], "alerts": [],
                    "days": {D: {"plannedCells": [], "switchingCells": [], "emergencyCells": [], "totalOffMinutes": 0}}}},
    ],
}

# Several connections at one address (live, 17.11 for Полтава, Європейська 88): no queue in the answer,
# which is not "no queue" (spec/POE_API.md 8.5, 8.11)
for c in poe['addressStatus']:
    c['expect'].setdefault('severalConnections', False)
poe['addressStatus'].append(
    {"name": "live (17.11): several connections at the address (Полтава, Європейська 88): no queue given, which is not 'no queue'",
     "today": "2026-11-17", "in": fx('type0_several'),
     "expect": {"messageType": 0, "queue": None, "emergency": None, "repairs": [], "scheduleMirror": False, "unparsed": False,
                "severalConnections": True}})

# ---------------------------------------------------------------- queue_catalogue.json (spec/POE_API.md 8.11)
def ce(q, branch, row, settlement, street, houses=(), ranges=(), whole=None):
    return {"q": q, "branch": branch, "row": row, "settlement": settlement, "street": street,
            "houses": list(houses), "ranges": [list(r) for r in ranges], "whole": whole}


CAT = [
    ce("3.1", "poltavska", 28, "Полтава", "Європейська", ["78", "86", "88"]),
    ce("1.1", "poltavska", 37, "Полтава", "Європейська", whole="street"),
    ce("5.1", "poltavska", 19, "Полтава", "Європейська", ["88б", "28"]),
    ce("5.1", "poltavska", 39, "Полтава", "Юліана Матвійчука", ["47", "49"]),
    ce("1.1", "poltavska", 46, "Полтава", "Матвійчука", ["44", "49"]),
    ce("2.1", "pyriatynska", 10, "Пирятин", "Приудайський Узвіз", ranges=[[1, 33], [2, 60]]),
    ce("2.2", "reshetylivska", 5, "Братешки", None, whole="settlement"),
    ce("4.1", "pyriatynska", 3, "Пирятин", "Європейська", ["88"]),
    ce("6.1", "poltavska", 50, "Полтава", "П.Дорошенка", ["15"]),
    ce("1.2", "poltavska", 11, "Полтава", "Дорошенка", ["15"]),
    # row 1 of «П'ята черга І підчерга», Полтавська дільниця (page 66): streets without house numbers, a whole village
    ce("5.1", "poltavska-rem", 1, "Головач", "Кринична", whole="street"),
    ce("5.1", "poltavska-rem", 1, "Минівка", None, whole="settlement"),
]


def hit(q, kind, branch, row, exact=True):
    return {"queue": q, "kind": kind, "branch": branch, "row": row, "exact": exact}


catalogue = {
    "_doc": "Golden cases for QueueCatalogue.lookup (spec/POE_API.md 8.11): the queues the hourly-schedule catalogue gives "
            "for one address, best first, one per queue. 'entries' is a reduced catalogue (rows of the PDF of 2026-10-08 "
            "or constructed). 'branches' empty = any branch.",
    "entries": CAT,
    "cases": [
        {"name": "Європейська 88: the house is listed in 3.1; the whole street in 1.1 comes after; 88б of 5.1 is another house",
         "settlement": "місто Полтава", "branches": ["poltavska", "poltavska-rem"], "street": "вул. Європейська", "house": "88",
         "expect": [hit("3.1", "HOUSE", "poltavska", 28), hit("1.1", "STREET", "poltavska", 37)]},
        {"name": "88б is its own house; the street type and a Latin-free key do not matter",
         "settlement": "Полтава", "branches": [], "street": "Європейська", "house": "88Б",
         "expect": [hit("5.1", "HOUSE", "poltavska", 19), hit("1.1", "STREET", "poltavska", 37)]},
        {"name": "several rows list the same house: the full street name first, then the last-word match",
         "settlement": "місто Полтава", "branches": ["poltavska"], "street": "вул. Юліана Матвійчука", "house": "49",
         "expect": [hit("5.1", "HOUSE", "poltavska", 39), hit("1.1", "HOUSE", "poltavska", 46, exact=False)]},
        {"name": "an initial in the PDF (П.Дорошенка) meets the full name; the bare surname of another row comes later",
         "settlement": "місто Полтава", "branches": ["poltavska"], "street": "вул. Петра Дорошенка", "house": "15",
         "expect": [hit("1.2", "HOUSE", "poltavska", 11, exact=False), hit("6.1", "HOUSE", "poltavska", 50, exact=False)]},
        {"name": "a house range covers plain numbers only",
         "settlement": "місто Пирятин", "branches": [], "street": "вул. Приудайський Узвіз", "house": "14",
         "expect": [hit("2.1", "RANGE", "pyriatynska", 10)]},
        {"name": "a lettered house is not inside a number range",
         "settlement": "місто Пирятин", "branches": [], "street": "вул. Приудайський Узвіз", "house": "14а",
         "expect": []},
        {"name": "a whole village",
         "settlement": "село Братешки", "branches": ["reshetylivska"], "street": "вул. Шевченка", "house": "3",
         "expect": [hit("2.2", "SETTLEMENT", "reshetylivska", 5)]},
        {"name": "the same street name in another settlement does not count",
         "settlement": "місто Пирятин", "branches": [], "street": "вул. Європейська", "house": "88",
         "expect": [hit("4.1", "HOUSE", "pyriatynska", 3)]},
        {"name": "entries of other branches are skipped when the address's branches are known",
         "settlement": "місто Пирятин", "branches": ["poltavska"], "street": "вул. Європейська", "house": "88",
         "expect": []},
        {"name": "no street and no house: nothing but a whole settlement can match",
         "settlement": "місто Полтава", "branches": [], "street": "", "house": "",
         "expect": []},
        {"name": "a whole village without a street (село Минівка: the picker has no street to offer)",
         "settlement": "село Минівка", "branches": ["poltavska-rem"], "street": "", "house": "",
         "expect": [hit("5.1", "SETTLEMENT", "poltavska-rem", 1)]},
        {"name": "a whole street without a house number (село Головач, вул. Кринична: POE lists no houses)",
         "settlement": "село Головач", "branches": [], "street": "вул. Кринична", "house": "",
         "expect": [hit("5.1", "STREET", "poltavska-rem", 1)]},
        {"name": "a street without a house number matches the whole street only, never a listed house",
         "settlement": "місто Полтава", "branches": ["poltavska"], "street": "вул. Європейська", "house": "",
         "expect": [hit("1.1", "STREET", "poltavska", 37)]},
        {"name": "a whole village also covers a street of it given without a house",
         "settlement": "село Братешки", "branches": [], "street": "вул. Шевченка", "house": "",
         "expect": [hit("2.2", "SETTLEMENT", "reshetylivska", 5)]},
    ],
    "confident": [
        {"name": "the best hint is the only one of its kind: a refresh may take it",
         "hints": [hit("3.1", "HOUSE", "poltavska", 28), hit("1.1", "STREET", "poltavska", 37)], "expect": "3.1"},
        {"name": "one house in rows of two queues: a tie, the user chooses",
         "hints": [hit("2.2", "HOUSE", "poltavska", 4), hit("5.1", "HOUSE", "poltavska", 19)], "expect": None},
        {"name": "same kind but an exact street name beats a last-word match",
         "hints": [hit("1.2", "HOUSE", "poltavska", 11), hit("6.1", "HOUSE", "poltavska", 50, exact=False)], "expect": "1.2"},
        {"name": "two last-word matches of the same kind: a tie",
         "hints": [hit("1.2", "HOUSE", "poltavska", 11, exact=False), hit("6.1", "HOUSE", "poltavska", 50, exact=False)], "expect": None},
        {"name": "a whole village alone",
         "hints": [hit("5.1", "SETTLEMENT", "poltavska-rem", 1)], "expect": "5.1"},
        {"name": "no hints",
         "hints": [], "expect": None},
    ],
}

for name, obj in (('poe_api.json', poe), ('outage_engine_poe.json', engine), ('queue_catalogue.json', catalogue)):
    with open(f'{ROOT}/spec/vectors/{name}', 'w', encoding='utf-8', newline='\n') as f:
        json.dump(obj, f, ensure_ascii=False, indent=1)
        f.write('\n')
print({k: len(v) for k, v in poe.items() if isinstance(v, list)}, 'engine cases', len(engine['cases']))

# ---------------------------------------------------------------- poe_schedule.json
import re as _re

QUEUES = ["1.1", "1.2", "2.1", "2.2", "3.1", "3.2", "4.1", "4.2", "5.1", "5.2", "6.1", "6.2"]


def _fmt(i):
    return '24:00' if i == 48 else f'{i // 2:02d}:{(i % 2) * 30:02d}'


def _runs(cells, ch):
    out, s = [], None
    for i in range(49):
        on = i < 48 and cells[i] == ch
        if on and s is None:
            s = i
        if not on and s is not None:
            out.append(f'{_fmt(s)}-{_fmt(i)}')
            s = None
    return out


def _expect_queues(table):
    return {q: {"off": _runs(c, 's2'), "switching": _runs(c, 's3')} for q, c in table.items()}


def _live_table():
    h = open(f'{ROOT}/spec/fixtures/poe/poe_newgpv_2026-11-16.html', encoding='utf-8').read()
    t = h[h.index('class="gpv-table"'):]
    t = t[:t.index('</table>')]
    rows = _re.findall(r'<td class="gpv-q"[^>]*>([\d.]+)</td>(.*?)</tr>', t, _re.S)
    return {q: ['s' + m for m in _re.findall(r'class="gpv-c gpv-s(\d)', body)] for q, body in rows}


def _mini(date_text, table, stamp="1 січня 2027 08:00", head_extra=""):
    rows = ''.join(
        f'<tr><td class="gpv-q" title="Черга">{q}</td>' + ''.join(f'<td class="gpv-c gpv-{c}"></td>' for c in cells) + '</tr>'
        for q, cells in table.items())
    return (f'<div class="gpvinfodetail"> Графік на <b>{date_text}</b>{head_extra}<p class="gpv-title">Порядок відключення черг</p>'
            f'<table class="gpv-table"><thead><tr><th class="gpv-q">Черга</th></tr></thead><tbody>{rows}</tbody></table>'
            f'<ul class="gpv-periods"></ul><p class="gpv-note">Оновлено: {stamp}</p></div>')


live = _live_table()
assert len(live) == 12 and all(len(c) == 48 for c in live.values())
mini_ok = {q: (['s2'] * 48 if q == '1.1' else ['s1'] * 20 + ['s2'] * 6 + ['s3'] + ['s1'] * 21) for q in QUEUES}
short_row = dict(mini_ok)
short_row['3.2'] = ['s1'] * 47
missing = {q: c for q, c in mini_ok.items() if q != '6.2'}
unknown_class = dict(mini_ok)
unknown_class['4.1'] = ['s1'] * 47 + ['s9']
ERROR_BODY = '{"type":"about:blank","title":"Bad Request","status":400,"detail":"Failed to read request","instance":"/poeREST/abon/site/turnoff/schedule/get/v2"}'

schedule = {
    "_doc": "Golden cases for the POE schedule fragment parser (spec/POE_API.md section 3, PoeSchedule.parseDay). A case gives either 'fixture' (a file in spec/fixtures/poe/) or 'html' (inline, null allowed), the requested 'date', and the expected kind, stamp, reason and, when PUBLISHED, every queue as cell ranges per state ('off' = gpv-s2, 'switching' = gpv-s3).",
    "cases": [
        {"name": "live page of 2026-11-16, all 12 queues", "fixture": "poe_newgpv_2026-11-16.html", "date": "2026-11-16",
         "expect": {"kind": "PUBLISHED", "stamp": "15 листопада 2026 22:46", "reason": None, "queues": _expect_queues(live)}},
        {"name": "live page read for another day is invalid (date check)", "fixture": "poe_newgpv_2026-11-16.html", "date": "2026-11-17",
         "expect": {"kind": "INVALID", "stamp": None, "reason": "date_mismatch"}},
        {"name": "live: empty body = tomorrow not published yet", "html": "", "date": "2026-11-17",
         "expect": {"kind": "NOT_PUBLISHED", "stamp": None, "reason": None}},
        {"name": "null body = not published", "html": None, "date": "2026-11-17",
         "expect": {"kind": "NOT_PUBLISHED", "stamp": None, "reason": None}},
        {"name": "whitespace only = not published", "html": "  \n\t ", "date": "2026-11-17",
         "expect": {"kind": "NOT_PUBLISHED", "stamp": None, "reason": None}},
        {"name": "live: JSON error answer (HTTP 200) is invalid, never 'no outages'", "html": ERROR_BODY, "date": "2026-11-16",
         "expect": {"kind": "INVALID", "stamp": None, "reason": "error_body"}},
        {"name": "constructed: minimal valid table", "html": _mini("1 січня 2027 року", mini_ok), "date": "2027-01-01",
         "expect": {"kind": "PUBLISHED", "stamp": "1 січня 2027 08:00", "reason": None, "queues": _expect_queues(mini_ok)}},
        {"name": "constructed: a row with 47 cells", "html": _mini("1 січня 2027 року", short_row), "date": "2027-01-01",
         "expect": {"kind": "INVALID", "stamp": None, "reason": "bad_row"}},
        {"name": "constructed: queue 6.2 missing", "html": _mini("1 січня 2027 року", missing), "date": "2027-01-01",
         "expect": {"kind": "INVALID", "stamp": None, "reason": "missing_queue"}},
        {"name": "constructed: unknown cell class", "html": _mini("1 січня 2027 року", unknown_class), "date": "2027-01-01",
         "expect": {"kind": "INVALID", "stamp": None, "reason": "bad_row"}},
        {"name": "constructed (wording not seen live yet): published without outages", "html": "<div class=\"gpvinfodetail\">17 листопада 2026 року графіки погодинних відключень не застосовуються.<p>Оновлено: 16 листопада 2026 21:00</p></div>", "date": "2026-11-17",
         "expect": {"kind": "PUBLISHED", "stamp": "16 листопада 2026 21:00", "reason": None,
                    "queues": {q: {"off": [], "switching": []} for q in QUEUES}}},
        {"name": "constructed: text without a table or a 'not applied' notice", "html": "<div>17 листопада 2026 року інформація оновлюється</div>", "date": "2026-11-17",
         "expect": {"kind": "INVALID", "stamp": None, "reason": "no_table"}},
        {"name": "constructed: no date in the header", "html": "<div>Порядок відключення черг</div>", "date": "2026-11-17",
         "expect": {"kind": "INVALID", "stamp": None, "reason": "no_date"}},
    ],
}
with open(f'{ROOT}/spec/vectors/poe_schedule.json', 'w', encoding='utf-8', newline='\n') as f:
    json.dump(schedule, f, ensure_ascii=False, indent=1)
    f.write('\n')
print('schedule cases', len(schedule['cases']))
