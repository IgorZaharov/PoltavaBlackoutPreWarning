import Foundation

/// Pure matching for the searchable address picker (mirror of android ui/components/PickerSearch.kt).
///
/// Matching is case-, apostrophe-, diacritic- and prefix-insensitive:
///  - apostrophes of every kind are dropped on both sides (via StreetKey);
///  - Latin and Cyrillic look-alike letters share one skeleton letter (via TextNorm.skeleton), so a
///    Latin "16a" finds the Cyrillic house "16А";
///  - combining marks are stripped, so "ї" matches "і" and "й" matches "и";
///  - a leading type word ("вул.", "пров.", "м.", "с.", "смт") is optional on both sides.
///
/// Results are ranked: prefix match first, then a match at the start of any word, then a plain
/// substring. Inside one rank the original order of the list is kept; houses additionally put shorter
/// keys first so "16" lists 16 before 16А and 160.
public enum PickerSearch {
    public static let NO_MATCH = -1
    public static let PREFIX = 0
    public static let WORD_PREFIX = 1
    public static let CONTAINS = 2

    public enum Kind: Sendable { case TEXT, HOUSE }

    /// Normalized form of one label or query: `full` with the type word, `core` without it.
    public struct Key: Hashable, Sendable {
        public let full: String
        public let core: String
        let kind: Kind
        public var isEmpty: Bool { full.isEmpty }
    }

    private static let marks = Rx("\\p{Mn}+")
    /// Quotes of every kind ("", «», „“) and "№" count as spaces: `ТОВ "Літіз` finds «ТОВ «Літіз»», `Школа 27`
    /// finds «Школа № 27» (Kotlin `QUOTES`).
    private static let quotes = Rx("[\"«»„“”‟‹›№]")
    private static let spaceRuns = Rx("\\s+")
    private static let separators = Rx("[-/,()\"]")

    /// Type words that may open a street or settlement name, folded exactly like the labels are.
    private static let prefixWords = [
        "вул", "вулиця", "пров", "провулок", "просп", "проспект", "пр-т", "пр-к", "б-р", "бульвар", "бульв", "бул",
        "пл", "площа", "пр-д", "проїзд", "узв", "узвіз", "туп", "тупик", "наб", "набережна", "шосе", "майдан", "м-н",
        "м", "с", "смт", "сел", "селище", "місто", "село", "район", "р-н"
    ]

    private static let leadingType: Rx = {
        var seen = Set<String>()
        let alternatives = prefixWords
            .map { foldWord($0) }
            .filter { seen.insert($0).inserted }
            .stableSorted { $0.ktLength > $1.ktLength }
            .map { NSRegularExpression.escapedPattern(for: $0) }
            .joined(separator: "|")
        return Rx("^(?:\(alternatives))(?:\\.\(Rx.ws)*|\(Rx.ws)+)")
    }()

    private static func fold(_ raw: String) -> String {
        marks.replace(raw.decomposedStringWithCanonicalMapping, template: "")
    }

    private static func foldWord(_ word: String) -> String { TextNorm.skeleton(fold(word).lowercased()) }

    public static func keyOf(_ raw: String, kind: Kind = .TEXT) -> Key {
        switch kind {
        case .HOUSE:
            let k = HouseKey.of(fold(raw))
            return Key(full: k, core: k, kind: kind)
        case .TEXT:
            let full = StreetKey.of(spaceRuns.replace(quotes.replace(fold(raw), template: " "), template: " ").ktTrim())
            var core = full
            // two passes so "м. вул. X" style double prefixes lose both words; never strip down to nothing
            for _ in 0..<2 {
                let stripped = leadingType.replaceFirst(core, template: "")
                if !stripped.isEmpty && stripped != core { core = stripped }
            }
            return Key(full: full, core: core, kind: kind)
        }
    }

    private static func wordForm(_ core: String) -> String { " " + separators.replace(core, template: " ") }

    /// Rank of `candidate` for `query`: PREFIX, WORD_PREFIX, CONTAINS or NO_MATCH. An empty query matches everything as PREFIX.
    public static func rank(_ query: Key, _ candidate: Key) -> Int {
        if query.isEmpty { return PREFIX }
        if candidate.isEmpty { return NO_MATCH }
        if candidate.full.ktStartsWith(query.full) { return PREFIX }
        if candidate.core.ktStartsWith(query.core) {
            // "вул ш" ranks "вул. Шевченка" above "пров. Шевченка"; plain "ш" treats the type word as absent
            return query.core == query.full || query.kind == .HOUSE ? PREFIX : WORD_PREFIX
        }
        if query.kind == .TEXT && wordForm(candidate.core).ktContains(wordForm(query.core)) { return WORD_PREFIX }
        if candidate.core.ktContains(query.core) || candidate.full.ktContains(query.full) { return CONTAINS }
        return NO_MATCH
    }

    public static func rank(_ query: String, _ label: String, kind: Kind = .TEXT) -> Int {
        rank(keyOf(query, kind: kind), keyOf(label, kind: kind))
    }

