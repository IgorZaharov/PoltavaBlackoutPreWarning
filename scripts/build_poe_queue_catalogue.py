"""Address -> queue catalogue from the POE hourly-schedule PDF (графік погодинних відключень, ГПВ).

The page https://www.poe.pl.ua/disconnection/hrafik-pohodynnoho-vidkliuchennia-elektroenerhii/ links one PDF
(an Excel export, about 95 pages) that lists, per queue and sub-queue and per branch, numbered rows of
free text: settlements, streets, house numbers and ranges, and companies. The per-house status (E4) does
not give a queue for every house (for example "several connections at this address"); this catalogue is
the second source. Rows are free text, so every row keeps its raw text next to the parsed entries.

Usage:
  python -X utf8 scripts/build_poe_queue_catalogue.py --update [poe_queues.json]
      Reads the page, finds the PDF, and rebuilds the catalogue only when the PDF (or PARSER_VERSION) changed:
      a conditional request (ETag / Last-Modified of the last build) first, then a SHA-256 of the download. Prints
      "changed=true|false" (also to $GITHUB_OUTPUT when set).
  python -X utf8 scripts/build_poe_queue_catalogue.py --pdf FILE.pdf [poe_queues.json]
      Builds from a local file (no network).
  python -X utf8 scripts/build_poe_queue_catalogue.py --lookup "місто Полтава" "вул. Європейська" 88 [poe_queues.json]
      Prints the queues the catalogue gives for one address, with the row each one comes from.
  python -X utf8 scripts/build_poe_queue_catalogue.py --company "Полтавахолод" [poe_queues.json]
      Prints the companies whose name contains the text, with their queue.
  python -X utf8 scripts/build_poe_queue_catalogue.py --selftest
      Checks the row parser on rows copied from the PDF of 2026-10-08 (no network, no PyMuPDF).

Checked by hand against POE's per-house status on 2026-11-16: Полтава, Європейська 88 -> 3.1, Юліана
Матвійчука 47 -> 5.1 (both "several connections" in E4), Соборності 1 -> 1.1; a random sample of 25 Poltava
houses agreed in all 11 cases where E4 gave a queue (the other 14 were "several connections").

Needs PyMuPDF (pip install pymupdf). Output layout: see the "_doc" field of the written JSON.
"""
import datetime
import hashlib
import html
import json
import os
import re
import sys
import urllib.request
from collections import Counter

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
PAGE_URL = 'https://www.poe.pl.ua/disconnection/hrafik-pohodynnoho-vidkliuchennia-elektroenerhii/'
UA = 'Mozilla/5.0 (Linux; Android 14) PoltavaBlackoutPreWarning-queues'
DEFAULT_OUT = os.path.join(ROOT, 'poe_queues.json')
# Raise when the parser changes: --update then rebuilds even if the PDF did not change
PARSER_VERSION = 3

ORDINALS = {'перша': 1, 'друга': 2, 'третя': 3, 'четверта': 4, "п'ята": 5, 'шоста': 6}
APOSTROPHES = re.compile(r"[’ʼ`´‘]")
STREET_TYPES = (
    r'вулиця|вул|провулок|пров|пров-к|пер|бульвар|бульв|б-р|проспект|просп|пр-т|пр|тупик|туп|п-к|'
    r'площа|пл|майдан|узвіз|шосе|проїзд|в\'їзд|квартал|кв-л|мікрорайон|мкр'
)
SETTLEMENT_TYPES = r'місто|м|село|с|селище|смт|сщ|с-ще'
ENTITY = re.compile(
    r'["«»]|\b(ТОВ|ПАТ|ПрАТ|ПРАТ|АТ|ПП|ДП|КП|ФОП|ЗАТ|ВАТ|ОСББ|ТП|КТП|ЗТП|РП|ПС|ГРП|СТ|КНП|ДНЗ|ЗОШ|ЗДО)\b|ТП-|КТП-|станці|свердловин|насосн',
)
HOUSE = re.compile(r'^(?:з\s*)?\d+[^\s,]*(?:\s*(?:-|–|по)\s*\d+[^\s,]*)?$|^\d+\s?[а-яієїґ]$', re.IGNORECASE)
RANGE = re.compile(r'^(?:з\s*)?(\d+)\D{0,3}?\s*(?:-|–|по)\s*(\d+)', re.IGNORECASE)


# ---------------------------------------------------------------------------------------------
# Keys (simple versions of StreetKey / settlementKey, for building and for --lookup)
# ---------------------------------------------------------------------------------------------

def key(name: str) -> str:
    s = APOSTROPHES.sub("'", html.unescape(name)).lower()
    s = re.sub(rf'^(?:{SETTLEMENT_TYPES})\.?\s+', '', s.strip())
    # a type word ends at a dot or a space: "Перемоги" does not start with "пер"
    s = re.sub(rf'^(?:{STREET_TYPES})(?:\.\s*|\s+)', '', s)
    s = re.sub(r'\([^)]*\)', ' ', s)
    return re.sub(r"[^0-9a-zа-яієїґ']+", '', s)


# full street keys of every directory street (filled by load_directory_streets), so a quoted street name is
# not read as a company
DIRECTORY_STREETS: set = set()


def load_directory_streets(directory):
    DIRECTORY_STREETS.clear()
    for st in directory['settlements']:
        for _, name in st['streets']:
            DIRECTORY_STREETS.update(k for k in street_keys(name) if not k.startswith('~'))


