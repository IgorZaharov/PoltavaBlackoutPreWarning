import Foundation

/// Constants of spec/config.json (`poe`) and spec/POE_API.md section 1 (mirror of android PoeConfig).
public enum PoeConfig {
    public static let BASE_URL = "https://www.poe.pl.ua/customs/"
    public static let SCHEDULE = "newgpv-info.php"
    public static let MEASURES = "unloading-info.php"
    public static let DIRECTORY = "search-disconnection-cabinet.php"
    public static let ADDRESS_STATUS = "disconnectinforesult-cabinet.php"
    public static let REGISTRY = "disconnection-gavapi.php"
    public static let READ_TIMEOUT_MS = 8_000
    public static let REGISTRY_READ_TIMEOUT_MS = 15_000
    public static let ADDRESS_STATUS_TTL_MS: Int64 = 60_000
    public static let USER_AGENT = "Mozilla/5.0 (iPhone; PoltavaBlackoutPreWarning)"
}

/// Result of one POST: the body of a 2xx answer, or why there is none.
public enum PoeHttpResult: Hashable, Sendable {
    case ok(String)
    case failed(String)
}

/// One POE request: `POST <base><endpoint>` with a single form field whose value is a JSON string
/// (spec/POE_API.md section 2). A protocol so the client can be tested with recorded answers.
public protocol PoeTransport: Sendable {
    func post(_ endpoint: String, field: String, json: String, readTimeoutMs: Int) async -> PoeHttpResult
}

/// `field=<json>` as `application/x-www-form-urlencoded` in UTF-8, encoded like java `URLEncoder`.
public enum PoeForm {
    private static let unreserved: Set<UInt8> = Set(Array("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_.*".utf8))

    public static func encode(_ value: String) -> String {
        var out = ""
        for b in value.utf8 {
            if unreserved.contains(b) {
                out.append(Character(UnicodeScalar(b)))
            } else if b == 0x20 {
                out.append("+")
            } else {
                out += String(format: "%%%02X", b)
            }
        }
        return out
    }

    public static func body(field: String, json: String) -> String { field + "=" + encode(json) }
}

/// `PoeTransport` over `URLSession` (gzip is decoded by URLSession), UTF-8. Never throws.
public struct HttpPoeTransport: PoeTransport {
    private let baseUrl: String
    private let http: HttpClient
    private let slowHttp: HttpClient

    public init(
        baseUrl: String = PoeConfig.BASE_URL,
        http: HttpClient = URLSessionHttp(timeoutSeconds: Double(PoeConfig.READ_TIMEOUT_MS) / 1000),
        slowHttp: HttpClient = URLSessionHttp(timeoutSeconds: Double(PoeConfig.REGISTRY_READ_TIMEOUT_MS) / 1000)
    ) {
        self.baseUrl = baseUrl
        self.http = http
        self.slowHttp = slowHttp
    }

    public func post(_ endpoint: String, field: String, json: String, readTimeoutMs: Int) async -> PoeHttpResult {
        guard let url = URL(string: baseUrl + endpoint) else { return .failed("network") }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.timeoutInterval = Double(readTimeoutMs) / 1000
        request.setValue("application/x-www-form-urlencoded; charset=UTF-8", forHTTPHeaderField: "Content-Type")
        request.setValue(PoeConfig.USER_AGENT, forHTTPHeaderField: "User-Agent")
        request.httpBody = Data(PoeForm.body(field: field, json: json).utf8)
        let client = readTimeoutMs > PoeConfig.READ_TIMEOUT_MS ? slowHttp : http
        do {
            let response = try await client.send(request)
            guard (200...299).contains(response.status) else { return .failed("http_\(response.status)") }
            return .ok(String(decoding: response.body, as: UTF8.self))
        } catch {
            return .failed("network")
        }
    }
}
