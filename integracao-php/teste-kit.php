<?php
/**
 * Teste do kit contra um hub de verdade (rode no terminal: php teste-kit.php).
 * Usa oliver-hub-config.php. Só para testar: envia mensagens de exemplo.
 */
require_once __DIR__ . '/oliver-hub.php';

$falhas = 0;
function confere(string $nome, bool $ok, $detalhe = null): void
{
    global $falhas;
    if (!$ok) {
        $falhas++;
    }
    echo ($ok ? '  ok   ' : '  FALHOU ') . $nome . ($detalhe !== null ? ' — ' . (is_string($detalhe) ? $detalhe : json_encode($detalhe, JSON_UNESCAPED_UNICODE)) : '') . PHP_EOL;
}

$tel = getenv('TESTE_TELEFONE') ?: '63992142094';
$ref = 'teste-kit-' . date('YmdHis');

echo "Templates" . PHP_EOL;
$t = hub_templates();
confere('lista templates', $t['ok'] && is_array($t['dados']['templates'] ?? null), $t['erro']);

echo "Envio" . PHP_EOL;
$tpl = getenv('TESTE_TEMPLATE') ?: 'pedido_separando';
$r = hub_enviar_template($tel, $tpl, ['Gisele', '8814'], $ref);
confere("envia $tpl", $r['ok'] && ($r['dados']['status'] ?? '') === 'SENT', $r['erro'] ?? $r['dados']);
$r2 = hub_enviar_template($tel, $tpl, ['Gisele', '8814'], $ref);
confere('mesmo ref não envia de novo', $r2['ok'] && !empty($r2['dados']['duplicate']));
$r3 = hub_enviar_template('123', $tpl, []);
confere('telefone inválido volta com erro claro', !$r3['ok'] && strpos((string) $r3['erro'], 'telefone') !== false, $r3['erro']);

echo "Consentimento" . PHP_EOL;
$o = hub_opt_in($tel, 'teste-kit', 'Gisele');
confere('opt-in', $o['ok'], $o['erro'] ?? $o['dados']);
$s = hub_opt_outs();
confere('lista de opt-outs', $s['ok'] && is_array($s['dados']['optOuts'] ?? null), $s['erro']);

echo "Campanha do painel" . PHP_EOL;
$arte = __DIR__ . '/../apps/api/assets/logo-oliver.png';
$c = hub_campanha('Teste do kit', 'Chegaram as novidades da semana na Oliver, com preço especial.', 'varejo', [$tel, '11988887777'], $arte, $ref);
confere('cria rascunho', $c['ok'] && ($c['dados']['status'] ?? '') === 'DRAFT', $c['erro'] ?? null);
if ($c['ok']) {
    echo '         aprovar em: ' . $c['dados']['approvalUrl'] . ' (' . $c['dados']['audience']['eligible'] . ' podem receber)' . PHP_EOL;
}

echo "Carrinho" . PHP_EOL;
$k = hub_carrinho($ref, $tel, 'Gisele', [['name' => 'Lattafa Asad 100ml', 'qty' => 1]], 189.9, 'https://blackfridaydaoliver.com/carrinho/teste');
confere('registra carrinho', $k['ok'], $k['erro']);
$kc = hub_carrinho_convertido($ref);
confere('carrinho virou pedido', $kc['ok'] && ($kc['dados']['updated'] ?? 0) === 1, $kc['erro'] ?? $kc['dados']);

echo "Sem configuração" . PHP_EOL;
confere('link do WhatsApp comum (plano B)', hub_link_whatsapp_comum('(63) 99214-2094', 'Olá!') === 'https://wa.me/5563992142094?text=Ol%C3%A1%21');

echo PHP_EOL . ($falhas ? "$falhas falha(s)" : 'Tudo certo') . PHP_EOL;
exit($falhas ? 1 : 0);