    /// Keys are computed once per list (966 streets), then every keystroke only compares strings.
    // MARK: - Context (a company's PDF row): searched after every label match, the matched piece shown

    private static let contextPieces = Rx("[;\\n]")
    static let SNIPPET_MAX = 70

    private static func tidy(_ s: String) -> String { spaceRuns.replace(s, template: " ").ktTrim() }

    private static func clip(_ s: String) -> String {
        guard s.count > SNIPPET_MAX else { return s }
        var head = String(s.prefix(SNIPPET_MAX - 1))
        while head.last?.isWhitespace == true { head.removeLast() }
        return head + "…"
    }

    /// Cuts at the commas outside quotes, so «Кафе "Ні пуху, ні пера"» stays one item. The PDF leaves quotes
    /// unbalanced, so there is no nesting: an opening quote (or a straight one after a space) opens, a closing
    /// one (or a straight one after a letter) closes.
    static func splitItems(_ piece: String) -> [String] {
        var out: [String] = []
        var quoted = false
        var current = ""
        var previous: Character?
        for ch in piece {
            switch ch {
            case "«", "„", "“": quoted = true
            case "»", "”": quoted = false
            case "\"": quoted = previous == nil || previous!.isWhitespace || previous == "("
            default: break
            }
            if ch == "," && !quoted {
                out.append(current)
                current = ""
            } else {
                current.append(ch)
            }
            previous = ch
        }
        out.append(current)
        return out
    }

    /// The first piece of `context` (cut at ";", a long piece again at ",") that matches `query`, to show why
    /// an item was found by its context; the clipped start of the context when the match spans pieces.
    public static func contextSnippet(_ context: String, query: String) -> String {
        let q = keyOf(query)
        for piece in contextPieces.split(context).map(tidy) where !piece.isEmpty {
            if rank(q, keyOf(piece)) == NO_MATCH { continue }
            if piece.count <= SNIPPET_MAX { return piece }
            let item = splitItems(piece).map(tidy).first { !$0.isEmpty && rank(q, keyOf($0)) != NO_MATCH }
            return clip(item ?? piece)
        }
        return clip(tidy(context))
    }

    /// One search result: the item and, when only its context matched, the piece of the context that did.
    public struct Hit<T> {
        public let item: T
        public let snippet: String?
    }

    public struct Index<T> {
        private let items: [T]
        private let kind: Kind
        private let keys: [Key]
        private let contexts: [String?]
        private let contextKeys: [Key?]

        public init(_ items: [T], kind: Kind = .TEXT, context: ((T) -> String?)? = nil, label: (T) -> String) {
            self.items = items
            self.kind = kind
            self.keys = items.map { PickerSearch.keyOf(label($0), kind: kind) }
            let found: [String?] = items.map { item in
                guard let c = context?(item), !c.isEmpty else { return nil }
                return c
            }
            self.contexts = found
            self.contextKeys = found.map { c in c.map { PickerSearch.keyOf($0, kind: kind) } }
        }

        public func search(_ query: String) -> [T] { searchHits(query).map(\.item) }

        /// Label matches by rank, then the items found only by their context, each with its snippet.
        public func searchHits(_ query: String) -> [Hit<T>] {
            let q = PickerSearch.keyOf(query, kind: kind)
            if q.isEmpty { return items.map { Hit(item: $0, snippet: nil) } }
            var hits: [(index: Int, rank: Int, length: Int, inContext: Bool)] = []
            for i in items.indices {
                let r = PickerSearch.rank(q, keys[i])
                if r != PickerSearch.NO_MATCH {
                    hits.append((i, r, keys[i].core.ktLength, false))
                    continue
                }
                if let ck = contextKeys[i] {
                    let c = PickerSearch.rank(q, ck)
                    if c != PickerSearch.NO_MATCH { hits.append((i, PickerSearch.CONTAINS + 1 + c, keys[i].core.ktLength, true)) }
                }
            }
            let house = kind == .HOUSE
            hits.sort { a, b in
                if a.rank != b.rank { return a.rank < b.rank }
                if house && a.length != b.length { return a.length < b.length }
                return a.index < b.index
            }
            let found = hits.filter { !$0.inContext }.map { keys[$0.index].full }
            var out: [Hit<T>] = []
            for h in hits {
                if !h.inContext {
                    out.append(Hit(item: items[h.index], snippet: nil))
                    continue
                }
                let snippet = PickerSearch.contextSnippet(contexts[h.index] ?? "", query: query)
                let k = PickerSearch.keyOf(snippet, kind: kind).full
                if found.contains(where: { $0 == k || $0.hasPrefix(k + " ") }) { continue }
                out.append(Hit(item: items[h.index], snippet: snippet))
            }
            return out
        }
    }

    public static func filter<T>(_ items: [T], query: String, kind: Kind = .TEXT, label: (T) -> String) -> [T] {
        Index(items, kind: kind, label: label).search(query)
    }
}
