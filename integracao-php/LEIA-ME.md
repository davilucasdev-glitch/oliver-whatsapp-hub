# Kit PHP: ligar o painel/site da Oliver ao Oliver Hub

São três arquivos para colocar no site da Hostinger. Eles funcionam em PHP 7.4 ou mais novo, com cURL, que a Hostinger já tem.

| Arquivo | O que faz |
| --- | --- |
| `oliver-hub.php` | Funções que o painel chama: enviar template, opt-in, campanha, carrinho |
| `hub-webhook.php` | Recebe os avisos do hub (mensagem recebida, status, SAIR) e confere a assinatura |
| `oliver-hub-config.exemplo.php` | Modelo da configuração: endereço, chave e segredo |
| `.htaccess` | Bloqueia o acesso pela web a tudo menos o `hub-webhook.php` |
| `teste-kit.php` | Teste completo pelo terminal (não precisa subir) |

Testado em 18/11/2026 com PHP 8.3, contra o hub rodando neste computador:
- enviar template, sem reenviar o mesmo pedido;
- opt-in e lista de opt-out;
- campanha com arte em rascunho;
- carrinho registrado e carrinho que virou pedido;
- avisos chegando com a assinatura conferida, recusa de assinatura falsa (401) e recusa de GET (405).

## Instalação

> **No site da Oliver (blackfridaydaoliver.com)** o kit já está encaixado nas páginas: veja `T:\.122\painel-hostinger\para-subir\COMO-SUBIR.md`. Lá, a chave fica em `oliver-privado/config.php` (`hub_url`, `hub_token`, `hub_webhook_secret`), que o `bling.php` já carrega, e não no `oliver-hub-config.php`. Os passos abaixo são para outro site.

1. Na Hostinger (hPanel → Gerenciador de Arquivos), crie a pasta `public_html/oliver-hub/` e envie para ela `oliver-hub.php`, `hub-webhook.php` e `.htaccess`.
2. Copie `oliver-hub-config.exemplo.php` para `oliver-hub-config.php`, na mesma pasta, e preencha com os dados da tela **Integração com o site** do hub:
   - `OLIVER_HUB_URL`: o "Endereço da API" (ex.: `https://SEU-HUB/api/site/v1`);
   - `OLIVER_HUB_TOKEN`: clique em **Gerar chave**. Ela aparece uma vez só;
   - `OLIVER_HUB_WEBHOOK_SECRET`: em "Avisos para o site", ponha a URL `https://blackfridaydaoliver.com/oliver-hub/hub-webhook.php` e salve. O segredo aparece uma vez.
3. No hub, clique em **Testar** em "Avisos para o site". A entrega deve aparecer como OK.
4. Nas páginas do painel que vão usar o hub, inclua a biblioteca:

```php
require_once __DIR__ . '/oliver-hub/oliver-hub.php';
```

## O que NÃO precisa sair do painel

O hub já faz estas mensagens sozinho, lendo o Bling. Se o painel mandar também, a cliente recebe duas vezes:

- **Avisos de pedido**: recebido, separando, pronto para retirar, enviado com rastreio, entregue e cancelado. Saem quando a situação muda no Kanban ou na rotina da Duda.
- **Cobrança**: lembrete, vence hoje, atraso e pagamento recebido. A equipe envia na tela Cobrança do hub.
- **Avisos para a equipe**: pedido novo para separar, pedidos parados e resumo do dia.

Os botões do painel que hoje abrem o WhatsApp comum para esses casos podem ser **tirados** ou passar a abrir a tela do hub.

## O que liga no painel

### Arte de post → campanha (mais vendidos, novidades, Black Friday)

Na tela da arte de post, depois de gerar a imagem e a lista com o filtro de varejo ou atacado:

```php
$r = hub_campanha(
    'Chegou: novidades da semana',          // nome
    $textoDaArte,                            // até 700 caracteres, vai depois do "Oi, {nome}!"
    $filtro === 'atacado' ? 'atacado' : 'varejo',
    $telefonesDaLista,                       // telefones das clientes do filtro
    $caminhoDoJpgGerado,                     // ou uma URL https da imagem
    'arte-' . date('Y-m-d-His')              // ref: clicar duas vezes não cria duas campanhas
);
if ($r['ok']) {
    // abre a campanha no hub para a Oliver aprovar a arte e o público
    header('Location: ' . $r['dados']['approvalUrl']);
} else {
    echo 'Não foi para o hub: ' . htmlspecialchars($r['erro']);
}
```

A campanha chega em **rascunho**, e só um administrador inicia no hub. Opt-in, opt-out e frequência são conferidos no hub.

### Cotação e pedido de compra (compras.php, compra urgente)

Hoje o painel abre o WhatsApp comum com o PDF. Pelo hub, o PDF já vai anexado:

```php
$r = hub_enviar_template($celularFornecedor, 'compra_cotacao', ['Beauty Mania'], 'cotacao-' . $idCotacao, ['arquivo' => $caminhoDoPdf, 'nome' => 'Cotação Oliver.pdf']);
```

O pedido de compra lançado no Bling também pode ser enviado pela tela **Fornecedores** do hub, que gera o PDF com a logo.

### Extrato do crediário (PDF)

Isso precisa de um template com PDF no cabeçalho, por exemplo `extrato_crediario` (nome e saldo), criado e aprovado na Meta. Depois:

```php
$r = hub_enviar_template($telefone, 'extrato_crediario', [$primeiroNome, $saldoFormatado], 'extrato-' . $idCliente . '-' . date('Ymd'), ['arquivo' => $pdfDoExtrato]);
```

### Opt-in no site (checkout, cadastro)

Quando a cliente marcar "quero receber novidades pelo WhatsApp":

```php
hub_opt_in($telefone, 'checkout', $nome);   // o hub guarda quando e de onde (LGPD)
```

### Carrinho parado

Só funciona se o site guardar o telefone **antes** de fechar a compra (pergunta em aberto do documento):

```php
hub_carrinho('cart-' . $idCarrinho, $telefone, $nome, [['name' => 'Asad 100ml', 'qty' => 1]], 189.90, $linkDoCarrinho);
// quando virar pedido:
hub_carrinho_convertido('cart-' . $idCarrinho);
```

### Avisos que chegam (`hub-webhook.php`)

Por padrão, os avisos ficam gravados em `oliver-hub/hub-dados/`, uma pasta protegida pelo `.htaccess`:
- `opt-outs.json`: telefones que mandaram SAIR. O painel pode conferir antes de qualquer envio próprio;
- `eventos.json`: os últimos 500 avisos.

Para gravar no banco do site, crie a função `oliver_hub_evento($evento, $dados)` no `oliver-hub-config.php`. O modelo está no exemplo.

## Se o hub estiver fora do ar

Nenhuma função derruba a página: todas devolvem `['ok' => false, 'erro' => '...']`. Para não parar a operação, dá para cair no WhatsApp comum:

```php
if (!$r['ok']) { header('Location: ' . hub_link_whatsapp_comum($telefone, $texto)); exit; }
```

## Testar pelo terminal

```bash
php teste-kit.php
```

Para isso, o `oliver-hub-config.php` precisa estar preenchido. Use `TESTE_TELEFONE` e `TESTE_TEMPLATE` para escolher o destino e o template. O teste **envia mensagens de verdade**, então use o seu número.
