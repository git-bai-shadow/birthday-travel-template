<?php
/* ==========================================================================
   geocode.php · 景区名 → 坐标
   服务端代理高德 Web 服务 API。key 藏在这里，不会出现在网页源码里。
   高德返回 GCJ-02，这里转成 WGS-84 再给前端，保证与 DataV 地图对得上。
   结果写本地缓存，同一地点第二次不再消耗额度。
   ========================================================================== */

require __DIR__ . '/_boot.php';

same_origin_only();

if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'GET') {
    fail('只接受 GET', 405);
}

/* ⚠️ 这个接口原来既没有 require_auth() 也没有 rate_limit()，是四个接口里
   唯一的例外（same_origin_only() 只在浏览器带 Origin 时生效，curl 直接绕过）。
   加上"空结果永不写缓存"（见文件末尾），匿名脚本循环请求一个查不到的词
   就能每次都实打实转发到高德 → 烧完免费 key 的日配额 → 站内所有地理编码
   彻底失效（编辑器"输入即查"全挂，只能退内置库的长尾地点）。
   这里不强制登录（浏览者可能只是搜地名），但必须限流。 */
rate_limit('geo', 120);

$q = clean_text($_GET['q'] ?? '', 40);
if ($q === '') {
    json_out([]);
}

$key = trim((string) (cfg()['amap_key'] ?? ''));

/* 没有配置 key：返回空数组，前端会自动退回内置地点库 */
if ($key === '') {
    json_out([]);
}

/* --------------------------------------------------------------------------
   缓存
   -------------------------------------------------------------------------- */

$cacheDir = data_dir() . '/cache';
if (!is_dir($cacheDir)) {
    @mkdir($cacheDir, 0755, true);
}
$cacheFile = $cacheDir . '/geo_' . md5($q) . '.json';

if (is_file($cacheFile) && (time() - (int) @filemtime($cacheFile)) < 86400 * 30) {
    $cached = json_decode((string) @file_get_contents($cacheFile), true);
    if (is_array($cached)) {
        json_out($cached);
    }
}

/* --------------------------------------------------------------------------
   请求高德：优先用「输入提示」，它的日配额远高于关键字搜索
   -------------------------------------------------------------------------- */

$url = 'https://restapi.amap.com/v3/assistant/inputtips'
     . '?key=' . urlencode($key)
     . '&keywords=' . urlencode($q)
     . '&datatype=poi'
     . '&citylimit=false';

$raw = http_get($url);
if ($raw === null) {
    // 出网被禁或超时，交给前端退回内置库
    json_out([]);
}

$data = json_decode($raw, true);
if (!is_array($data) || ($data['status'] ?? '0') !== '1' || !isset($data['tips'])) {
    json_out([]);
}

$out = [];
foreach ($data['tips'] as $tip) {
    if (!is_array($tip)) {
        continue;
    }
    $loc = $tip['location'] ?? '';
    if (!is_string($loc) || strpos($loc, ',') === false) {
        continue;
    }

    [$lngGcj, $latGcj] = array_map('floatval', explode(',', $loc, 2));
    if ($lngGcj == 0.0 && $latGcj == 0.0) {
        continue;
    }

    [$lng, $lat] = gcj02_to_wgs84($lngGcj, $latGcj);

    $name = clean_text($tip['name'] ?? '', 60);
    if ($name === '') {
        continue;
    }

    $district = $tip['district'] ?? '';
    $city = '';
    if (is_string($district) && $district !== '') {
        $city = clean_text($district, 40);
    } elseif (!empty($tip['city']) && is_string($tip['city'])) {
        $city = clean_text($tip['city'], 40);
    }

    $out[] = [
        'name'   => $name,
        'city'   => $city,
        'lat'    => round($lat, 6),
        'lon'    => round($lng, 6),
        'source' => 'amap',
    ];

    if (count($out) >= 8) {
        break;
    }
}

/* ⚠️ 空结果**也要**写缓存。原来是 `if ($out && ...)` —— 查不到的地方
   永远不落盘，于是同一个词会被反复转发到高德（正是被匿名脚本利用的入口）。
   写成 [] 后，上面 is_array($cached) 分支天然能命中，30 天内不再出网。 */
