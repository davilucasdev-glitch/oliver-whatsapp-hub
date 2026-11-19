<?php
/**
 * Recebe os avisos do Oliver Hub (configure esta URL em Integração com o site → Avisos para o site).
 * Eventos: message.received (mensagem/comprovante), message.status (enviada/entregue/lida/falhou),
 * contact.opt_out (pediu para sair).
 *
 * Segurança: só aceita POST com a assinatura certa (X-Oliver-Signature = sha256=HMAC do corpo).
 * O que fazer com cada aviso fica na função oliver_hub_evento() do oliver-hub-config.php; se não
 * existir, este arquivo grava em hub-dados/ (opt-outs e últimos eventos) para o painel consultar.
 */

// no site da Oliver: bling.php carrega a configuração (pasta privada fora do public_html)
if (is_file(__DIR__ . '/bling.php')) {
    require __DIR__ . '/bling.php';
}
require_once __DIR__ . '/oliver-hub.php';

header('Content-Type: application/json; charset=utf-8');

if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
    http_response_code(405);
    echo json_encode(['error' => 'use POST']);
    exit;
}
if (!defined('OLIVER_HUB_WEBHOOK_SECRET') || OLIVER_HUB_WEBHOOK_SECRET === '') {
    http_response_code(503);
    echo json_encode(['error' => 'segredo não configurado']);
    exit;
}

$corpo = file_get_contents('php://input');
$assinatura = $_SERVER['HTTP_X_OLIVER_SIGNATURE'] ?? '';
$esperada = 'sha256=' . hash_hmac('sha256', $corpo, OLIVER_HUB_WEBHOOK_SECRET);
if (!hash_equals($esperada, $assinatura)) {
    http_response_code(401);
    echo json_encode(['error' => 'assinatura inválida']);
    exit;
}

$aviso = json_decode($corpo, true);
if (!is_array($aviso) || empty($aviso['event'])) {
    http_response_code(400);
    echo json_encode(['error' => 'corpo inválido']);
    exit;
}
$evento = (string) $aviso['event'];
$dados = is_array($aviso['data'] ?? null) ? $aviso['data'] : [];

try {
    if (function_exists('oliver_hub_evento')) {
        oliver_hub_evento($evento, $dados);
    } else {
        hub_webhook_padrao($evento, $dados, (string) ($aviso['at'] ?? date('c')));
    }
} catch (Throwable $e) {
    // 500 faz o hub tentar de novo depois
    http_response_code(500);
    echo json_encode(['error' => 'falha ao processar']);
    error_log('[oliver-hub] ' . $e->getMessage());
    exit;
}

echo json_encode(['ok' => true]);

/** Padrão: guarda opt-outs (o painel consulta antes de mandar) e os últimos 500 eventos. */
function hub_webhook_padrao(string $evento, array $dados, string $quando): void
{
    $dir = defined('OLIVER_HUB_DADOS_DIR') ? OLIVER_HUB_DADOS_DIR : (defined('DADOS') ? DADOS . '/hub' : __DIR__ . '/hub-dados');
    if (!is_dir($dir)) {
        mkdir($dir, 0750, true);
        // não deixa a pasta ser lida pela web (Apache/Hostinger)
        file_put_contents($dir . '/.htaccess', "Require all denied\nDeny from all\n");
    }
    $arquivoEventos = $dir . '/eventos.json';
    $lista = is_file($arquivoEventos) ? (json_decode((string) file_get_contents($arquivoEventos), true) ?: []) : [];
    array_unshift($lista, ['event' => $evento, 'at' => $quando, 'data' => $dados]);
    file_put_contents($arquivoEventos, json_encode(array_slice($lista, 0, 500), JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT), LOCK_EX);

    if ($evento === 'contact.opt_out' && !empty($dados['phone'])) {
        $arquivoSaidas = $dir . '/opt-outs.json';
        $saidas = is_file($arquivoSaidas) ? (json_decode((string) file_get_contents($arquivoSaidas), true) ?: []) : [];
        $saidas[preg_replace('/\D+/', '', (string) $dados['phone'])] = $quando;
        file_put_contents($arquivoSaidas, json_encode($saidas, JSON_PRETTY_PRINT), LOCK_EX);
    }
}