LATIN_LOOKALIKES = str.maketrans('aceiopxyk', 'асеіорхук')


def street_keys(name: str) -> set:
    """The full key and the key of the last word, so "П.Дорошенка" meets "Петра Дорошенка"."""
    # apostrophes and the directory's backtick quotes ("Героїв `Азову`") are dropped, as StreetKey does
    s = APOSTROPHES.sub("'", name).lower().replace("'", '').translate(LATIN_LOOKALIKES)
    s = re.sub(rf'^(?:{STREET_TYPES})(?:\.\s*|\s+)', '', s.strip())
    s = re.sub(r'\([^)]*\)', ' ', s)
    words = [w for w in re.split(r"[^0-9a-zа-яієїґ]+", s) if w]
    out = {''.join(words)}
    if words:
        out.add('~' + words[-1])
    return out


def house_key(h: str) -> str:
    s = h.lower().replace(' ', '').replace('-', '')
    s = s.translate(str.maketrans('abceikmopxy', 'авсеікморху'))
    return s


# ---------------------------------------------------------------------------------------------
# PDF -> rows
# ---------------------------------------------------------------------------------------------

def pdf_lines(path):
    import pymupdf  # imported here so --lookup works without PyMuPDF
    doc = pymupdf.open(path)
    for pi, page in enumerate(doc):
        items = []
        for b in page.get_text('dict')['blocks']:
            for ln in b.get('lines', []):
                text = ''.join(s['text'] for s in ln['spans'])
                if text.strip():
                    items.append((ln['bbox'][1], ln['bbox'][0], text))
        items.sort(key=lambda x: (round(x[0], 1), x[1]))
        merged = []
        for y, x, t in items:
            if merged and abs(merged[-1][0] - y) < 2.5:
                merged[-1] = (merged[-1][0], min(merged[-1][1], x), merged[-1][2] + ' ' + t)
            else:
                merged.append((y, x, t))
        for y, x, t in merged:
            yield pi, x, t


def branch_slug(heading: str, branches) -> str | None:
    h = APOSTROPHES.sub("'", heading).lower()
    if h.startswith('полтавська'):
        return 'poltavska-rem' if 'рем' in h.split() or 'дільниця' in h else 'poltavska'
    first = re.split(r'\s+', h)[0]
    for b in branches:
        if b['nameUk'].lower()[:5] == first[:5]:
            return b['slug']
    return None


def read_rows(path, branches):
    rows, period = [], None
    queue = branch = heading = None
    cur = None
    for pi, x, t in pdf_lines(path):
        s = re.sub(r'\s+', ' ', APOSTROPHES.sub("'", t)).strip()
        low = s.lower()
        if low.startswith('графік погодинного'):
            m = re.search(r'з\s*(\d{2}\.\d{2}\.\d{4})\s*р?\.?\s*по\s*(\d{1,2}\.\d{2}\.\d{4})', s)
            if m:
                period = [m.group(1), m.group(2)]
            continue
        m = re.match(r"^(перша|друга|третя|четверта|п'ята|шоста) черга(?: (і{1,2}|i{1,2}) підчерга)?$", low)
        if m and x > 150:
            if m.group(2):
                queue = f'{ORDINALS[m.group(1)]}.{len(m.group(2))}'
                branch = heading = None
            cur = None
            continue
        if x > 150 and ('дільниця' in low or "об'єднана філія" in low) and len(s) < 120:
            heading, branch = s, branch_slug(s, branches)
            cur = None
            continue
        n = re.match(r'^(\d{1,4})(?:\s+(.*))?$', s)
        if n and x < 30 and queue:
            cur = {'q': queue, 'branch': branch, 'heading': heading, 'n': int(n.group(1)), 'page': pi + 1, 'text': n.group(2) or ''}
            rows.append(cur)
        elif cur is not None:
            cur['text'] = (cur['text'] + ' ' + s).strip()
    return rows, period


# ---------------------------------------------------------------------------------------------
# Row text -> entries
# ---------------------------------------------------------------------------------------------

def pieces_of(text: str):
    t = APOSTROPHES.sub("'", html.unescape(text))
    # "вул.Х", "м. Полтава" -> no dot, so ". " can split sentences
    t = re.sub(rf'\b({STREET_TYPES}|{SETTLEMENT_TYPES})\.\s*', r'\1 ', t, flags=re.IGNORECASE)
    t = re.sub(r'(\d)\s+([а-яієїґ])\b', r'\1\2', t)  # "52 а" -> "52а"
    # a company with its quoted name is cut out, so the addresses around it survive
    t = re.sub(r'\b(?:ТОВ|ПАТ|ПрАТ|ПРАТ|АТ|ПП|ДП|КП|ФОП|ЗАТ|ВАТ|ОСББ|КНП|СТ)\s*["«][^"»]*["»]', ';', t)
    t = re.sub(r'["«][^"»]{1,80}["»]', ';', t)
    # a settlement or a street type in the middle of a piece starts a new piece
    t = re.sub(rf'\s(?=(?:{SETTLEMENT_TYPES})\s+[А-ЯІЇЄҐ])', ';', t)
    t = re.sub(rf'\s(?=(?:{STREET_TYPES})\s+[А-ЯІЇЄҐ0-9])', ';', t)
    for p in re.split(r'[;,()]|:\s*|\.\s+|\.$|№', t):
        p = p.strip(' .-–')
        if p:
            yield p


