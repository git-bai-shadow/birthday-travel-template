<?php
/* ==========================================================================
   trips.php
     GET    /api/trips.php         读取全部（不需要口令，否则她打不开）
     POST   /api/trips.php         新增或更新一条（需要口令）
     DELETE /api/trips.php?id=xxx  删除一条（需要口令）
   ========================================================================== */

require __DIR__ . '/_boot.php';

same_origin_only();
require_same_site_fetch();

$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';

switch ($method) {

    /* ---------------------------------------------------------------- */
    case 'GET':
        /* read_trips() 在"读不出来"时抛异常（而不是返回空数据）——
           对 GET 来说这是好事：宁可 500 让她看到"后端暂时不可用"，
           也不能返回一份空列表让她以为全被清空了。 */
        try {
            $doc = read_trips();
        } catch (RuntimeException $e) {
            error_log('[trips] GET 读取失败: ' . $e->getMessage());
            fail('记录暂时读不出来，请稍后再试', 503);
        }
        json_out([
            'version'   => $doc['version'] ?? 1,
            'updatedAt' => $doc['updatedAt'] ?? 0,
            'trips'     => $doc['trips'] ?? [],
            /* 私密内容不要被共享代理/浏览器长期缓存 */
        ]);
        break;

    /* ---------------------------------------------------------------- */
    case 'POST':
        require_auth();
        require_csrf();       // Origin/SameSite 之外再加一道不可猜的 token
        rate_limit('write', (int) cfg()['max_writes_hour']);

        $body = body_json();
        $in = $body['trip'] ?? null;
        if (!is_array($in)) {
            fail('缺少 trip');
        }

        $incoming = sanitize_trip($in);
        if ($incoming['id'] === '') {
            $incoming['id'] = uid16();
        }

        /* 读、改、写必须在同一把锁里。
           建立时间也由服务端决定，不接受客户端随意改写。 */
        $out = with_trips_lock(function (array $doc) use ($incoming) {
            $trips = $doc['trips'] ?? [];
            $trip = $incoming;

            $found = false;
            foreach ($trips as $i => $t) {
                if (($t['id'] ?? '') === $trip['id']) {
                    $trip['createdAt'] = $t['createdAt'] ?? time();
                    $trips[$i] = $trip;
                    $found = true;
                    break;
                }
            }
            if (!$found) {
                $trip['createdAt'] = time();
                $trips[] = $trip;
            }

            $doc['trips'] = $trips;
            return ['doc' => $doc, 'reply' => ['ok' => true, 'trip' => $trip]];
        });

        if ($out === null) {
            fail('保存失败，可能是目录没有写权限', 500);
        }
        json_out($out['reply']);
        break;

    /* ---------------------------------------------------------------- */
    case 'DELETE':
        require_auth();
        require_csrf();
        rate_limit('write', (int) cfg()['max_writes_hour']);

        $id = (string) ($_GET['id'] ?? '');
        if ($id === '') {
            fail('缺少 id');
        }

        /* 删除也走同一把锁，否则「删 A」和「改 B」并发时会把 B 写丢。 */
        $out = with_trips_lock(function (array $doc) use ($id) {
            $trips = $doc['trips'] ?? [];
            $keep = [];
            $removed = null;

            foreach ($trips as $t) {
                if (($t['id'] ?? '') === $id) {
                    $removed = $t;
                } else {
                    $keep[] = $t;
                }
            }

            /* 没找到时不改文档 —— skipWrite 让外层跳过写盘，
               但失败原因照样能带回给前端。 */
            if ($removed === null) {
                return ['doc' => $doc, 'skipWrite' => true,
                        'reply' => ['fail' => ['没找到这一条', 404]]];
            }

            $doc['trips'] = $keep;
            return ['doc' => $doc, 'removed' => $removed,
                    'reply' => ['ok' => true]];
        });

        if ($out === null) {
            fail('删除失败，可能是目录没有写权限', 500);
        }
        if (isset($out['reply']['fail'])) {
            fail($out['reply']['fail'][0], $out['reply']['fail'][1]);
        }
        $removed = $out['removed'];

        // 顺带清掉关联的照片文件，避免孤儿文件把空间占满
        $files = [];
        foreach (($removed['spots'] ?? []) as $s) {
            foreach (($s['photos'] ?? []) as $p) {
                foreach (['full', 'thumb'] as $k) {
                    if (!empty($p[$k])) {
                        $files[] = $p[$k];
                    }
                }
            }
        }
        foreach (($removed['photos'] ?? []) as $p) {
            if (is_string($p)) {
                $files[] = $p;
            } elseif (is_array($p)) {
                foreach (['full', 'thumb'] as $k) {
                    if (!empty($p[$k])) {
                        $files[] = $p[$k];
                    }
                }
            }
        }

        $deleted = 0;
        foreach ($files as $rel) {
            $name = basename(parse_url($rel, PHP_URL_PATH) ?: $rel);
            if ($name === '' || strpos($name, '..') !== false) {
                continue;
            }
            $path = uploads_dir() . '/' . $name;
            if (is_file($path) && @unlink($path)) {
                $deleted++;
            }
        }

        json_out(['ok' => true, 'deletedFiles' => $deleted]);
        break;

    /* ---------------------------------------------------------------- */
    default:
        fail('不支持的方法', 405);
}

