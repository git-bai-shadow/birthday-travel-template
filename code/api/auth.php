<?php
/* ==========================================================================
   auth.php · 口令登录
   POST { password: "..." }
   校验通过后下发 session，之后写操作都靠它。
   口令哈希存在 config.php 里，口令本身不写进任何前端代码。

   ⚠️ 部署前置条件：PHP ≥ 7.4（用了箭头函数 / session 数组形式 /
   数组解构）。低于 7.4 会**解析错误 → 四个接口全部 500 空白**，
   而 display_errors=0 让页面完全无提示。InfinityFree 默认可能是 7.0/7.2，
   请先在控制面板把站点 PHP 版本切到 7.4 或 8.x。
   ========================================================================== */

require __DIR__ . '/_boot.php';

same_origin_only();
require_same_site_fetch();
boot_session();

$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';

/* 查询当前登录状态。顺带把 CSRF token 发下去 —— 前端首次写操作前
   需要它，而登录状态查询是天然的取token 时机（她打开编辑器就会打这个接口）。 */
if ($method === 'GET') {
    json_out([
        'ok'     => true,
        'authed' => is_authed(),
        'csrf'   => csrf_token(),
    ]);
}

if ($method !== 'POST') {
    fail('不支持的方法', 405);
}

rate_limit('auth', 30);

$body = body_json();
$password = (string) ($body['password'] ?? '');

if ($password === '') {
    fail('请输入口令');
}

$hash = (string) (cfg()['password_hash'] ?? '');

/* ⚠️ 两种失败必须**完全一样**：文案、状态码、延迟。
   原来「哈希为空」返回 500 且文案独特（"请先在 api/config.php 里填入
   password_hash"），与 401 的"口令不对"区分开 —— 攻击者据此能判断
   配置状态和文件路径命名。而 usleep(400000) 只在失败分支执行、成功路径
   无延迟 → 响应时间差同样能区分"哈希为空"和"口令错误"。 */
$ok = ($hash !== '' && $password !== '' && password_verify($password, $hash));

// 无条件延迟，不因成功/失败而异
usleep(400000);

if (!$ok) {
    fail('口令不对', 401);
}

session_regenerate_id(true);
$_SESSION['ok'] = true;
/* session_regenerate_id 会换 session id，csrf 必须重新种，
   否则客户端手上的 token 与新 session 里的对不上（登录后第一次写操作 403）。 */
$_SESSION['csrf'] = bin2hex(random_bytes(16));

json_out([
    'ok'     => true,
    'authed' => true,
    'csrf'   => $_SESSION['csrf'],
]);
