<?php
/**
 * Copie para oliver-hub-config.php e preencha. NÃO suba este arquivo para o Git.
 * Na Hostinger, o ideal é deixá-lo FORA de public_html (e trocar o require em oliver-hub.php)
 * ou protegido pelo .htaccess desta pasta.
 */

// Endereço da API do hub (Integração com o site → "Endereço da API")
define('OLIVER_HUB_URL', 'https://SEU-HUB/api/site/v1');

// Chave do site (Integração com o site → Gerar chave). Mostrada uma vez só.
define('OLIVER_HUB_TOKEN', '');

// Segredo da assinatura dos avisos (aparece ao salvar a URL em "Avisos para o site").
define('OLIVER_HUB_WEBHOOK_SECRET', '');

// Opcional: pasta onde hub-webhook.php guarda opt-outs e eventos (padrão: hub-dados/ ao lado).
// define('OLIVER_HUB_DADOS_DIR', __DIR__ . '/../hub-dados');

/*
// Opcional: trate os avisos do seu jeito (ex.: gravar no banco do site).
function oliver_hub_evento(string $evento, array $dados): void
{
    if ($evento === 'contact.opt_out') {
        // marcar $dados['phone'] como "não quer campanha" no banco do site
    }
    if ($evento === 'message.received' && !empty($dados['hasMedia'])) {
        // comprovante: $arquivo = hub_midia($dados['messageId']);
    }
}
*/