COMPANY_FORMS = r'ТОВ|ТзОВ|ПАТ|ПрАТ|ПРАТ|АТ|ПП|ДП|КП|ФОП|ФО|ЗАТ|ВАТ|ОСББ|КНП|СТ|ОК|ОКП|КЗ|ДПЗКУ|СФГ|ФГ|СВК|ПСП|АФ|ТДВ'
COMPANY = re.compile(rf'\b({COMPANY_FORMS})\s*["«]\s*([^"»]{{2,90}}?)\s*["»]|(Філія|філія)\s+([^,;.]{{3,90}})')
# a sole trader without quotes: "ФОП Ландарь Ю.І.", "ФО Рябушко В.Г.", "ФОП.Сайно", "ФОП Суворов"
# a quote the PDF never closes: ТОВ "ГЛОБИНСЬКИЙ БІОЕНЕРГЕТИЧНИЙ КОМПЛЕКС 21 (the name runs to the end, a number is cut off)
UNCLOSED = re.compile(rf'\b({COMPANY_FORMS})\s*["«]\s*([^"»]{{2,90}}?)(?:\s+\d[\d,\s]*)?\s*$')
# Schools, kindergartens and other institutions inside address rows ("Школа № 27", "Д/С№31", "Гімназія № 5",
# "Медичний фаховий коледж"): the PDF never says ЗОШ or ДНЗ, so each kind carries the words people search for
INSTITUTION_KINDS = [
    (r'школа[\s-]*інтернат', 'Школа-інтернат', 'ЗОШ ЗЗСО школа інтернат'),
    (r'спортшкола|дюсш', 'Спортшкола', 'ДЮСШ спортивна школа'),
    (r'школа', 'Школа', 'ЗОШ ЗЗСО заклад загальної середньої освіти'),
    (r'гімназія', 'Гімназія', 'ЗОШ ЗЗСО школа'),
    (r'ліцей', 'Ліцей', 'ЗОШ ЗЗСО школа'),
    (r'д\s*[/\\]\s*с|дит\.?\s*сад(?:ок)?|дитячий\s+садок', 'Дитячий садок', 'ДНЗ ЗДО садочок дитсадок д/с'),
]
INSTITUTION = re.compile(
    r'(?<![\w-])(' + '|'.join(k for k, _, _ in INSTITUTION_KINDS) + r')(?![\w-])\s*(?:№\s*)?(\d{1,3}(?![\d/,-]\d)[а-яієї]?\b)?',
    re.IGNORECASE)
NAMED_INSTITUTION = re.compile(
    r"((?:[А-ЯІЇЄҐ][а-яієїґ'-]+\s+(?:[А-ЯІЇЄҐа-яієїґ'-]+\s+){0,2})?"
    r"(?i:коледж|диспансер|лікарня|поліклініка|амбулаторія|колонія|технікум|училище|університет)(?![\w-])"
    r"(?:\s*№\s*\d+)?)")


def institutions_of(text: str):
    # [(name, aliases)] of the schools, kindergartens and named institutions of a row
    t = APOSTROPHES.sub("'", html.unescape(text))
    out = []
    for m in INSTITUTION.finditer(t):
        kind = next((name, aliases) for k, name, aliases in INSTITUTION_KINDS if re.fullmatch(k, m.group(1), re.IGNORECASE))
        name = f'{kind[0]} № {m.group(2)}' if m.group(2) else kind[0]
        if all(n != name for n, _ in out):
            out.append((name, kind[1]))
    for m in NAMED_INSTITUTION.finditer(t):
        name = re.sub(r'\s+', ' ', m.group(1)).strip()
        name = name[0].upper() + name[1:]
        if all(n != name for n, _ in out):
            out.append((name, ''))
    return out


# any other quoted name, with the word in front of it: кафе "Аква", цех "Фламінго", готель"Славутич"
QUOTED = re.compile(r"(?:([А-ЯІЇЄҐ]{2}|[А-ЯІЇЄҐа-яієїґ'-]{3,})\s*)?[\"«]\s*([^\"»]{2,60}?)\s*[\"»]")
SOLE_TRADER = re.compile(r"\b(ФОП|ФО)\.?\s*(?![\"«])([А-ЯІЇЄҐ][А-ЯІЇЄҐа-яієїґ'-]+(?:\s+[А-ЯІЇЄҐ]\.\s*(?:[А-ЯІЇЄҐ]\b\.?)?)?)")


