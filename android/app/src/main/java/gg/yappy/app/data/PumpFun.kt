package gg.yappy.app.data

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import okhttp3.OkHttpClient
import okhttp3.Request
import kotlin.math.abs

/**
 * Token charts for a pasted contract address.
 *
 * **Solana / pump.fun** — coin metadata on frontend-api-v3, OHLC on the
 * public swap API. Callouts stay off: they need a pump.fun session.
 *
 * **BNB / Robinhood** — 0x addresses try four.meme first (on-curve BNB
 * coins are not on DexScreener yet), then DexScreener. Robinhood Chain
 * launchpad coins are flap.sh (vanity suffix `7777`). Candles come from
 * CoinGecko when indexed; otherwise the card still shows the snapshot.
 *
 * @see <a href="https://github.com/BankkRoll/pumpfun-apis">BankkRoll/pumpfun-apis</a>
 */

private const val COIN_API = "https://frontend-api-v3.pump.fun"
private const val SWAP_API = "https://swap-api.pump.fun"
private const val DEX_API = "https://api.dexscreener.com/latest/dex"
private const val FOUR_API = "https://four.meme/meme-api/v1/private/token/get"
private const val GECKO_API = "https://api.coingecko.com/api/v3"
private const val UA = "yappy-android/1.0 (+https://yappy.gg)"

/** pump.fun graduates the curve at ~85 SOL of real reserves. */
private const val PUMP_BOND_SOL = 85.0

private val SOL_MINT = Regex("""\b[1-9A-HJ-NP-Za-km-z]{32,44}\b""")
private val EVM = Regex("""\b0x[a-fA-F0-9]{40}\b""")
private val PUMP_URL = Regex(
    """(?:https?://)?(?:www\.)?pump\.fun/(?:coin/)?([1-9A-HJ-NP-Za-km-z]{32,44})""",
    RegexOption.IGNORE_CASE,
)
private val FOUR_URL = Regex(
    """(?:https?://)?(?:www\.)?four\.meme/(?:token/)?(0x[a-fA-F0-9]{40})""",
    RegexOption.IGNORE_CASE,
)
private val FLAP_URL = Regex(
    """(?:https?://)?(?:www\.)?flap\.sh/(?:token/)?(0x[a-fA-F0-9]{40})""",
    RegexOption.IGNORE_CASE,
)

enum class PumpRange(val label: String, val interval: String, val limit: Int) {
    LIVE("LIVE", "1s", 60),
    H1("1H", "1m", 60),
    H4("4H", "5m", 48),
    D1("1D", "15m", 96),
    ALL("ALL", "1h", 120),
}

enum class TokenVenue(val label: String) {
    PUMP("pump.fun"),
    FOUR("four.meme"),
    FLAP("flap.sh"),
    DEX("DexScreener"),
}

data class PumpCandle(
    val timeMs: Long,
    val open: Double,
    val high: Double,
    val low: Double,
    val close: Double,
)

data class PumpSnapshot(
    val mint: String,
    val name: String,
    val symbol: String,
    val imageUrl: String?,
    val priceUsd: Double?,
    val marketCapUsd: Double,
    val changePct: Double?,
    val candles: List<PumpCandle>,
    val complete: Boolean,
    val flagged: Boolean,
    val venue: TokenVenue = TokenVenue.PUMP,
    val tradeUrl: String = "https://pump.fun/coin/$mint",
    /** 0..1 while still on a bonding curve; null once bonded or unknown. */
    val bondProgress: Float? = null,
)

fun isEvmAddress(value: String): Boolean = EVM.matches(value)

fun shortCa(value: String): String =
    if (value.length <= 12) value else "${value.take(6)}…${value.takeLast(4)}"

fun isTokenChartUrl(url: String?): Boolean {
    if (url.isNullOrBlank()) return false
    val u = url.lowercase()
    return u.contains("pump.fun") ||
        u.contains("four.meme") ||
        u.contains("flap.sh") ||
        u.contains("dexscreener.com")
}

fun isPumpFunUrl(url: String?): Boolean = isTokenChartUrl(url)

fun findPumpMints(message: Message): List<String> {
    val blob = buildString {
        message.content?.let { appendLine(it) }
        message.embeds.forEach { embed -> embed.url?.let { appendLine(it) } }
    }
    return findPumpMints(blob)
}

