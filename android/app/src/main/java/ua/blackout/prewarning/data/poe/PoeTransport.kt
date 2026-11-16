package ua.blackout.prewarning.data.poe

import java.io.IOException
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder
import java.util.zip.GZIPInputStream

/** Constants of spec/config.json (`poe`) and spec/POE_API.md section 1. */
object PoeConfig {
    const val BASE_URL = "https://www.poe.pl.ua/customs/"
    const val SCHEDULE = "newgpv-info.php"
    const val MEASURES = "unloading-info.php"
    const val DIRECTORY = "search-disconnection-cabinet.php"
    const val ADDRESS_STATUS = "disconnectinforesult-cabinet.php"
    const val REGISTRY = "disconnection-gavapi.php"
    const val CONNECT_TIMEOUT_MS = 8_000
    const val READ_TIMEOUT_MS = 8_000
    const val REGISTRY_READ_TIMEOUT_MS = 15_000
    const val ADDRESS_STATUS_TTL_MS = 60_000L
    const val USER_AGENT = "Mozilla/5.0 (Android; PoltavaBlackoutPreWarning)"
}

/** Result of one POST: the body of a 2xx answer, or why there is none. */
sealed interface PoeHttpResult {
    data class Ok(val body: String) : PoeHttpResult
    data class Failed(val reason: String) : PoeHttpResult
}

/**
 * One POE request: `POST <base><endpoint>` with a single form field whose value is a JSON string
 * (spec/POE_API.md section 2). An interface so the client can be tested with recorded answers.
 */
fun interface PoeTransport {
    fun post(endpoint: String, field: String, json: String, readTimeoutMs: Int): PoeHttpResult
}

/** [PoeTransport] over `HttpURLConnection`, gzip aware, UTF-8. Never throws. */
class HttpPoeTransport(
    private val baseUrl: String = PoeConfig.BASE_URL,
    private val userAgent: String = PoeConfig.USER_AGENT
) : PoeTransport {

    override fun post(endpoint: String, field: String, json: String, readTimeoutMs: Int): PoeHttpResult {
        var conn: HttpURLConnection? = null
        return try {
            conn = (URL(baseUrl + endpoint).openConnection() as HttpURLConnection).apply {
                requestMethod = "POST"
                doOutput = true
                connectTimeout = PoeConfig.CONNECT_TIMEOUT_MS
                readTimeout = readTimeoutMs
                instanceFollowRedirects = true
                setRequestProperty("Content-Type", "application/x-www-form-urlencoded; charset=UTF-8")
                setRequestProperty("Accept-Encoding", "gzip")
                setRequestProperty("User-Agent", userAgent)
            }
            val form = field + "=" + URLEncoder.encode(json, "UTF-8")
            conn.outputStream.use { it.write(form.toByteArray(Charsets.UTF_8)) }
            val code = conn.responseCode
            if (code !in 200..299) return PoeHttpResult.Failed("http_$code")
            val raw: InputStream = conn.inputStream
            val stream = if (conn.contentEncoding.equals("gzip", ignoreCase = true)) GZIPInputStream(raw) else raw
            PoeHttpResult.Ok(stream.use { it.readBytes().toString(Charsets.UTF_8) })
        } catch (e: IOException) {
            PoeHttpResult.Failed("network")
        } catch (e: RuntimeException) {
            PoeHttpResult.Failed("network")
        } finally {
            conn?.disconnect()
        }
    }
}