def companies_of(text: str):
    """Companies named in a row: legal form + quoted name ("ТОВ «Літіз»"), "Філія ...", a sole trader, any other
    quoted name with the word before it ("кафе «Аква»"); [] when none."""
    t = APOSTROPHES.sub("'", html.unescape(text))
    out = []
    taken = []  # spans of the legal-form names, so their quotes are not read again below
    for m in COMPANY.finditer(t):
        taken.append((m.start(), m.end()))
        if m.group(1):
            inner = m.group(2)
            # nested quotes: ПАТ "Кременчуцька кондитерська фабрика "Рошен"" - the first match stops at the inner quote
            rest = re.match(r'([^\W\d_][^"»]{0,59})["»]', t[m.end():])
            if rest:
                taken.append((m.end(), m.end() + rest.end()))
                inner = f'{inner.strip()} «{rest.group(1).strip()}»'
            name = f'{m.group(1)} «{inner.strip()}»'
        else:
            name = f'{m.group(3)} {m.group(4).strip()}'
        if name not in out:
            out.append(name)
    m = UNCLOSED.search(t)
    # only when the quote really is open: an odd number of quotes after the legal form
    if m and len(re.findall(r'["«»]', t[m.start():])) == 1:
        taken.append((m.start(), m.end()))
        name = f'{m.group(1)} «{m.group(2).strip()}»'
        if name not in out:
            out.append(name)
    forms = set(COMPANY_FORMS.split('|'))
    for m in QUOTED.finditer(t):
        if any(a < m.end() and m.start() < b for a, b in taken):
            continue
        inner = m.group(2).strip()
        word = m.group(1)
        if not re.search(r'[А-ЯІЇЄҐа-яієїґA-Za-z]{2}', inner) or (word and word in forms):
            continue
        # a quoted street name is an address, not a company: вул. "Енеїди", вул. Героїв "Азовсталі",
        # вул. Штурмового загону "Одін" (a street type in front, in the same piece of the row)
        if word and re.fullmatch(rf'(?:{STREET_TYPES}|{SETTLEMENT_TYPES})', word, re.IGNORECASE):
            continue
        piece = re.split(r'[,;:]', t[max(0, m.start() - 40):m.start()])[-1]
        if re.search(rf'(?:^|[\s.])(?:{STREET_TYPES})(?:\.|\s)', piece, re.IGNORECASE):
            continue
        # ... or a street of the POE directory written without its type: Штурмового Загону "Одін", "Енеїди"
        # (the match starts at [word]; the words of the piece before it complete the street name)
        words_before = ' '.join(re.findall(r"[А-ЯІЇЄҐа-яієїґ'-]+", piece)[-2:] + ([word] if word else []))
        full_keys = (k for w in ('', word or '', words_before) for k in street_keys(f'{w} {inner}'.strip()) if not k.startswith('~'))
        if any(k in DIRECTORY_STREETS for k in full_keys):
            continue
        name = f'{word} «{inner}»' if word else f'«{inner}»'
        if name not in out:
            out.append(name)
    for m in SOLE_TRADER.finditer(t):
        name = f'{m.group(1)} {m.group(2).strip()}'
        if name not in out:
            out.append(name)
    return out


def company_key(name: str) -> str:
    s = APOSTROPHES.sub("'", name).lower()
    s = re.sub(rf'^(?:{COMPANY_FORMS.lower()})\b', '', s.strip())
    return re.sub(r"[^0-9a-zа-яієїґ']+", '', s)


def company_words(text: str) -> str:
    s = APOSTROPHES.sub("'", html.unescape(text)).lower()
    return ' '.join(w for w in re.split(r"[^0-9a-zа-яієїґ']+", s) if w)


def search_companies(cat, text: str):
    """Companies whose name contains [text]; then rows whose raw text does (names with nested quotes such as
    «Кременчуцька кондитерська фабрика "Рошен"» are cut short by the extraction, the row text is not)."""
    k = company_key(text)
    words = company_words(text)
    if not k or not words:
        return []
    hits = [c for c in cat['companies'] if k in company_key(c['name'])]
    seen = {(c['q'], c['branch'], c['row']) for c in hits}
    for r in cat['rows']:
        # the raw text is searched by whole words from their start, so "рошен" does not match "Ворошенка"
        if (r['q'], r['branch'], r['n']) not in seen and (' ' + words) in (' ' + company_words(r['text'])):
            names = [c['name'] for c in cat['companies'] if (c['q'], c['branch'], c['row']) == (r['q'], r['branch'], r['n'])]
            hits.append({'q': r['q'], 'branch': r['branch'], 'row': r['n'], 'name': names[0] if names else r['text'][:120], 'settlement': None})
    return hits


# A town with more streets than this is never wholly in one queue ("м. Полтава ТОВ ..." names a company's town)
WHOLE_SETTLEMENT_MAX_STREETS = 150