/* ==========================================================================
   规范化：只接受预期字段，长度截断，图片地址限定 http/https 或相对路径
   ========================================================================== */

function sanitize_trip(array $in): array
{
    $spots = [];
    if (isset($in['spots']) && is_array($in['spots'])) {
        foreach ($in['spots'] as $s) {
            if (!is_array($s)) {
                continue;
            }
            $photos = [];
            if (isset($s['photos']) && is_array($s['photos'])) {
                foreach ($s['photos'] as $p) {
                    $one = sanitize_photo($p);
                    if ($one !== null) {
                        $photos[] = $one;
                    }
                }
            }

            $spots[] = [
                'id'     => preg_replace('/[^A-Za-z0-9_-]/', '', clean_text($s['id'] ?? '', 32)) ?: uid16(),
                'name'   => clean_text($s['name'] ?? '', 60),
                'lat'    => coord($s['lat'] ?? null, 90.0),
                'lon'    => coord($s['lon'] ?? null, 180.0),
                'source' => in_array(($s['source'] ?? ''), ['amap', 'builtin', 'manual', 'exif'], true)
                                ? $s['source'] : 'manual',
                'photos' => $photos,
            ];
        }
    }

    $photos = [];
    if (isset($in['photos']) && is_array($in['photos'])) {
        foreach ($in['photos'] as $p) {
            $one = sanitize_photo($p);
            if ($one !== null) {
                $photos[] = $one;
            }
        }
    }

    $tags = [];
    if (isset($in['tags']) && is_array($in['tags'])) {
        foreach (array_slice($in['tags'], 0, 8) as $t) {
            $t = clean_text(is_string($t) ? $t : '', 16);
            if ($t !== '') {
                $tags[] = $t;
            }
        }
    }

    $date = clean_text($in['date'] ?? '', 10);
    if (preg_match('/^\d{4}-\d{2}-\d{2}$/', $date) !== 1) {
        $date = date('Y-m-d');
    }

    return [
        /* id 会进前端的选择器（timeline 的 [data-trip-id="..."]），
           clean_text 只剔控制字符、不拦 " ] 等选择器元字符。
           收紧成安全白名单，两端都受益。 */
        'id'        => preg_replace('/[^A-Za-z0-9_-]/', '', clean_text($in['id'] ?? '', 32)),
        'date'      => $date,
        'city'      => clean_text($in['city'] ?? '', 60),
        'country'   => clean_text($in['country'] ?? '', 40),
        'title'     => clean_text($in['title'] ?? '', 60),
        'note'      => clean_text($in['note'] ?? '', 400),
        'tags'      => $tags,
        'spots'     => $spots,
        'photos'    => $photos,
        'createdAt' => isset($in['createdAt']) && is_numeric($in['createdAt'])
                            ? (int) $in['createdAt'] : time(),
    ];
}

function sanitize_photo($p): ?array
{
    if (is_string($p)) {
        $url = clean_image_url($p);
        return $url === '' ? null : ['id' => uid16(), 'full' => $url, 'thumb' => $url];
    }
    if (!is_array($p)) {
        return null;
    }

    $full = clean_image_url($p['full'] ?? '');
    if ($full === '') {
        return null;
    }
    $thumb = clean_image_url($p['thumb'] ?? '') ?: $full;

    return [
        'id'    => preg_replace('/[^A-Za-z0-9_-]/', '', clean_text($p['id'] ?? '', 32)) ?: uid16(),
        'full'  => $full,
        'thumb' => $thumb,
        'w'     => isset($p['w']) && is_numeric($p['w']) ? (int) $p['w'] : 0,
        'h'     => isset($p['h']) && is_numeric($p['h']) ? (int) $p['h'] : 0,
    ];
}
