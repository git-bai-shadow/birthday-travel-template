<?php
/* ==========================================================================
   upload.php · 照片上传
   单张串行上传（前端每张一个请求），这样完全绕开 PHP post_max_size 的限制，
   单张失败也不影响其他张，还能单独重试。

   安全要点：
     1. 用 finfo 检测真实 MIME，绝不信任 $_FILES['type'] 和扩展名
     2. 文件名完全随机，杜绝路径遍历
     3. 白名单只允许 jpeg / png / webp
     4. 体积上限
   ========================================================================== */

require __DIR__ . '/_boot.php';

same_origin_only();
require_same_site_fetch();

if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
    fail('只接受 POST', 405);
}

require_auth();
require_csrf();
rate_limit('upload', (int) cfg()['max_uploads_hour']);

$maxBytes = ((int) cfg()['max_file_mb']) * 1024 * 1024;

$allowed = [
    'image/jpeg' => 'jpg',
    'image/png'  => 'png',
    'image/webp' => 'webp',
];

$dir = uploads_dir();
if (!is_dir($dir) && !@mkdir($dir, 0755, true)) {
    fail('上传目录不存在且无法创建', 500);
}
if (!is_writable($dir)) {
    fail('上传目录不可写，请把 uploads 权限设为 755 或 775', 500);
}

$result = [];

/* 缩略图那一步失败时，整图已经 move_uploaded_file 落盘了。
   而 fail() 会直接 exit，来不及清理 —— 结果就是一张没人引用的孤儿文件，
   在共享主机上慢慢把空间吃光。
   注册一个 shutdown 钩子兜底：只有"确实成功回报了"之外的情况才删。

   ⚠️ 判据不能是 `empty($result['thumb'])` —— thumb 缺省时第 60 行是continue
   跳过，那个键**从不被赋值** → 恒为空 → 整图被删掉，而 json_out 已经
   把 uploads/xxx.webp 的 URL 返回给前端了（200 + 必然 404）。
   用一个显式的成功标志。 */
$uploadedPaths = [];
$done = false;
register_shutdown_function(function () use (&$uploadedPaths, &$done) {
    if (!$done) {
        foreach ($uploadedPaths as $p) {
            if (is_file($p)) {
                @unlink($p);
            }
        }
    }
});

foreach (['full', 'thumb'] as $field) {
    if (!isset($_FILES[$field]) || !is_array($_FILES[$field])) {
        if ($field === 'full') {
            fail('没有收到文件');
        }
        continue;
    }

    $f = $_FILES[$field];
    if (($f['error'] ?? UPLOAD_ERR_NO_FILE) !== UPLOAD_ERR_OK) {
        fail(upload_error_text((int) $f['error']), 400);
    }
    if (($f['size'] ?? 0) <= 0) {
        fail('文件是空的', 400);
    }
    if (($f['size'] ?? 0) > $maxBytes) {
        fail('文件超过 ' . cfg()['max_file_mb'] . 'MB', 413);
    }
    if (!is_uploaded_file($f['tmp_name'])) {
        fail('非法的上传', 400);
    }

    // 真实类型以文件内容为准
    $mime = '';
    if (class_exists('finfo')) {
        $fi = new finfo(FILEINFO_MIME_TYPE);
        $mime = (string) $fi->file($f['tmp_name']);
    } else {
        $info = @getimagesize($f['tmp_name']);
        $mime = $info['mime'] ?? '';
    }

    if (!isset($allowed[$mime])) {
        fail('只支持 JPEG / PNG / WebP，收到的是 ' . ($mime ?: '未知类型'), 415);
    }

    // 再验一次真的能当图片解析
    if (@getimagesize($f['tmp_name']) === false) {
        fail('文件不是有效的图片', 415);
    }

    $ext = $allowed[$mime];
    $name = uid16() . ($field === 'thumb' ? '_t' : '') . '.' . $ext;
    $dest = $dir . '/' . $name;

    if (!@move_uploaded_file($f['tmp_name'], $dest)) {
        fail('写入失败', 500);
    }
    @chmod($dest, 0644);
    $uploadedPaths[] = $dest;

    $result[$field] = uploads_url() . '/' . $name;
}

if (empty($result['full'])) {
    fail('上传没有完成');
}

$done = true;   // json_out 会 exit —— 先把"成功"记下来，shutdown 才不会误删

json_out([
    'ok'    => true,
    'full'  => $result['full'],
    'thumb' => $result['thumb'] ?? $result['full'],
]);

function upload_error_text(int $code): string
{
    switch ($code) {
        case UPLOAD_ERR_INI_SIZE:
        case UPLOAD_ERR_FORM_SIZE:
            return '文件太大，超过了服务器允许的上限';
        case UPLOAD_ERR_PARTIAL:
            return '上传中断了，重试一次';
        case UPLOAD_ERR_NO_FILE:
            return '没有选择文件';
        case UPLOAD_ERR_NO_TMP_DIR:
        case UPLOAD_ERR_CANT_WRITE:
            return '服务器临时目录不可用';
        case UPLOAD_ERR_EXTENSION:
            return '上传被服务器扩展拦截';
        default:
            return '上传失败';
    }
}