def parse_row(text: str, settlements_here: dict):
    """Entries {settlement, street, houses, ranges, whole} of one row; settlement None = not named.
    [settlements_here]: settlement key -> number of streets, for the settlements of the row's branch."""
    entries, settlement, street, houses, ranges = [], None, None, [], []

    def flush():
        nonlocal street, houses, ranges
        if street is not None:
            entries.append({'settlement': settlement, 'street': street, 'houses': houses, 'ranges': ranges})
        street, houses, ranges = None, [], []

    def add_house(h):
        m = RANGE.match(h)
        if m and int(m.group(2)) > int(m.group(1)):
            ranges.append([int(m.group(1)), int(m.group(2))])
        else:
            houses.append(h.replace(' ', ''))

    for p in pieces_of(text):
        if ENTITY.search(p):
            flush()
            # "м.Полтава, вул. Соборності 58 КП ...": the settlement only locates a company
            for e in entries:
                if e.get('pending') and e['settlement'] == settlement:
                    e['company'] = True
            continue
        m = re.match(rf'^(?:{SETTLEMENT_TYPES})\s+([А-ЯІЇЄҐ][\w\'-]*(?:\s+[А-ЯІЇЄҐ][\w\'-]*)?)\s*(.*)$', p)
        if m and not re.match(rf'^(?:{STREET_TYPES})\s', p, re.IGNORECASE):
            flush()
            settlement = m.group(1)
            p = m.group(2).strip()
            if not p:
                entries.append({'settlement': settlement, 'street': None, 'houses': [], 'ranges': [], 'pending': True})
                continue
        if HOUSE.match(p):
            if street is not None:
                add_house(p)
            continue
        m = re.match(rf'^(?:(?:{STREET_TYPES})\s+)?(.*?[^\d\s-])[\s-]+(\d.*)$', p, re.IGNORECASE)
        if m and re.search(r'[а-яієїґ]{3}', m.group(1), re.IGNORECASE):
            flush()
            street = m.group(1).strip()
            for h in re.split(r'\s*,\s*|\s+(?=\d)', m.group(2)):
                if h and HOUSE.match(h):
                    add_house(h)
            continue
        name = re.sub(rf'^(?:{STREET_TYPES})\s+', '', p, flags=re.IGNORECASE).strip()
        if not re.search(r'[а-яієїґ]{3}', name, re.IGNORECASE) or len(name) > 60:
            continue
        flush()
        typed = bool(re.match(rf'^(?:{STREET_TYPES})\s', p, re.IGNORECASE))
        if not typed and key(name) in settlements_here:
            # a whole settlement listed by name ("с.Братешки, Кривки, Дем'янці")
            settlement = name
            entries.append({'settlement': name, 'street': None, 'houses': [], 'ranges': [], 'pending': True})
            continue
        street = name
    flush()
    # a settlement followed by its streets is not a whole settlement
    out = []
    for i, e in enumerate(entries):
        if e.pop('pending', False):
            if e.pop('company', False) or settlements_here.get(key(e['settlement']), 0) > WHOLE_SETTLEMENT_MAX_STREETS:
                continue
            if any(f['street'] is not None and f['settlement'] == e['settlement'] for f in entries[i + 1:]):
                continue
            e['whole'] = 'settlement'
        elif not e['houses'] and not e['ranges']:
            e['whole'] = 'street'
        out.append(e)
    return out


def build(pdf_path, source):
    branches = json.load(open(os.path.join(ROOT, 'spec', 'branches.json'), encoding='utf-8'))['branches']
    directory = json.load(open(os.path.join(ROOT, 'poe_directory.json'), encoding='utf-8'))
    load_directory_streets(directory)
    by_cabinet = {b['cabinetId']: b['slug'] for b in branches}
    settlements_of = {}
    for s in directory['settlements']:
        for c in s['branches']:
            settlements_of.setdefault(by_cabinet.get(c), {})[key(s['name'])] = len(s['streets'])
    # street keys of every directory settlement (all branches), so a street the PDF names can be checked
    streets_of = {}
    for s in directory['settlements']:
        ks = streets_of.setdefault(key(s['name']), set())
        for _, name in s['streets']:
            ks |= street_keys(name)
    rows, period = read_rows(pdf_path, branches)
    entries = []
    for r in rows:
        r['entries'] = parse_row(r['text'], settlements_of.get(r['branch'], {}))
        r['companies'] = companies_of(r['text'])
        r['institutions'] = institutions_of(r['text'])
    # Rows that name no settlement belong to the branch's main town: the settlement its rows name most
    seat = {}
    for b in {r['branch'] for r in rows}:
        named = Counter(key(e['settlement']) for r in rows if r['branch'] == b for e in r['entries'] if e['settlement'])
        names = {key(e['settlement']): e['settlement'] for r in rows if r['branch'] == b for e in r['entries'] if e['settlement']}
        if named:
            seat[b] = names[named.most_common(1)[0][0]]
    for r in rows:
        # a "street" the settlement does not have in the POE directory may be no street at all ("М'ясокомбінат"):
        # such entries stay (spellings differ, and the apps' lookup only matches directory streets anyway), but
        # a row with no known street at all may be a company (below)
        def known(e):
            if e['street'] is None:
                return True
            town = e['settlement'] or seat.get(r['branch'])
            have = streets_of.get(key(town)) if town else None
            return not have or bool(street_keys(e['street']) & have)
        any_known = any(known(e) for e in r['entries'])
        # a row that names neither an address nor a quoted company is a company by itself ("Редутське
        # карєроуправ. ..."); so is a row with no street of the directory ("М'ясокомбінат") when it has no house
        # numbers, no settlement or street word and is not just "юридичні споживачі"
        if not any_known and not r['companies'] and re.search(r'[А-ЯІЇЄҐа-яієїґ]{3}', r['text']):
            t = re.sub(r'\s+', ' ', r['text']).strip()
            address_like = (re.search(r'\d', t) or re.search(rf'(?:^|[\s.,;(])(?:{SETTLEMENT_TYPES}|{STREET_TYPES})(?:\.|\s)', t, re.IGNORECASE)
                            or re.fullmatch(r'\W*(?:юридичн\w*\s+)?споживач\w*\W*', t, re.IGNORECASE))
            if not r['entries'] or not address_like:
                r['companies'] = [t[:150]]
    for r in rows:
        for e in r['entries']:
            entries.append({
                'q': r['q'], 'branch': r['branch'], 'row': r['n'],
                'settlement': e['settlement'] or seat.get(r['branch']), 'settlementNamed': e['settlement'] is not None,
                'street': e['street'], 'houses': e['houses'], 'ranges': e['ranges'], 'whole': e.get('whole'),
            })
    return {
        '_doc': ('Address -> queue catalogue built by scripts/build_poe_queue_catalogue.py from the POE hourly-schedule PDF. '
                 'rows: every numbered row (q = queue.subqueue, branch = spec/branches.json slug, n = row number, text = raw text). '
                 'entries: parsed from the rows; settlement is the name as written (settlementNamed false = the row named none, '
                 'the branch\'s main town is assumed); street null = the whole settlement; whole = "street" when no houses are listed; '
                 'houses as written; ranges = [from, to] house numbers. companies: legal entities, schools, kindergartens and '
                 'other institutions named in the rows (name as written, the first settlement of the row when it names one; '
                 'aliases = words people search for that the PDF does not use, such as ЗОШ), for a search by workplace. '
                 'The text is free form: treat a match as a hint and keep the per-house status (E4) first.'),
        'source': source,
        'parserVersion': PARSER_VERSION,
        'period': period,
        'builtAt': datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
        'rows': [{'q': r['q'], 'branch': r['branch'], 'n': r['n'], 'page': r['page'], 'text': r['text']} for r in rows],
        'entries': entries,
        'companies': [
            {'q': r['q'], 'branch': r['branch'], 'row': r['n'], 'name': name, 'aliases': aliases,
             'settlement': next((e['settlement'] for e in r['entries'] if e['settlement']), None)
                           or (seat.get(r['branch']) if aliases else None)}
            for r in rows
            for name, aliases in [(n, '') for n in r['companies']] + [i for i in r['institutions'] if i[0] not in r['companies']]
        ],
    }


