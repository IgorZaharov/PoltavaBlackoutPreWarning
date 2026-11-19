import Foundation

/// A finished HTTP exchange, independent of URLSession so parsers and clients can be tested with fakes.
public struct HttpResponse: Sendable {
    public var status: Int
    /// Header names lower-cased.
    public var headers: [String: String]
    public var body: Data

    public init(status: Int, headers: [String: String] = [:], body: Data) {
        self.status = status
        self.headers = headers
        self.body = body
    }

    public func header(_ name: String) -> String? { headers[name.lowercased()] }
}

public enum HttpError: Error, Sendable {
    /// A non-2xx answer (304 is returned as a response, never thrown).
    case status(Int)
}

/// Seam for tests (plain GETs: the directory and catalogue downloads; POE posts go through `PoeTransport`).
public protocol HttpClient: Sendable {
    func send(_ request: URLRequest) async throws -> HttpResponse
}

/// The production client. gzip is handled by URLSession; caching is done by the callers (ETag, own caches).
public struct URLSessionHttp: HttpClient {
    public static let shared = URLSessionHttp()

    private let session: URLSession

    public init(timeoutSeconds: TimeInterval = 8) {
        let config = URLSessionConfiguration.ephemeral
        config.requestCachePolicy = .reloadIgnoringLocalCacheData
        config.urlCache = nil
        config.timeoutIntervalForRequest = timeoutSeconds
        config.timeoutIntervalForResource = timeoutSeconds * 4
        config.waitsForConnectivity = false
        session = URLSession(configuration: config)
    }

    public func send(_ request: URLRequest) async throws -> HttpResponse {
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw URLError(.badServerResponse) }
        var headers: [String: String] = [:]
        for (k, v) in http.allHeaderFields {
            if let key = k as? String, let value = v as? String { headers[key.lowercased()] = value }
        }
        return HttpResponse(status: http.statusCode, headers: headers, body: data)
    }
}

public enum Http {
    /// Maps a thrown error to the platform-neutral failure kind of spec/SITE_STATE.md.
    public static func failure(of error: Error) -> FetchFailure {
        if case HttpError.status = error { return .HTTP_ERROR }
        guard let u = error as? URLError else { return .OTHER }
        switch u.code {
        case .cannotFindHost, .dnsLookupFailed:
            return .DNS
        case .cannotConnectToHost, .networkConnectionLost, .notConnectedToInternet, .internationalRoamingOff,
             .dataNotAllowed, .callIsActive:
            return .CONNECT
        case .timedOut:
            return .TIMEOUT
        case .secureConnectionFailed, .serverCertificateHasBadDate, .serverCertificateUntrusted,
             .serverCertificateHasUnknownRoot, .serverCertificateNotYetValid, .clientCertificateRejected,
             .clientCertificateRequired, .appTransportSecurityRequiresSecureConnection:
            return .TLS
        case .badServerResponse:
            return .HTTP_ERROR
        default:
            return .OTHER
        }
    }
}

/// Shared HTML helpers for the regex scanners (no DOM parser on iOS).
public enum Html {
    private static let blockTag = Rx("<(?:br|/?(?:p|div|tr|td|th|li|table|tbody|thead|h[1-6]))\\b[^>]*>", ignoreCase: true)
    private static let tag = Rx("<[^>]*>")
    private static let ws = Rx("[ \\t\\n\\x{0B}\\f\\r\\u00A0]+")

    /// Jsoup `Element.text()`: block tags become a space, inline tags (`<b>`, `<font>`) vanish without
    /// one, entities are decoded, whitespace is collapsed and trimmed.
    public static func text(_ html: String) -> String {
        let noTags = tag.replace(blockTag.replace(html, template: " "), template: "")
        return ws.replace(TextNorm.decodeEntities(noTags), template: " ").ktTrim()
    }
}
