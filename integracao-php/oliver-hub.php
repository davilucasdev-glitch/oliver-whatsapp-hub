<?php
/**
 * Oliver WhatsApp Hub — biblioteca para o site/painel (PHP 7.4+ com cURL).
 *
 * Uso:
 *   require_once __DIR__ . '/oliver-hub.php';
 *   $r = hub_enviar_template('63992142094', 'pedido_separando', ['Gisele', '8814'], 'pedido-8814-separando');
 *   if ($r['ok']) { ... } else { echo $r['erro']; }
 *
 * Toda função devolve: ['ok' => bool, 'status' => código HTTP, 'dados' => resposta do hub, 'erro' => mensagem ou null]
 * Nunca lança exceção nem para a página: se o hub estiver fora, 'ok' vem false com o motivo.
 * Configuração (a primeira que existir):
 *   1) $CFG do site (bling.php carrega config.php + a pasta privada): 'hub_url', 'hub_token', 'hub_webhook_secret'
 *   2) oliver-hub-config.php ao lado deste arquivo (fora do Git, NÃO deixe acessível pela web).
 */

// aberto direto pelo navegador: não mostra nada
if (basename($_SERVER['SCRIPT_FILENAME'] ?? '') === basename(__FILE__)) {
    http_response_code(404);
    exit;
}

if (!defined('OLIVER_HUB_URL')) {
    if (isset($GLOBALS['CFG']) && is_array($GLOBALS['CFG']) && !empty($GLOBALS['CFG']['hub_url'])) {
        define('OLIVER_HUB_URL', (string) $GLOBALS['CFG']['hub_url']);
        define('OLIVER_HUB_TOKEN', (string) ($GLOBALS['CFG']['hub_token'] ?? ''));
        define('OLIVER_HUB_WEBHOOK_SECRET', (string) ($GLOBALS['CFG']['hub_webhook_secret'] ?? ''));
    } elseif (is_file(__DIR__ . '/oliver-hub-config.php')) {
        require_once __DIR__ . '/oliver-hub-config.php';
    }
}

/** O hub está configurado? (sem configuração, o site continua funcionando como antes) */
function hub_ligado(): bool
{
    return defined('OLIVER_HUB_URL') && defined('OLIVER_HUB_TOKEN') && OLIVER_HUB_URL !== '' && OLIVER_HUB_TOKEN !== '';
}

/**
 * Roda depois de a página responder (a cliente não espera o hub). Erros só vão para o log.
 * Ex.: hub_depois(fn() => hub_carrinho(...));
 */
function hub_depois(callable $fn): void
{
    if (!hub_ligado()) {
        return;
    }
    register_shutdown_function(function () use ($fn) {
        if (function_exists('fastcgi_finish_request')) {
            @fastcgi_finish_request();
        }
        try {
            $r = $fn();
            if (is_array($r) && empty($r['ok']) && !empty($r['erro'])) {
                error_log('[oliver-hub] ' . $r['erro']);
            }
        } catch (Throwable $e) {
            error_log('[oliver-hub] ' . $e->getMessage());
        }
    });
}