# ---------------------------------------------------------------------------------------------
# Lookup (for checks; the apps get their own port of it)
# ---------------------------------------------------------------------------------------------

def leading_number(h: str):
    m = re.match(r'^(\d+)', h.strip())
    return int(m.group(1)) if m else None


def lookup(cat, settlement, street, house):
    sk, stk, hk, hn = key(settlement), street_keys(street), house_key(house), leading_number(house)
    found = []
    for e in cat['entries']:
        if not e['settlement'] or key(e['settlement']) != sk:
            continue
        if e['street'] is None:
            found.append((e, 'SETTLEMENT'))
            continue
        if not (street_keys(e['street']) & stk):
            continue
        if any(house_key(h) == hk for h in e['houses']):
            found.append((e, 'HOUSE'))
        elif hn is not None and any(a <= hn <= b for a, b in e['ranges']) and hk == str(hn):
            found.append((e, 'RANGE'))
        elif e['whole'] == 'street':
            found.append((e, 'STREET'))
    order = {'HOUSE': 0, 'RANGE': 1, 'STREET': 2, 'SETTLEMENT': 3}
    return sorted(found, key=lambda f: (order[f[1]], f[0]['q']))


# ---------------------------------------------------------------------------------------------
# Network
# ---------------------------------------------------------------------------------------------

def get(url, headers=None):
    req = urllib.request.Request(url, headers={'User-Agent': UA, **(headers or {})})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return r.status, dict(r.headers), r.read()
    except urllib.error.HTTPError as e:
        if e.code == 304:
            return 304, dict(e.headers), b''
        raise


def find_pdf_url():
    _, _, body = get(PAGE_URL)
    page = body.decode('utf-8', 'replace')
    for m in re.finditer(r'<a[^>]+href="([^"]+\.pdf)"[^>]*>(.*?)</a>', page, re.S | re.I):
        label = re.sub(r'<[^>]+>|\s+', ' ', html.unescape(m.group(2))).strip().lower()
        if 'графік погодинного відключення' in label:
            return urllib.parse.urljoin(PAGE_URL, m.group(1))
    raise SystemExit('No hourly-schedule PDF link on ' + PAGE_URL)


def set_output(changed: bool):
    print(f'changed={"true" if changed else "false"}')
    if os.environ.get('GITHUB_OUTPUT'):
        with open(os.environ['GITHUB_OUTPUT'], 'a', encoding='utf-8') as f:
            f.write(f'changed={"true" if changed else "false"}\n')


def update(out):
    import tempfile
    import urllib.parse  # noqa: F401  (used by find_pdf_url)
    old = json.load(open(out, encoding='utf-8')) if os.path.exists(out) else None
    old_src = (old or {}).get('source') or {}
    url = find_pdf_url()
    headers = {}
    same_parser = (old or {}).get('parserVersion') == PARSER_VERSION
    if old_src.get('url') == url and same_parser:
        if old_src.get('etag'):
            headers['If-None-Match'] = old_src['etag']
        if old_src.get('lastModified'):
            headers['If-Modified-Since'] = old_src['lastModified']
    status, resp, body = get(url, headers)
    if status == 304:
        print('PDF not modified:', url)
        return set_output(False)
    sha = hashlib.sha256(body).hexdigest()
    if old_src.get('sha256') == sha and same_parser:
        print('PDF content unchanged:', url)
        return set_output(False)
    with tempfile.TemporaryDirectory() as tmp:
        path = os.path.join(tmp, 'hpv.pdf')
        open(path, 'wb').write(body)
        source = {'page': PAGE_URL, 'url': url, 'etag': resp.get('ETag'), 'lastModified': resp.get('Last-Modified'),
                  'sha256': sha, 'bytes': len(body)}
        cat = build(path, source)
    write(cat, out)
    set_output(True)