fun findPumpMints(text: String?): List<String> {
    if (text.isNullOrBlank()) return emptyList()
    val fromUrls =
        PUMP_URL.findAll(text).map { it.groupValues[1] } +
            FOUR_URL.findAll(text).map { it.groupValues[1] } +
            FLAP_URL.findAll(text).map { it.groupValues[1] }
    val evm = EVM.findAll(text).map { it.value }
    val sol = SOL_MINT.findAll(text).map { it.value }.filter { mint ->
        !mint.startsWith("0x", ignoreCase = true) &&
            mint.any { it.isUpperCase() } &&
            mint.any { it.isDigit() }
    }
    return (fromUrls + evm + sol).distinct().take(2).toList()
}

object PumpFun {
    private data class Key(val mint: String, val range: PumpRange)

    private data class Cached(val snap: PumpSnapshot, val at: Long)

    private val mutex = Mutex()
    private val cache = LinkedHashMap<Key, Cached>(32, 0.75f, true)
    private const val TTL_MS = 45_000L
    private const val LIVE_TTL_MS = 2_000L
    private const val MAX = 40

    suspend fun load(
        http: OkHttpClient,
        mint: String,
        range: PumpRange,
        fresh: Boolean = false,
    ): PumpSnapshot? {
        val key = Key(mint, range)
        val now = System.currentTimeMillis()
        val ttl = if (range == PumpRange.LIVE) LIVE_TTL_MS else TTL_MS
        if (!fresh) {
            mutex.withLock {
                cache[key]?.takeIf { now - it.at < ttl }?.let { return it.snap }
            }
        }

        val snap = if (isEvmAddress(mint)) fetchEvm(http, mint, range) else fetchPump(http, mint, range)
        snap ?: return null
        mutex.withLock {
            cache[key] = Cached(snap, now)
            while (cache.size > MAX) cache.remove(cache.keys.first())
        }
        return snap
    }

    private suspend fun fetchPump(
        http: OkHttpClient,
        mint: String,
        range: PumpRange,
    ): PumpSnapshot? = withContext(Dispatchers.IO) {
        coroutineScope {
            val coinJob = async { get<PumpCoinDto>(http, "$COIN_API/coins/$mint", origin = "https://pump.fun") }
            val candleJob = async {
                get<List<PumpCandleDto>>(
                    http,
                    "$SWAP_API/v1/coins/$mint/candles?interval=${range.interval}&limit=${range.limit}",
                    origin = "https://pump.fun",
                )
            }
            val coin = coinJob.await() ?: return@coroutineScope null
            val candles = candleJob.await().orEmpty().mapNotNull { it.toCandle() }.sortedBy { it.timeMs }
            val last = candles.lastOrNull()
            val first = candles.firstOrNull()
            val change = pct(first?.open, last?.close)
            val flagged = coin.nsfw || coin.isBanned
            val realSol = coin.realSolReserves / 1_000_000_000.0
            val bond = when {
                coin.complete -> null
                realSol <= 0.0 -> 0f
                else -> (realSol / PUMP_BOND_SOL).toFloat().coerceIn(0f, 1f)
            }
            PumpSnapshot(
                mint = coin.mint,
                name = coin.name?.trim().orEmpty().ifBlank { "Unknown" },
                symbol = coin.symbol?.trim().orEmpty(),
                imageUrl = coin.imageUri.takeUnless { flagged || it.isNullOrBlank() },
                priceUsd = last?.close,
                marketCapUsd = coin.usdMarketCap,
                changePct = change,
                candles = candles,
                complete = coin.complete,
                flagged = flagged,
                venue = TokenVenue.PUMP,
                tradeUrl = "https://pump.fun/coin/${coin.mint}",
                bondProgress = bond,
            )
        }
    }