/** Chamada genérica à API do hub (/api/site/v1). */
function hub_request(string $metodo, string $caminho, $corpo = null, int $timeout = 20): array
{
    if (!defined('OLIVER_HUB_URL') || !defined('OLIVER_HUB_TOKEN') || OLIVER_HUB_URL === '' || OLIVER_HUB_TOKEN === '') {
        return ['ok' => false, 'status' => 0, 'dados' => null, 'erro' => 'Hub não configurado (oliver-hub-config.php).'];
    }
    $url = rtrim(OLIVER_HUB_URL, '/') . '/' . ltrim($caminho, '/');
    $ch = curl_init($url);
    $headers = ['Authorization: Bearer ' . OLIVER_HUB_TOKEN, 'Accept: application/json'];
    $opts = [
        CURLOPT_CUSTOMREQUEST => $metodo,
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT => $timeout,
        CURLOPT_CONNECTTIMEOUT => 8,
    ];
    if ($corpo !== null) {
        $json = json_encode($corpo, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
        $headers[] = 'Content-Type: application/json';
        $opts[CURLOPT_POSTFIELDS] = $json;
    }
    $opts[CURLOPT_HTTPHEADER] = $headers;
    curl_setopt_array($ch, $opts);
    $raw = curl_exec($ch);
    $status = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $erroRede = curl_error($ch);
    curl_close($ch);

    if ($raw === false) {
        return ['ok' => false, 'status' => 0, 'dados' => null, 'erro' => 'Sem resposta do hub: ' . $erroRede];
    }
    $dados = json_decode($raw, true);
    $ok = $status >= 200 && $status < 300;
    $erro = $ok ? null : (is_array($dados) && isset($dados['error']) ? $dados['error'] : "Hub respondeu HTTP $status");
    // envio que a Meta recusou vem com 422 e o motivo em dados.error
    if ($status === 422 && is_array($dados) && isset($dados['error'])) {
        $erro = $dados['error'];
    }
    return ['ok' => $ok, 'status' => $status, 'dados' => $dados, 'erro' => $erro];
}

/** Só os dígitos, com 55 na frente se faltar (o hub valida de novo). */
function hub_telefone(string $telefone): string
{
    $d = preg_replace('/\D+/', '', $telefone);
    if (strlen($d) === 10 || strlen($d) === 11) {
        $d = '55' . $d;
    }
    return $d;
}

/**
 * Envia um template aprovado (pedido, cobrança, extrato...).
 * $ref: um código seu (ex.: "pedido-8814-separando"); o mesmo ref nunca envia duas vezes.
 * $anexo: ['arquivo' => caminho local do PDF/imagem] ou ['url' => 'https://...'] (+ 'nome' opcional).
 */
function hub_enviar_template(string $telefone, string $template, array $variaveis = [], ?string $ref = null, ?array $anexo = null, ?string $nome = null): array
{
    $corpo = [
        'phone' => hub_telefone($telefone),
        'template' => $template,
        'variables' => array_map('strval', array_values($variaveis)),
    ];
    if ($ref !== null && $ref !== '') {
        $corpo['ref'] = $ref;
    }
    if ($nome) {
        $corpo['name'] = $nome;
    }
    if ($anexo) {
        if (!empty($anexo['arquivo'])) {
            if (!is_file($anexo['arquivo'])) {
                return ['ok' => false, 'status' => 0, 'dados' => null, 'erro' => 'Arquivo do anexo não encontrado: ' . $anexo['arquivo']];
            }
            $mime = function_exists('mime_content_type') ? mime_content_type($anexo['arquivo']) : 'application/pdf';
            $corpo['attachment'] = [
                'base64' => base64_encode(file_get_contents($anexo['arquivo'])),
                'mime' => $mime ?: 'application/pdf',
                'filename' => $anexo['nome'] ?? basename($anexo['arquivo']),
            ];
        } elseif (!empty($anexo['url'])) {
            $corpo['attachment'] = ['url' => $anexo['url'], 'filename' => $anexo['nome'] ?? null];
        }
    }
    return hub_request('POST', 'messages', $corpo, 60);
}

/** Registra o opt-in vindo do site (LGPD: de onde e quando). $origem ex.: "checkout", "cadastro". */
function hub_opt_in(string $telefone, string $origem, ?string $nome = null, ?string $quando = null): array
{
    $corpo = ['phone' => hub_telefone($telefone), 'source' => $origem];
    if ($nome) {
        $corpo['name'] = $nome;
    }
    if ($quando) {
        $corpo['at'] = $quando;
    }
    return hub_request('POST', 'opt-in', $corpo);
}

/** Lista de quem pediu para sair (para o site não mandar campanha). $desde: ISO 8601 opcional. */
function hub_opt_outs(?string $desde = null): array
{
    return hub_request('GET', 'opt-outs' . ($desde ? '?since=' . rawurlencode($desde) : ''));
}

/** Templates do hub (nome, status, variáveis, se pede anexo). */
function hub_templates(): array
{
    return hub_request('GET', 'templates');
}

/**
 * Manda a arte de post para o hub como campanha em RASCUNHO (só sai depois de um administrador aprovar no hub).
 * $segmento: 'varejo' | 'atacado' | 'todos'. $arte: caminho do JPG/PNG, URL https ou "data:image/png;base64,..." (canvas).
 * Devolve dados.approvalUrl (link para abrir a campanha no hub) e dados.audience (quantos podem receber).
 */
function hub_campanha(string $nome, string $texto, string $segmento, array $telefones, string $arte, ?string $ref = null): array
{
    $imagem = [];
    if (preg_match('#^data:(image/(?:png|jpeg));base64,(.+)$#s', $arte, $m)) {
        // arte gerada no navegador (canvas.toDataURL)
        $imagem = ['base64' => $m[2], 'mime' => $m[1]];
    } elseif (preg_match('#^https://#i', $arte)) {
        $imagem['url'] = $arte;
    } else {
        if (!is_file($arte)) {
            return ['ok' => false, 'status' => 0, 'dados' => null, 'erro' => 'Arte não encontrada: ' . $arte];
        }
        $mime = function_exists('mime_content_type') ? mime_content_type($arte) : 'image/jpeg';
        $imagem = ['base64' => base64_encode(file_get_contents($arte)), 'mime' => $mime === 'image/png' ? 'image/png' : 'image/jpeg'];
    }
    $corpo = [
        'name' => $nome,
        'text' => $texto,
        'segment' => $segmento,
        'phones' => array_values(array_map('hub_telefone', $telefones)),
        'image' => $imagem,
    ];
    if ($ref) {
        $corpo['ref'] = $ref;
    }
    return hub_request('POST', 'campaigns', $corpo, 90);
}

/** Carrinho parado. $itens: [['name' => 'Asad 100ml', 'qty' => 1], ...]. Chame de novo a cada mudança do carrinho. */
function hub_carrinho(string $ref, string $telefone, ?string $nome, array $itens, ?float $total, string $link): array
{
    return hub_request('POST', 'carts', [
        'ref' => $ref,
        'phone' => hub_telefone($telefone),
        'name' => $nome,
        'items' => array_values($itens),
        'total' => $total,
        'link' => $link,
    ]);
}

/** O carrinho virou pedido: sai da lista de "carrinho parado". */
function hub_carrinho_convertido(string $ref): array
{
    return hub_request('POST', 'carts/' . rawurlencode($ref) . '/recovered', new stdClass());
}

/** Baixa o arquivo de uma mensagem recebida (comprovante), pelo messageId do aviso message.received. */
function hub_midia(string $messageId): array
{
    if (!defined('OLIVER_HUB_URL') || !defined('OLIVER_HUB_TOKEN')) {
        return ['ok' => false, 'status' => 0, 'dados' => null, 'erro' => 'Hub não configurado.'];
    }
    $ch = curl_init(rtrim(OLIVER_HUB_URL, '/') . '/media/' . rawurlencode($messageId));
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT => 60,
        CURLOPT_HTTPHEADER => ['Authorization: Bearer ' . OLIVER_HUB_TOKEN],
    ]);
    $raw = curl_exec($ch);
    $status = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $tipo = (string) curl_getinfo($ch, CURLINFO_CONTENT_TYPE);
    curl_close($ch);
    $ok = $raw !== false && $status === 200;
    return ['ok' => $ok, 'status' => $status, 'dados' => $ok ? ['conteudo' => $raw, 'tipo' => $tipo] : null, 'erro' => $ok ? null : "Hub respondeu HTTP $status"];
}

/** Link de uma tela do painel do hub (ex.: 'cobranca', 'fornecedores', 'inbox'), ou null sem hub. */
function hub_painel_url(string $tela = ''): ?string
{
    if (!hub_ligado()) {
        return null;
    }
    $base = preg_replace('#/api/site/v1/?$#', '', rtrim(OLIVER_HUB_URL, '/'));
    return $base . '/' . ltrim($tela, '/');
}

/**
 * Plano B enquanto o hub não está no ar: link do WhatsApp comum (o que o painel usa hoje).
 * Ex.: if (!$r['ok']) { header('Location: ' . hub_link_whatsapp_comum($tel, $texto)); }
 */
function hub_link_whatsapp_comum(string $telefone, string $texto): string
{
    return 'https://wa.me/' . hub_telefone($telefone) . '?text=' . rawurlencode($texto);
}