def write(cat, out):
    with open(out, 'w', encoding='utf-8', newline='\n') as f:
        json.dump(cat, f, ensure_ascii=False, separators=(',', ':'))
        f.write('\n')
    e = cat['entries']
    print(f"{out}: {len(cat['rows'])} rows, {len(e)} entries, {len(cat['companies'])} companies "
          f"({sum(1 for x in e if x['street'] is None)} whole settlements, {sum(1 for x in e if x['whole'] == 'street')} whole streets), "
          f"rows without a branch: {sum(1 for r in cat['rows'] if not r['branch'])}, period {cat['period']}")


SELFTEST = [
    # (row text as in the PDF, branch settlements {key: streets}, expected entries as (settlement, street, houses, ranges, whole))
    ('м. Полтава: Героїв АТО-10, 12, 13а. Європейська, 74, 86, 110. Гетьмана Сагайдачного, 6, 4; пров. Максима Красноуцького,3,3а',
     {'полтава': 1044},
     [('Полтава', 'Героїв АТО', ['10', '12', '13а'], [], None), ('Полтава', 'Європейська', ['74', '86', '110'], [], None),
      ('Полтава', 'Гетьмана Сагайдачного', ['6', '4'], [], None), ('Полтава', 'Максима Красноуцького', ['3', '3а'], [], None)]),
    ('м.Пирятин: вул.Медична, вул.Цибаня, 2Б, вул.Приудайський Узвіз, 1-33, 2-60, вул. Журналістів, 13, 23',
     {'пирятин': 300},
     [('Пирятин', 'Медична', [], [], 'street'), ('Пирятин', 'Цибаня', ['2Б'], [], None),
      ('Пирятин', 'Приудайський Узвіз', [], [[1, 33], [2, 60]], None), ('Пирятин', 'Журналістів', ['13', '23'], [], None)]),
    ("с.Потеряйки (вул.Сагайдачна, Центральна), с.Братешки, Кривки, Дем'янці",
     {'потеряйки': 5, 'братешки': 4, 'кривки': 3, "дем'янці": 6},
     [('Потеряйки', 'Сагайдачна', [], [], 'street'), ('Потеряйки', 'Центральна', [], [], 'street'),
      ('Братешки', None, [], [], 'settlement'), ('Кривки', None, [], [], 'settlement'), ("Дем'янці", None, [], [], 'settlement')]),
    ('м.Полтава, вул. Соборності 58 КП "Палац дозвілля" м.Полтава вул.Сковороди-2, 4а',
     {'полтава': 1044},
     [('Полтава', 'Соборності', ['58'], [], None), ('Полтава', 'Сковороди', ['2', '4а'], [], None)]),
    ('ТОВ «Літіз»', {}, []),
]

SELFTEST_COMPANIES = [
    ('ТОВ «Літіз»', ['ТОВ «Літіз»']),
    ('м.Полтава, вул. Соборності 58 КП "Палац дозвілля" м.Полтава вул.Сковороди-2', ['КП «Палац дозвілля»']),
    ('ПАТ "Кременчуцька кондитерська фабрика "Рошен"', ['ПАТ «Кременчуцька кондитерська фабрика «Рошен»»']),
    ('ТОВ "Цукорагропром" філія Глобинський цукрозавод, ТОВ "ГЛОБИНСЬКИЙ БІОЕНЕРГЕТИЧНИЙ КОМПЛЕКС"',
     ['ТОВ «Цукорагропром»', 'філія Глобинський цукрозавод', 'ТОВ «ГЛОБИНСЬКИЙ БІОЕНЕРГЕТИЧНИЙ КОМПЛЕКС»']),
    # the quote is never closed in the PDF (owner, 2026-11-17: not found)
    ('ТОВ "Цукорагропром" філія Глобинський цукрозавод, ТОВ "ГЛОБИНСЬКИЙ БІОЕНЕРГЕТИЧНИЙ КОМПЛЕКС 21',
     ['ТОВ «Цукорагропром»', 'філія Глобинський цукрозавод', 'ТОВ «ГЛОБИНСЬКИЙ БІОЕНЕРГЕТИЧНИЙ КОМПЛЕКС»']),
    # a quoted name after a plain word (owner, 2026-11-17: кафе "Аква" was not found)
    ('КП ВУВКГ (ПНС Конституції 18; ПНС Миру 31); кафе "Аква"; м.Горішні плавні: вул.Миру 18', ['кафе «Аква»']),
    ('ФОП Завалій М.В. Швейний цех "Фламінго" вул. Шевченка, готель"Славутич"',
     ['цех «Фламінго»', 'готель «Славутич»', 'ФОП Завалій М.В.']),
    ('ТОВ"Агрофірма "Маяк"- М\'ясокомбінат', ['ТОВ «Агрофірма «Маяк»»']),
    ('вул. Героїв "Азовсталі" 5, вул. "Енеїди", вул. Штурмового загону "Одін" 7, Елеватор ТОВ СП "Нібулон"',
     ['СП «Нібулон»']),
    ('Героїв ОУН, 35,Штурмового Загону "ОДІН" , П.Юрченка; 9в; "Енеїди" С.Коваленка; кафе "Аква"', ['кафе «Аква»']),
    # sole traders without quotes (owner, 2026-11-17: «ФОП Ландарь Ю.І.» was not found)
    ('ФОП Ландарь Ю.І.(вул.Будівельників, 23)', ['ФОП Ландарь Ю.І.']),
    ('ФО Рябушко В.Г. Побут Доронченко С.В., ФО "МОРГУН Є.О"', ['ФО «МОРГУН Є.О»', 'ФО Рябушко В.Г.']),
    ('ФОП Суворов, ФОП.Сайно', ['ФОП Суворов', 'ФОП Сайно']),
]


