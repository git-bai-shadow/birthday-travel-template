<?php
/* ==========================================================================
   _boot.php · 公共引导：配置、JSON 读写、鉴权、限流
   不要直接访问这个文件。
   ========================================================================== */

declare(strict_types=1);

if (basename($_SERVER['SCRIPT_FILENAME'] ?? '') === '_boot.php') {
    http_response_code(404);
    exit;
}

/* 关掉错误回显，避免把路径泄露出去；错误写日志 */
ini_set('display_errors', '0');
ini_set('log_errors', '1');

function cfg(): array
{
    static $c = null;
    if ($c === null) {
        $path = __DIR__ . '/config.php';
        if (!is_file($path)) {
            fail('缺少 api/config.php，请先按 README 创建', 500);
        }
        $c = require $path;
    }
    return $c;
}

/* --------------------------------------------------------------------------
   输出
   -------------------------------------------------------------------------- */

function json_out($data, int $code = 200): void
{
    http_response_code($code);
    header('Content-Type: application/json; charset=utf-8');
    header('X-Content-Type-Options: nosniff');
    /* 根.htaccess 的 <IfModule mod_headers.c> 在未装该模块的共享主机上
       会**整段静默跳过**，那时连nosniff 都没有。在 PHP 里补一份无条件版本。 */
    header('X-Frame-Options: SAMEORIGIN');
    header('Referrer-Policy: same-origin');
    /* 私密内容（行程、照片、坐标、备注）不要被共享代理或浏览器长期缓存 */
    header('Cache-Control: no-store, private');
    echo json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

function fail(string $msg, int $code = 400): void
{
    json_out(['ok' => false, 'message' => $msg], $code);
}

/* --------------------------------------------------------------------------
   强制 HTTPS
   放在这里而不是 .htaccess 里，见 code/.htaccess 末尾的说明。
   默认关闭；probe.php 里有一项会告诉你什么时候可以开。
   -------------------------------------------------------------------------- */

function is_https(): bool
{
    return (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off')
        || (($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '') === 'https');
}

function enforce_https(): void
{
    if (empty(cfg()['force_https']) || is_https()) {
        return;
    }
    fail('这个站点只接受 https 访问', 403);
}

function body_json(): array
{
    $raw = file_get_contents('php://input');
    if ($raw === false || $raw === '') {
        return [];
    }
    $d = json_decode($raw, true);
    return is_array($d) ? $d : [];
}

/* --------------------------------------------------------------------------
   同源检查：拒绝跨站调用，防止接口被别处刷
   -------------------------------------------------------------------------- */

function same_origin_only(): void
{
    $origin = $_SERVER['HTTP_ORIGIN'] ?? '';
    if ($origin === '') {
        /* Origin 缺失时不放行写操作。
           原来这里是直接 return —— 靠 SameSite=Lax 兜底，但 Lax 只对
           top-level 导航的 GET 有确定语义，一旦站点以后加任何 GET 副作用
           的写接口就挡不住。而 `Origin: null`（sandboxed iframe、某些跨站
           重定向）走parse_url 拿到 null，下面那个 if 也一样不成立 → 无条件放行。 */
        if (!in_array($_SERVER['REQUEST_METHOD'] ?? 'GET', ['GET', 'HEAD', 'OPTIONS'], true)) {
            fail('拒绝缺少 Origin 的写请求', 403);
        }
        return;
    }
    $host = $_SERVER['HTTP_HOST'] ?? '';
    $o = parse_url($origin, PHP_URL_HOST);
    $h = $host ? explode(':', $host)[0] : '';
    if (!$o || !$h || strcasecmp($o, $h) !== 0) {
        fail('拒绝跨站请求', 403);
    }
}

/* --------------------------------------------------------------------------
   Sec-Fetch-Site：比 Origin 更难伪造的同源信号。
   浏览器一定发这个头，curl/脚本发不出来 —— 但不是所有客户端都发，
   所以只把它当「有则从严」的加分项，不当唯一防线。
   -------------------------------------------------------------------------- */

function require_same_site_fetch(): void
{
    $site = $_SERVER['HTTP_SEC_FETCH_SITE'] ?? '';
    if ($site === '') {
        return;   // 老浏览器/非浏览器客户端：跳过，靠 Origin + SameSite
    }
    if (!in_array($site, ['same-origin', 'none'], true)) {
        fail('拒绝跨站请求', 403);
    }
}

/* --------------------------------------------------------------------------
   数据文件：写入用临时文件 + rename，保证原子性；读用共享锁
   -------------------------------------------------------------------------- */

function data_dir(): string
{
    return rtrim(cfg()['data_dir'], '/\\');
}

function data_file(): string
{
    return data_dir() . '/trips.json';
}

/* 🔴 读取失败时**抛异常**，绝不能返回"空数据"。
   原来 fopen 失败 / flock 失败 / JSON 损坏三种情况一律 return $empty，
   而 with_trips_lock 会拿这个空文档去改、再原子写回 —— 共享主机上
   flock 偶发失败或磁盘写满导致半截文件时，**一次保存就把全部行程
   换成 {"trips":[]}，且没有备份、不可恢复**。
   「文件不存在」是合法的空（第一次用），与「读不出来」必须区分开：
   前者返回空文档，后者抛异常让接口 500 —— 宁可这次保存失败，
   也不能拿一份空数据覆盖掉她所有的回忆。 */
function read_trips(): array
{
    $f = data_file();
    $empty = ['version' => 1, 'updatedAt' => time(), 'trips' => []];

    if (!is_file($f)) {
        return $empty;   // 还没建过库：合法空
    }

    $fp = @fopen($f, 'rb');
    if (!$fp) {
        throw new RuntimeException('打不开 ' . basename($f));
    }
    try {
        if (!flock($fp, LOCK_SH)) {
            throw new RuntimeException('读锁获取失败');
        }
        $raw = stream_get_contents($fp);
        flock($fp, LOCK_UN);
    } finally {
        fclose($fp);
    }

    if ($raw === false || $raw === '') {
        /* 文件存在却是空的：可能是写盘被打断的残留。
           尝试用 .bak 兜底，都没有才当损坏 —— 但无论如何不返回空文档。 */
        $d = read_trips_backup();
        if ($d !== null) {
            return $d;
        }
        throw new RuntimeException(basename($f) . ' 是空文件且没有可用备份');
    }

    $d = json_decode($raw, true);
    if (!is_array($d) || !isset($d['trips']) || !is_array($d['trips'])) {
        $d = read_trips_backup();
        if ($d !== null) {
            return $d;
        }
        throw new RuntimeException(basename($f) . ' 内容已损坏且没有可用备份');
    }
    return $d;
}

/** 读 .bak；没有或也坏则返回 null */
function read_trips_backup(): ?array
{
    $f = data_file() . '.bak';
    if (!is_file($f)) {
        return null;
    }
    $raw = @file_get_contents($f);
    if ($raw === false || $raw === '') {
        return null;
    }
    $d = json_decode($raw, true);
    return (is_array($d) && isset($d['trips']) && is_array($d['trips'])) ? $d : null;
}

function write_trips(array $doc): bool
{
    $dir = data_dir();
    if (!is_dir($dir) && !@mkdir($dir, 0755, true)) {
        return false;
    }

    $doc['version'] = $doc['version'] ?? 1;
    $doc['updatedAt'] = time();

    $json = json_encode(
        $doc,
        JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_PRETTY_PRINT
    );
    if ($json === false) {
        return false;
    }

    /* 临时文件必须带唯一后缀。
       原来固定叫 trips.json.tmp：两个请求同时写时，B 会覆盖 A 的临时文件，
       A 先把 B 的半成品 rename 成正式文件，B 再 rename 就失败了 ——
       结果是丢数据加 500。 */
    $tmp = data_file() . '.' . getmypid() . '.' . bin2hex(random_bytes(4)) . '.tmp';

    if (@file_put_contents($tmp, $json, LOCK_EX) === false) {
        @unlink($tmp);
        return false;
    }
    /* 覆盖前先把上一份留成 .bak —— read_trips() 在主文件损坏/为空时会用它兜底。
       共享主机的磁盘随时可能出问题，这份备份是全部行程唯一的退路。 */
    $live = data_file();
    if (is_file($live)) {
        $bak = $live . '.bak';
        $oldRaw = @file_get_contents($live);
        if ($oldRaw !== false && $oldRaw !== '') {
            @file_put_contents($bak, $oldRaw, LOCK_EX);
        }
    }

    if (!@rename($tmp, data_file())) {
        @unlink($tmp);
        return false;
    }
    return true;
}

/* --------------------------------------------------------------------------
   会话与鉴权
   -------------------------------------------------------------------------- */

function boot_session(): void
{
    if (session_status() === PHP_SESSION_ACTIVE) {
        return;
    }
    /* ⚠️ secure 的判定原来只信 is_https()（依赖 $_SERVER['HTTPS'] 或
       X-Forwarded-Proto）。在反代终止的环境里这两个常常都拿不到 →
       cookie 被判成非安全 → **登录口令与30 天 session 明文过网**，
       同一 WiFi 上被动监听就能接管会话进而改数据、传文件。
       InfinityFree 默认提供免费 SSL，实际部署大概率跑 HTTPS，
       所以 config 里的 force_https 应该部署即 true（见 config.example.php）。
       这里再加一层兜底：只要请求本身是 https 就标 secure。 */
    $https = is_https() || !empty(cfg()['force_https']);

    @session_set_cookie_params([
        'lifetime' => 60 * 60 * 24 * 30,
        'path'     => '/',
        'httponly' => true,
        'samesite' => 'Lax',
        'secure'   => $https,
    ]);
    @session_start();
}

/* --------------------------------------------------------------------------
   CSRF token：真正写操作的防线。
   Origin / Sec-Fetch-Site 都是「请求头」，而 SameSite=Lax 对
   top-level GET 之外的判定在各家浏览器上并不一致。这里给一份
   真正的不可猜 token：登录时种进session，客户端放自定义头带回来。
   -------------------------------------------------------------------------- */

function csrf_token(): string
{
    boot_session();
    if (empty($_SESSION['csrf']) || !is_string($_SESSION['csrf'])) {
        $_SESSION['csrf'] = bin2hex(random_bytes(16));
    }
    return $_SESSION['csrf'];
}

function require_csrf(): void
{
    boot_session();
    $sent = $_SERVER['HTTP_X_CSRF_TOKEN'] ?? '';
    $have = $_SESSION['csrf'] ?? '';
    /* hash_equals 防时序侧信道 */
    if (!is_string($sent) || $sent === '' || !is_string($have) || $have === ''
        || !hash_equals($have, $sent)) {
        fail('请求校验失败，请刷新页面重试', 403);
    }
}

function is_authed(): bool
{
    boot_session();
    return !empty($_SESSION['ok']);
}

function require_auth(): void
{
    if (!is_authed()) {
        fail('需要口令', 401);
    }
}

/* --------------------------------------------------------------------------
   简易限流：同一 IP 每小时最多 N 次
   -------------------------------------------------------------------------- */

function rate_limit(string $bucket, int $maxPerHour): void
{
    $dir = data_dir() . '/rl';
    if (!is_dir($dir)) {
        @mkdir($dir, 0755, true);
    }
    if (!is_dir($dir) || !is_writable($dir)) {
        /* 限流不可用时不能默默全放行 —— 那等于限流形同虚设，
           而日志里一个字都看不到。只记一行，至少能事后发现。 */
        error_log('[rate_limit] data/rl 不可写，限流被跳过: bucket=' . $bucket);
        return;
    }

    $ip = $_SERVER['REMOTE_ADDR'] ?? 'unknown';
    $key = preg_replace('/[^a-zA-Z0-9_]/', '_', $bucket . '_' . $ip);
    $file = $dir . '/' . $key . '.json';
    $now = time();

    /* ⚠️ 整个读-改-写必须在同一个 flock 里。原来是先读、再判断、再写，
       同一 IP 的 20 个并发请求会全部读到旧计数、一起通过 —— 30 次/小时
       的上限实际能放大好几倍。 */
    $fh = @fopen($file, 'c+');
    if ($fh === false) {
        error_log('[rate_limit] 无法打开计数文件: ' . $file);
        return;
    }

    try {
        if (!flock($fh, LOCK_EX)) {
            error_log('[rate_limit] flock 失败: ' . $file);
            return;
        }

        $stamps = [];
        $raw = stream_get_contents($fh);
        if ($raw !== false && $raw !== '') {
            $j = json_decode($raw, true);
            if (is_array($j) && isset($j['t']) && is_array($j['t'])) {
                $stamps = $j['t'];
            }
        }
        $stamps = array_values(array_filter($stamps, static fn($t) => is_numeric($t) && $t > $now - 3600));

        if (count($stamps) >= $maxPerHour) {
            flock($fh, LOCK_UN);
            fclose($fh);
            fail('操作太频繁，等一会儿再试', 429);
        }

        $stamps[] = $now;
        ftruncate($fh, 0);
        rewind($fh);
        fwrite($fh, (string) json_encode(['t' => $stamps]));
        fflush($fh);
        flock($fh, LOCK_UN);
    } finally {
        fclose($fh);
    }

    /* 每个 IP 一个文件、且从不清理 —— 独立 IP 一多（IPv6 可以轻松换地址），
       data/rl/ 会把共享主机的 inode 配额耗光。
       这里用 1/N 的概率顺手扫一遍，删掉一天没动过的计数文件。 */
    if (random_int(1, 50) === 1) {
        foreach ((array) @glob($dir . '/*.json') as $old) {
            if (@filemtime($old) < $now - 86400) {
                @unlink($old);
            }
        }
    }
}

/** 读一个合法范围内的坐标，非法一律返回 null。
    原来只做 is_numeric 就 (float) 存下 —— `lat: 999`、`lat: 1e308`
    都能写进 trips.json 并进入前端的 mapPoints() 与getStats() 的累计里程。
    图虽不会崩（mapview 会把中心夹回 CHINA_BOX），但会得到一条永远画不出来的
    幽灵行程，还污染公里数。 */
function coord($v, float $limit): ?float
{
    if (!is_numeric($v)) {
        return null;
    }
    $f = (float) $v;
    if (!is_finite($f) || $f < -$limit || $f > $limit) {
        return null;
    }
    return $f;
}

/** 杂项 */

function with_trips_lock(callable $fn)
{
    $dir = data_dir();
    if (!is_dir($dir) && !@mkdir($dir, 0755, true)) {
        return null;
    }

    /* 独立的锁文件提供互斥；
       数据文件本身仍走「临时文件 + rename」的原子替换，两者互不削弱。 */
    $lockFp = @fopen($dir . '/trips.lock', 'c');
    if (!$lockFp) {
        return null;
    }

    try {
        if (!flock($lockFp, LOCK_EX)) {
            return null;
        }

        /* read_trips() 现在会在"读不出来"时抛异常（见其注释）。
           这里必须接住并返回 null → 调用方报500，**绝不能**继续走
           $fn(空文档) 那条路去覆盖正式文件。 */
        try {
            $doc = read_trips();
        } catch (RuntimeException $e) {
            error_log('[trips] 读取失败，已中止本次写入: ' . $e->getMessage());
            return null;
        }

        $out = $fn($doc);

        if (!is_array($out) || !isset($out['doc']) || !is_array($out['doc'])) {
            return null;
        }

        /* skipWrite => 这次没改文档（比如"没找到要删的那条"），就不动文件。
           整个 $out 都交还给调用方，由它决定怎么回给前端。 */
        if (empty($out['skipWrite']) && !write_trips($out['doc'])) {
            return null;
        }

        return $out;
    } finally {
        if (is_resource($lockFp)) {
            flock($lockFp, LOCK_UN);
            fclose($lockFp);
        }
    }
}

function uid16(): string
{
    return bin2hex(random_bytes(8));
}

function uploads_dir(): string
{
    return rtrim(cfg()['uploads_dir'], '/\\');
}

function uploads_url(): string
{
    return rtrim(cfg()['uploads_url'] ?? '../uploads', '/');
}

function clean_text(?string $s, int $max = 500): string
{
    $s = (string) $s;
    $s = str_replace(["\r\n", "\r"], "\n", $s);

    /* 带 /u 的正则在遇到非法 UTF-8 时会返回 null，
       原来的 `?? ''` 会让整个字段静默变成空串 —— 用户的文字就这么没了。
       这里退回不带 /u 的版本，至少只去掉控制字符。 */
    $clean = preg_replace('/[\x00-\x08\x0B\x0C\x0E-\x1F]/u', '', $s);
    if ($clean === null) {
        $clean = preg_replace('/[\x00-\x08\x0B\x0C\x0E-\x1F]/', '', $s) ?? $s;
    }
    $s = $clean;

    if (function_exists('mb_substr')) {
        return mb_substr(trim($s), 0, $max, 'UTF-8');
    }
    return substr(trim($s), 0, $max);
}

/**
 * 图片地址白名单。
 * 允许：http(s) 绝对地址、站内绝对路径 /xxx、相对路径 uploads/xxx
 * 目的：挡掉 javascript: data: 这类会被当成脚本执行的值，并禁止路径跳跃。
 */
function clean_image_url(?string $s): string
{
    $s = trim((string) $s);
    if ($s === '' || strlen($s) > 300) {
        return '';
    }

    // 明确挡掉会执行脚本的协议
    if (preg_match('#^(javascript|data|vbscript|file)\s*:#i', $s) === 1) {
        return '';
    }

    // 只接受这几种形态
    if (preg_match('#^(https?://|/|[a-z0-9_\-\.]+/)#i', $s) !== 1) {
        return '';
    }

    // 不允许路径跳跃
    if (strpos($s, '..') !== false) {
        return '';
    }

    return preg_replace('/[\x00-\x1F"\'<>]/', '', $s) ?? '';
}

/* --------------------------------------------------------------------------
   引导收尾
   所有函数都已定义完毕，这里统一执行一次全局检查。
   每个接口都 require 本文件，所以放这里等于对所有入口生效。
   -------------------------------------------------------------------------- */

enforce_https();