if (is_dir($cacheDir) && is_writable($cacheDir)) {
    @file_put_contents($cacheFile, json_encode($out, JSON_UNESCAPED_UNICODE), LOCK_EX);
}

json_out($out);

/* ==========================================================================
   工具
   ========================================================================== */

function http_get(string $url): ?string
{
    if (function_exists('curl_init')) {
        $ch = curl_init($url);
        curl_setopt_array($ch, [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT        => 8,
            CURLOPT_CONNECTTIMEOUT => 4,
            CURLOPT_SSL_VERIFYPEER => true,
            CURLOPT_FOLLOWLOCATION => false,
            CURLOPT_USERAGENT      => 'birthday-site/1.0',
        ]);
        $out = curl_exec($ch);
        $code = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
        curl_close($ch);
        if (is_string($out) && $code >= 200 && $code < 300) {
            return $out;
        }
        return null;
    }

    if (ini_get('allow_url_fopen')) {
        $ctx = stream_context_create([
            'http' => ['timeout' => 8, 'ignore_errors' => false],
            'ssl'  => ['verify_peer' => true, 'verify_peer_name' => true],
        ]);
        $out = @file_get_contents($url, false, $ctx);
        return is_string($out) ? $out : null;
    }

    return null;
}

/* --------------------------------------------------------------------------
   GCJ-02 → WGS-84（与前端 lib/gcj02.js 同一套算法）
   -------------------------------------------------------------------------- */

function gcj02_to_wgs84(float $lng, float $lat): array
{
    if (out_of_china($lng, $lat)) {
        return [$lng, $lat];
    }
    $wl = $lng;
    $wa = $lat;
    for ($i = 0; $i < 2; $i++) {
        [$dl, $da] = gcj_delta($wl, $wa);
        $wl = $lng - $dl;
        $wa = $lat - $da;
    }
    return [$wl, $wa];
}

function out_of_china(float $lng, float $lat): bool
{
    return !($lng > 73.66 && $lng < 135.05 && $lat > 3.86 && $lat < 53.55);
}

function gcj_delta(float $lng, float $lat): array
{
    $a  = 6378245.0;
    $ee = 0.00669342162296594323;

    $dl = transform_lat($lng - 105.0, $lat - 35.0);
    $dn = transform_lng($lng - 105.0, $lat - 35.0);

    $radLat = $lat / 180.0 * M_PI;
    $magic = sin($radLat);
    $magic = 1 - $ee * $magic * $magic;
    $sq = sqrt($magic);

    $dLat = ($dl * 180.0) / (($a * (1 - $ee)) / ($magic * $sq) * M_PI);
    $dLng = ($dn * 180.0) / ($a / $sq * cos($radLat) * M_PI);

    return [$dLng, $dLat];
}

function transform_lat(float $x, float $y): float
{
    $ret = -100.0 + 2.0 * $x + 3.0 * $y + 0.2 * $y * $y + 0.1 * $x * $y
         + 0.2 * sqrt(abs($x));
    $ret += (20.0 * sin(6.0 * $x * M_PI) + 20.0 * sin(2.0 * $x * M_PI)) * 2.0 / 3.0;
    $ret += (20.0 * sin($y * M_PI) + 40.0 * sin($y / 3.0 * M_PI)) * 2.0 / 3.0;
    $ret += (160.0 * sin($y / 12.0 * M_PI) + 320 * sin($y * M_PI / 30.0)) * 2.0 / 3.0;
    return $ret;
}

function transform_lng(float $x, float $y): float
{
    $ret = 300.0 + $x + 2.0 * $y + 0.1 * $x * $x + 0.1 * $x * $y
         + 0.1 * sqrt(abs($x));
    $ret += (20.0 * sin(6.0 * $x * M_PI) + 20.0 * sin(2.0 * $x * M_PI)) * 2.0 / 3.0;
    $ret += (20.0 * sin($x * M_PI) + 40.0 * sin($x / 3.0 * M_PI)) * 2.0 / 3.0;
    $ret += (150.0 * sin($x / 12.0 * M_PI) + 300.0 * sin($x / 30.0 * M_PI)) * 2.0 / 3.0;
    return $ret;
}