SELFTEST_INSTITUTIONS = [
    # owner, 2026-11-17: «ЗОШ» found nothing; the PDF says Школа, Гімназія, Д/С
    ('м. Кременчук. Д/С №8. Д/С № 25, Д/С№31. Школа 4. Спортшкола №2. Школа № 19, вул. Шевченка, 24/43- 66/2',
     ['Дитячий садок № 8', 'Дитячий садок № 25', 'Дитячий садок № 31', 'Школа № 4', 'Спортшкола № 2', 'Школа № 19']),
    ('м.Кременчук.Медичний фаховий коледж,Д/С № 67, Школа-інтернат № 21, Вул. Червона Гірка, 37',
     ['Дитячий садок № 67', 'Школа-інтернат № 21', 'Медичний фаховий коледж']),
    ('Гімназія № 22. Вул. Східна,13 - 38', ['Гімназія № 22']),
    ('вул.Освітянська, Чураївни ( 1-4), Школа, дит.сад.', ['Школа', 'Дитячий садок']),
    ('вул. Шкільна 5, пров. Лікарняний 5', []),
]


def selftest():
    failed = 0
    load_directory_streets(json.load(open(os.path.join(ROOT, 'poe_directory.json'), encoding='utf-8')))
    for text, expected in SELFTEST_INSTITUTIONS:
        got = [n for n, _ in institutions_of(text)]
        if got != expected:
            failed += 1
            print('FAIL institutions', text[:60], got)
    for text, here, expected in SELFTEST:
        got = [(e['settlement'], e['street'], e['houses'], e['ranges'], e.get('whole')) for e in parse_row(text, here)]
        if got != expected:
            failed += 1
            print('FAIL', text[:70], '\n  got     ', got, '\n  expected', expected)
    for text, expected in SELFTEST_COMPANIES:
        got = companies_of(text)
        if got != expected:
            failed += 1
            print('FAIL companies', text[:60], got)
    cat = {'entries': [{'q': '3.1', 'settlement': 'Полтава', 'street': 'Європейська', 'houses': ['86', '88'], 'ranges': [], 'whole': None},
                       {'q': '1.1', 'settlement': 'Полтава', 'street': 'Європейська', 'houses': [], 'ranges': [], 'whole': 'street'},
                       {'q': '2.1', 'settlement': 'Пирятин', 'street': 'Європейська', 'houses': ['88'], 'ranges': [], 'whole': None}]}
    qs = [e['q'] for e, _ in lookup(cat, 'місто Полтава', 'вул. Європейська', '88')]
    if qs != ['3.1', '1.1']:
        failed += 1
        print('FAIL lookup', qs)
    print('selftest:', 'FAILED' if failed else 'ok', f'({len(SELFTEST) + len(SELFTEST_COMPANIES) + len(SELFTEST_INSTITUTIONS) + 1} cases)')
    return 1 if failed else 0


def main(argv):
    if len(argv) >= 2 and argv[1] == '--selftest':
        return selftest()
    if len(argv) >= 3 and argv[1] == '--company':
        cat = json.load(open(argv[3] if len(argv) > 3 else DEFAULT_OUT, encoding='utf-8'))
        for c in search_companies(cat, argv[2])[:30]:
            print(f"{c['q']}  {c['branch']} row {c['row']}: {c['name']}" + (f" ({c['settlement']})" if c['settlement'] else ''))
        return None
    if len(argv) >= 2 and argv[1] == '--update':
        return update(argv[2] if len(argv) > 2 else DEFAULT_OUT)
    if len(argv) >= 3 and argv[1] == '--pdf':
        body = open(argv[2], 'rb').read()
        source = {'page': PAGE_URL, 'url': None, 'etag': None, 'lastModified': None,
                  'sha256': hashlib.sha256(body).hexdigest(), 'bytes': len(body)}
        return write(build(argv[2], source), argv[3] if len(argv) > 3 else DEFAULT_OUT)
    if len(argv) >= 5 and argv[1] == '--lookup':
        cat = json.load(open(argv[5] if len(argv) > 5 else DEFAULT_OUT, encoding='utf-8'))
        rows = {(r['q'], r['branch'], r['n']): r for r in cat['rows']}
        hits = lookup(cat, argv[2], argv[3], argv[4])
        if not hits:
            print('No queue found.')
        for e, how in hits:
            r = rows.get((e['q'], e['branch'], e['row']))
            print(f"{e['q']}  {how:10} {e['branch']} row {e['row']} (page {r['page'] if r else '?'}): "
                  f"{e['settlement']}, {e['street']}, houses {e['houses'][:12]} ranges {e['ranges'][:6]}")
        return None
    print(__doc__)
    return 2


if __name__ == '__main__':
    import urllib.parse  # noqa: F401
    sys.exit(main(sys.argv) or 0)