    private suspend fun fetchEvm(
        http: OkHttpClient,
        address: String,
        range: PumpRange,
    ): PumpSnapshot? = withContext(Dispatchers.IO) {
        coroutineScope {
            val fourJob = async { get<FourWrapDto>(http, "$FOUR_API?address=$address") }
            val dexJob = async {
                get<DexPairsDto>(http, "$DEX_API/tokens/$address")
                    ?: get<DexPairsDto>(http, "$DEX_API/search?q=$address")
            }
            val four = fourJob.await()?.takeIf { it.code == 0 }?.data
            val pair = pickPair(dexJob.await(), address)

            if (four != null) {
                val bnbUsd = bnbUsd(http)
                val priceBnb = four.tokenPrice?.price?.toDoubleOrNull()
                val mcapBnb = four.tokenPrice?.marketCap?.toDoubleOrNull()
                val progress = four.tokenPrice?.progress?.toFloatOrNull()?.coerceIn(0f, 1f)
                val bonded = progress != null && progress >= 0.995f ||
                    four.status.equals("COMPLETED", ignoreCase = true)
                val change = four.tokenPrice?.increase?.toDoubleOrNull()?.let { raw ->
                    if (abs(raw) <= 1.0) raw * 100.0 else raw
                }
                val candles = evmCandles(http, address, pair?.chainId ?: "bsc", range)
                return@coroutineScope PumpSnapshot(
                    mint = four.address ?: address,
                    name = four.name?.trim().orEmpty().ifBlank { "Unknown" },
                    symbol = four.shortName?.trim().orEmpty(),
                    imageUrl = four.image,
                    priceUsd = priceBnb?.times(bnbUsd) ?: pair?.priceUsd?.toDoubleOrNull(),
                    marketCapUsd = mcapBnb?.times(bnbUsd) ?: pair?.marketCap ?: pair?.fdv ?: 0.0,
                    changePct = pairChange(pair, range) ?: change,
                    candles = candles,
                    complete = bonded,
                    flagged = false,
                    venue = TokenVenue.FOUR,
                    tradeUrl = "https://four.meme/token/$address",
                    bondProgress = progress.takeUnless { bonded },
                )
            }

            pair ?: return@coroutineScope null
            val chain = pair.chainId.orEmpty()
            val venue = when (chain) {
                "robinhood" -> TokenVenue.FLAP
                "bsc" -> TokenVenue.FOUR
                else -> TokenVenue.DEX
            }
            val tradeUrl = when (venue) {
                TokenVenue.FOUR -> "https://four.meme/token/$address"
                TokenVenue.FLAP -> "https://flap.sh/token/$address"
                else -> pair.url ?: "https://dexscreener.com/$chain/${pair.pairAddress.orEmpty()}"
            }
            val token = pair.baseToken
            PumpSnapshot(
                mint = address,
                name = token?.name?.trim().orEmpty().ifBlank { "Unknown" },
                symbol = token?.symbol?.trim().orEmpty(),
                imageUrl = pair.info?.imageUrl,
                priceUsd = pair.priceUsd?.toDoubleOrNull(),
                marketCapUsd = pair.marketCap ?: pair.fdv ?: 0.0,
                changePct = pairChange(pair, range),
                candles = evmCandles(http, address, chain, range),
                complete = true,
                flagged = false,
                venue = venue,
                tradeUrl = tradeUrl,
                bondProgress = null,
            )
        }
    }

    private fun pickPair(dex: DexPairsDto?, address: String): DexPairDto? {
        val want = address.lowercase()
        val pairs = dex?.pairs.orEmpty()
        return pairs
            .filter { it.baseToken?.address?.equals(want, ignoreCase = true) == true }
            .maxByOrNull { it.liquidity?.usd ?: 0.0 }
            ?: pairs.maxByOrNull { it.liquidity?.usd ?: 0.0 }
    }

    private fun pairChange(pair: DexPairDto?, range: PumpRange): Double? = when (range) {
        PumpRange.LIVE, PumpRange.H1 -> pair?.priceChange?.h1
        PumpRange.H4 -> pair?.priceChange?.h6
        PumpRange.D1, PumpRange.ALL -> pair?.priceChange?.h24
    }

    private fun evmCandles(
        http: OkHttpClient,
        address: String,
        chain: String,
        range: PumpRange,
    ): List<PumpCandle> {
        val platform = geckoPlatform(chain) ?: return emptyList()
        val days = if (range == PumpRange.ALL) "30" else "1"
        val gecko = get<GeckoChartDto>(
            http,
            "$GECKO_API/coins/$platform/contract/$address/market_chart?vs_currency=usd&days=$days",
        )
        return gecko?.prices.toCandles(range)
    }

    private fun bnbUsd(http: OkHttpClient): Double {
        val gecko = get<Map<String, Map<String, Double>>>(
            http,
            "$GECKO_API/simple/price?ids=binancecoin&vs_currencies=usd",
        )
        gecko?.get("binancecoin")?.get("usd")?.takeIf { it > 0 }?.let { return it }
        val wbnb = get<DexPairsDto>(
            http,
            "$DEX_API/tokens/0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c",
        )
        return wbnb?.pairs.orEmpty()
            .firstOrNull { it.chainId == "bsc" }
            ?.priceUsd
            ?.toDoubleOrNull()
            ?: 0.0
    }

    private inline fun <reified T> get(
        http: OkHttpClient,
        url: String,
        origin: String? = null,
    ): T? {
        val req = Request.Builder()
            .url(url)
            .header("Accept", "application/json")
            .header("User-Agent", UA)
            .apply { if (origin != null) header("Origin", origin) }
            .build()
        return try {
            http.newCall(req).execute().use { res ->
                if (!res.isSuccessful) return null
                val body = res.body?.string() ?: return null
                AppJson.decodeFromString<T>(body)
            }
        } catch (_: Exception) {
            null
        }
    }
}

private fun pct(open: Double?, close: Double?): Double? {
    if (open == null || close == null || open == 0.0) return null
    return (close - open) / open * 100.0
}

private fun geckoPlatform(chainId: String): String? = when (chainId) {
    "bsc" -> "binance-smart-chain"
    "ethereum" -> "ethereum"
    "base" -> "base"
    "arbitrum" -> "arbitrum-one"
    "polygon" -> "polygon-pos"
    else -> null
}

private fun List<List<Double>>?.toCandles(range: PumpRange): List<PumpCandle> {
    val pts = this?.mapNotNull { row ->
        val ts = row.getOrNull(0) ?: return@mapNotNull null
        val px = row.getOrNull(1) ?: return@mapNotNull null
        ts.toLong() to px
    }.orEmpty()
    if (pts.size < 2) return emptyList()
    val window = when (range) {
        PumpRange.LIVE, PumpRange.H1 -> pts.takeLast(12)
        PumpRange.H4 -> pts.takeLast(48)
        else -> pts
    }
    val buckets = maxOf(2, window.size / 40 + 1)
    return window.chunked(buckets).mapNotNull { chunk ->
        val first = chunk.firstOrNull() ?: return@mapNotNull null
        val last = chunk.last()
        PumpCandle(
            timeMs = first.first,
            open = first.second,
            high = chunk.maxOf { it.second },
            low = chunk.minOf { it.second },
            close = last.second,
        )
    }
}

@Serializable
private data class PumpCoinDto(
    val mint: String,
    val name: String? = null,
    val symbol: String? = null,
    @SerialName("image_uri") val imageUri: String? = null,
    @SerialName("usd_market_cap") val usdMarketCap: Double = 0.0,
    @SerialName("real_sol_reserves") val realSolReserves: Double = 0.0,
    val complete: Boolean = false,
    val nsfw: Boolean = false,
    @SerialName("is_banned") val isBanned: Boolean = false,
)

@Serializable
private data class PumpCandleDto(
    val timestamp: Long,
    val open: String,
    val high: String,
    val low: String,
    val close: String,
) {
    fun toCandle(): PumpCandle? {
        val o = open.toDoubleOrNull() ?: return null
        val h = high.toDoubleOrNull() ?: return null
        val l = low.toDoubleOrNull() ?: return null
        val c = close.toDoubleOrNull() ?: return null
        if (!o.isFinite() || !h.isFinite() || !l.isFinite() || !c.isFinite()) return null
        return PumpCandle(timestamp, o, h, l, c)
    }
}

@Serializable
private data class DexPairsDto(val pairs: List<DexPairDto> = emptyList())

@Serializable
private data class DexPairDto(
    val chainId: String? = null,
    val url: String? = null,
    val pairAddress: String? = null,
    val priceUsd: String? = null,
    val marketCap: Double? = null,
    val fdv: Double? = null,
    val priceChange: DexChangeDto? = null,
    val liquidity: DexLiqDto? = null,
    val baseToken: DexTokenDto? = null,
    val info: DexInfoDto? = null,
)

@Serializable
private data class DexChangeDto(
    val h1: Double? = null,
    val h6: Double? = null,
    val h24: Double? = null,
)

@Serializable
private data class DexLiqDto(val usd: Double? = null)

@Serializable
private data class DexTokenDto(
    val address: String? = null,
    val name: String? = null,
    val symbol: String? = null,
)

@Serializable
private data class DexInfoDto(val imageUrl: String? = null)

@Serializable
private data class GeckoChartDto(val prices: List<List<Double>> = emptyList())

@Serializable
private data class FourWrapDto(
    val code: Int = -1,
    val data: FourTokenDto? = null,
)

@Serializable
private data class FourTokenDto(
    val address: String? = null,
    val image: String? = null,
    val name: String? = null,
    val shortName: String? = null,
    val status: String? = null,
    val tokenPrice: FourPriceDto? = null,
)

@Serializable
private data class FourPriceDto(
    val price: String? = null,
    val marketCap: String? = null,
    val progress: String? = null,
    val increase: String? = null,
)
